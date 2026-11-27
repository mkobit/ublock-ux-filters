import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANARY_RULE, verifyCanary } from "./canary.ts";
import type { CanaryDriver } from "./canary.ts";
import type { CaptureDriver } from "./capture.ts";
import { defaultBuildFilters, loadPreviewConfig } from "./config.ts";
import { prepareSession } from "./session.ts";
import type { BrowserSession, PrepareSessionOptions } from "./session.ts";
import { ensureToolchain } from "./toolchain.ts";
import type { ToolchainPaths } from "./toolchain.ts";
import {
  WAIT_FOR_TIMEOUT_MS,
  WebDriverClient,
  classifyNavigationFailure,
} from "./webdriver.ts";
import type { WebDriverLaunchOptions } from "./webdriver.ts";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));
export const DEFAULT_DEMO_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DEMO_FORMAT = "png";
const DEMO_SCROLL_STEPS = 4;
const DEMO_SETTLE_DELAY_MS = 150;

export type DemoFormat = "png" | "webp";

export interface DemoCliArgs {
  command: "demo";
  host: string;
  variant?: string;
  label?: string;
  format: DemoFormat;
  scrollY: number;
  hover?: string;
  maxBytes: number;
  keepProfile: boolean;
}

export interface DemoDriver extends CaptureDriver {
  hoverSelector?: (selector: string) => Promise<void>;
}

export interface DemoDependencies {
  rootDir?: string;
  buildFilters?: (rootDir: string) => Promise<void>;
  ensureToolchain?: () => Promise<ToolchainPaths>;
  prepareSession?: (options: PrepareSessionOptions) => BrowserSession;
  launchWebDriver?: (options: WebDriverLaunchOptions) => Promise<DemoDriver>;
  verifyCanary?: (driver: CanaryDriver) => Promise<{ canaryMs: number; observedColor: string | null }>;
  checkFfmpeg?: () => Promise<boolean>;
  encodeWebp?: (framesDir: string, outputPath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DemoResult {
  host: string;
  variant: string;
  label: string;
  format: DemoFormat;
  outputPath: string;
  bytes: number;
}

async function defaultCheckFfmpeg(): Promise<boolean> {
  return Bun.which("ffmpeg") !== null;
}

async function defaultEncodeWebp(framesDir: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-framerate",
      "4",
      "-i",
      join(framesDir, "frame-%03d.png"),
      "-vcodec",
      "libwebp",
      "-lossless",
      "0",
      "-compression_level",
      "4",
      "-q:v",
      "80",
      "-loop",
      "0",
      outputPath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
}

async function captureWebpFrames(
  driver: DemoDriver,
  framesDir: string,
  parsedArgs: DemoCliArgs,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let frameIndex = 0;
  const writeFrame = async (): Promise<void> => {
    const png = await driver.takeScreenshot();
    const frameName = `frame-${String(frameIndex).padStart(3, "0")}.png`;
    writeFileSync(join(framesDir, frameName), png);
    frameIndex += 1;
  };

  await writeFrame();

  if (parsedArgs.scrollY > 0) {
    for (let step = 1; step <= DEMO_SCROLL_STEPS; step += 1) {
      const targetY = Math.round((parsedArgs.scrollY * step) / DEMO_SCROLL_STEPS);
      await driver.executeScript("window.scrollTo(0, arguments[0]);", [targetY]);
      await sleep(DEMO_SETTLE_DELAY_MS);
      await writeFrame();
    }
  }

  if (parsedArgs.hover !== undefined) {
    if (!driver.hoverSelector) {
      throw new Error("Driver does not support hoverSelector");
    }
    await driver.waitForSelector(parsedArgs.hover, WAIT_FOR_TIMEOUT_MS);
    await driver.hoverSelector(parsedArgs.hover);
    await sleep(DEMO_SETTLE_DELAY_MS);
    await writeFrame();
    await sleep(DEMO_SETTLE_DELAY_MS);
    await writeFrame();
  }

  if (parsedArgs.scrollY === 0 && parsedArgs.hover === undefined) {
    await sleep(DEMO_SETTLE_DELAY_MS);
    await writeFrame();
  }
}

export async function runDemo(
  parsedArgs: DemoCliArgs,
  deps: DemoDependencies = {},
): Promise<DemoResult> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR;
  const buildFilters = deps.buildFilters ?? defaultBuildFilters;
  const getToolchain = deps.ensureToolchain ?? (() => ensureToolchain());
  const createSession = deps.prepareSession ?? prepareSession;
  const launchDriver = deps.launchWebDriver ?? ((launchOpts) => WebDriverClient.launch(launchOpts));
  const runCanary = deps.verifyCanary ?? ((driver) => verifyCanary(driver));
  const checkFfmpeg = deps.checkFfmpeg ?? defaultCheckFfmpeg;
  const encodeWebp = deps.encodeWebp ?? defaultEncodeWebp;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  if (parsedArgs.format === "webp") {
    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      throw new Error(
        "ffmpeg is required for --format webp but was not found in PATH. Install ffmpeg (for example, 'sudo apt install ffmpeg' or 'brew install ffmpeg') or use --format png.",
      );
    }
  }

  const config = loadPreviewConfig(rootDir, parsedArgs.host, parsedArgs.variant);
  const target =
    parsedArgs.label !== undefined
      ? config.targets.find((item) => item.label === parsedArgs.label)
      : config.targets[0];

  if (!target) {
    const availableLabels = config.targets.map((item) => item.label).join(", ");
    throw new Error(
      `Target label '${parsedArgs.label}' not found for host '${config.host}'. Available labels: ${availableLabels}`,
    );
  }

  await buildFilters(rootDir);

  const filterFilePath = join(
    rootDir,
    "dist",
    "raw",
    config.host,
    `${config.variant}.txt`,
  );
  if (!existsSync(filterFilePath)) {
    throw new Error(
      `Compiled filter not found at ${filterFilePath} after build`,
    );
  }
  const filterText = readFileSync(filterFilePath, "utf8");

  const toolchain = await getToolchain();
  const session = createSession({
    firefoxDir: toolchain.firefoxDir,
    uboXpiPath: toolchain.uboXpiPath,
    mode: "filtered",
    userFilters: `${CANARY_RULE}\n${filterText}`,
    keepProfile: parsedArgs.keepProfile,
  });

  let driver: DemoDriver | undefined;
  try {
    driver = await launchDriver({
      geckodriverBin: toolchain.geckodriverBin,
      session,
      headless: true,
    });

    await runCanary(driver);
    await driver.navigate(target.url);

    const [httpStatus, title, bodyText] = await Promise.all([
      driver.getHttpStatus().catch(() => null),
      driver.getTitle().catch(() => ""),
      driver
        .executeScript<string>("return document.body?.innerText?.slice(0, 4000) ?? '';")
        .catch(() => ""),
    ]);

    const failure = classifyNavigationFailure({ httpStatus, title, bodyText });
    if (failure !== null) {
      throw new Error(failure.message);
    }

    if (target.wait_for !== undefined) {
      await driver.waitForSelector(target.wait_for, WAIT_FOR_TIMEOUT_MS);
    }

    const assetsDir = join(rootDir, "filters", config.host, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const outputPath = join(
      assetsDir,
      `${config.variant}-${target.label}.${parsedArgs.format}`,
    );

    if (parsedArgs.format === "png") {
      if (parsedArgs.scrollY > 0) {
        await driver.executeScript("window.scrollTo(0, arguments[0]);", [parsedArgs.scrollY]);
        await sleep(DEMO_SETTLE_DELAY_MS);
      }
      if (parsedArgs.hover !== undefined) {
        if (!driver.hoverSelector) {
          throw new Error("Driver does not support hoverSelector");
        }
        await driver.waitForSelector(parsedArgs.hover, WAIT_FOR_TIMEOUT_MS);
        await driver.hoverSelector(parsedArgs.hover);
        await sleep(DEMO_SETTLE_DELAY_MS);
      }
      const png = await driver.takeScreenshot();
      writeFileSync(outputPath, png);
    } else {
      const framesDir = mkdtempSync(join(tmpdir(), "ubouf-demo-frames-"));
      try {
        await captureWebpFrames(driver, framesDir, parsedArgs, sleep);
        await encodeWebp(framesDir, outputPath);
      } finally {
        rmSync(framesDir, { recursive: true, force: true });
      }
    }

    const bytes = statSync(outputPath).size;
    if (bytes > parsedArgs.maxBytes) {
      rmSync(outputPath, { force: true });
      throw new Error(
        `Demo output ${outputPath} (${bytes} bytes) exceeds --max-bytes limit (${parsedArgs.maxBytes} bytes)`,
      );
    }

    return {
      host: config.host,
      variant: config.variant,
      label: target.label,
      format: parsedArgs.format,
      outputPath,
      bytes,
    };
  } finally {
    if (driver) {
      await driver.close();
    }
    session.cleanup();
  }
}
