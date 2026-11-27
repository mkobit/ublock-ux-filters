import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyCanary } from "./canary.ts";
import type { CanaryDriver } from "./canary.ts";
import type { BrowserSession, PrepareSessionOptions } from "./session.ts";
import { prepareSession } from "./session.ts";
import type { ToolchainPaths } from "./toolchain.ts";
import {
  CaptureFailureError,
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  WAIT_FOR_TIMEOUT_MS,
  WebDriverClient,
  classifyNavigationFailure,
} from "./webdriver.ts";
import type { CaptureError, WebDriverLaunchOptions } from "./webdriver.ts";

export type CapturePass = "raw" | "base" | "pr";

export interface CaptureDriver extends CanaryDriver {
  getCurrentUrl: () => Promise<string>;
  getTitle: () => Promise<string>;
  getHttpStatus: () => Promise<number | null>;
  executeScript: <T>(script: string, args?: unknown[]) => Promise<T>;
  waitForSelector: (selector: string, timeoutMs?: number) => Promise<void>;
  takeScreenshot: () => Promise<Uint8Array>;
  close: () => Promise<void>;
}

export interface CaptureTargetSpec {
  host: string;
  variant: string;
  label: string;
  url: string;
  waitFor?: string;
}

export type PassOutcome =
  | { ok: true; relativePath: string }
  | { ok: false; error: CaptureError };

export interface ExecutePassOptions {
  pass: CapturePass;
  targets: CaptureTargetSpec[];
  outDir: string;
  toolchain: ToolchainPaths;
  userFilters?: string;
  keepProfile?: boolean;
}

export interface CaptureRunnerDependencies {
  prepareSession?: (options: PrepareSessionOptions) => BrowserSession;
  launchWebDriver?: (options: WebDriverLaunchOptions) => Promise<CaptureDriver>;
  verifyCanary?: (driver: CanaryDriver) => Promise<{ canaryMs: number; observedColor: string | null }>;
  sleep?: (ms: number) => Promise<void>;
}

export function targetKey(target: Pick<CaptureTargetSpec, "host" | "variant" | "label">): string {
  return `${target.host}::${target.variant}::${target.label}`;
}

function isTimeoutMessage(message: string): boolean {
  return /timed?\s*out|timeout/i.test(message);
}

async function tryCaptureFailureScreenshot(
  driver: CaptureDriver,
  outDir: string,
  target: CaptureTargetSpec,
  pass: CapturePass,
): Promise<string | undefined> {
  try {
    const png = await driver.takeScreenshot();
    const relPath = `${target.host}/${target.variant}/${target.label}/failure-${pass}.png`;
    const absPath = join(outDir, relPath);
    mkdirSync(join(outDir, target.host, target.variant, target.label), { recursive: true });
    writeFileSync(absPath, png);
    return relPath;
  } catch {
    return undefined;
  }
}

async function captureTargetWithRetries(
  driver: CaptureDriver,
  target: CaptureTargetSpec,
  pass: CapturePass,
  outDir: string,
  canaryMs: number | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<PassOutcome> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const navStart = Date.now();
    let navigateMs = 0;
    let waitMs: number | undefined;
    let finalUrl = target.url;
    let httpStatus: number | null = null;
    let failure: { kind: CaptureError["kind"]; message: string } | null = null;

    try {
      await driver.navigate(target.url);
      navigateMs = Date.now() - navStart;

      try {
        finalUrl = await driver.getCurrentUrl();
      } catch {
        // Keep requested URL if current URL query fails.
      }
      try {
        httpStatus = await driver.getHttpStatus();
      } catch {
        httpStatus = null;
      }

      const [title, bodyText] = await Promise.all([
        driver.getTitle().catch(() => ""),
        driver
          .executeScript<string>("return document.body?.innerText?.slice(0, 4000) ?? '';")
          .catch(() => ""),
      ]);

      failure = classifyNavigationFailure({ httpStatus, title, bodyText });

      if (failure === null && target.waitFor !== undefined) {
        const waitStart = Date.now();
        try {
          await driver.waitForSelector(target.waitFor, WAIT_FOR_TIMEOUT_MS);
          waitMs = Date.now() - waitStart;
        } catch (error) {
          waitMs = Date.now() - waitStart;
          const message = error instanceof Error ? error.message : String(error);
          failure = classifyNavigationFailure({
            httpStatus,
            timedOutPhase: "selector",
            message,
          });
        }
      }

      if (failure === null) {
        const png = await driver.takeScreenshot();
        const relPath = `${target.host}/${target.variant}/${target.label}/${pass}.png`;
        const targetDir = join(outDir, target.host, target.variant, target.label);
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(outDir, relPath), png);
        return { ok: true, relativePath: relPath };
      }
    } catch (error) {
      navigateMs = Date.now() - navStart;
      const message = error instanceof Error ? error.message : String(error);
      failure = classifyNavigationFailure({
        httpStatus,
        timedOutPhase: isTimeoutMessage(message) ? "navigation" : "navigation",
        message,
      });
    }

    if (attempt < MAX_RETRIES) {
      const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 3000;
      await sleep(backoff);
      continue;
    }

    const failureScreenshotPath = await tryCaptureFailureScreenshot(driver, outDir, target, pass);
    const resolvedFailure = failure ?? {
      kind: "NAVIGATION_TIMEOUT" as const,
      message: "Navigation failed",
    };

    const captureError: CaptureError = {
      kind: resolvedFailure.kind,
      message: resolvedFailure.message,
      finalUrl,
      httpStatus,
      retryCount: attempt,
      phaseTimingsMs: {
        navigateMs,
        ...(canaryMs !== undefined ? { canaryMs } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
      },
      ...(failureScreenshotPath !== undefined ? { failureScreenshotPath } : {}),
    };

    return { ok: false, error: captureError };
  }

  throw new Error("Unreachable retry loop termination");
}

export async function executePassForTargets(
  options: ExecutePassOptions,
  deps: CaptureRunnerDependencies = {},
): Promise<Map<string, PassOutcome>> {
  const outcomes = new Map<string, PassOutcome>();
  if (options.targets.length === 0) {
    return outcomes;
  }

  const createSession = deps.prepareSession ?? prepareSession;
  const launchDriver = deps.launchWebDriver ?? ((launchOpts) => WebDriverClient.launch(launchOpts));
  const runCanary = deps.verifyCanary ?? ((driver) => verifyCanary(driver));
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  const session = createSession({
    firefoxDir: options.toolchain.firefoxDir,
    mode: options.pass === "raw" ? "raw" : "filtered",
    ...(options.pass !== "raw" ? { uboXpiPath: options.toolchain.uboXpiPath } : {}),
    ...(options.userFilters !== undefined ? { userFilters: options.userFilters } : {}),
    ...(options.keepProfile !== undefined ? { keepProfile: options.keepProfile } : {}),
  });

  let driver: CaptureDriver | undefined;
  try {
    driver = await launchDriver({
      geckodriverBin: options.toolchain.geckodriverBin,
      session,
      headless: true,
    });

    let canaryMs: number | undefined;
    if (options.pass !== "raw") {
      try {
        const canaryResult = await runCanary(driver);
        canaryMs = canaryResult.canaryMs;
      } catch (error) {
        const captureError: CaptureError =
          error instanceof CaptureFailureError
            ? error.captureError
            : {
                kind: "UBO_LOAD_ERROR",
                message: error instanceof Error ? error.message : String(error),
                finalUrl: "http://127.0.0.1/canary",
                httpStatus: null,
                retryCount: 0,
                phaseTimingsMs: { navigateMs: 0 },
              };
        for (const target of options.targets) {
          outcomes.set(targetKey(target), { ok: false, error: captureError });
        }
        return outcomes;
      }
    }

    for (const target of options.targets) {
      const outcome = await captureTargetWithRetries(
        driver,
        target,
        options.pass,
        options.outDir,
        canaryMs,
        sleep,
      );
      outcomes.set(targetKey(target), outcome);
    }

    return outcomes;
  } finally {
    if (driver) {
      await driver.close();
    }
    session.cleanup();
  }
}
