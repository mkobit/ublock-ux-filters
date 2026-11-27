import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostMeta } from "@ubdf/schema";
import type { HostMeta, PreviewTargetMeta } from "@ubdf/schema";
import { CANARY_RULE } from "./canary.ts";
import { executePassForTargets, targetKey } from "./capture.ts";
import type { CaptureRunnerDependencies, CaptureTargetSpec, PassOutcome } from "./capture.ts";
import { selectCapturePlan } from "./diff-select.ts";
import type { DiffSelectDependencies, PlannedCaptureTarget } from "./diff-select.ts";
import { appendStepSummary, formatStepSummaryMarkdown, writeVisualReport } from "./report.ts";
import type { TargetResult, VisualReport } from "./report.ts";
import { prepareSession } from "./session.ts";
import type { BrowserSession, PrepareSessionOptions } from "./session.ts";
import { ensureToolchain } from "./toolchain.ts";
import type { ToolchainPaths } from "./toolchain.ts";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const PREVIEW_USAGE =
  "Usage: preview --host <host> [--variant <variant>] [--keep-profile]";
const CAPTURE_USAGE =
  "Usage: capture [--host <host>] [--variant <variant>] [--base-ref <sha>] [--ci] [--keep-profile]";
const CLI_USAGE = `${PREVIEW_USAGE} | ${CAPTURE_USAGE}`;

export interface PreviewCliArgs {
  command: "preview";
  host: string;
  variant?: string;
  keepProfile: boolean;
}

export interface PreviewConfig {
  host: string;
  variant: string;
  targets: PreviewTargetMeta[];
}

export interface SpawnedBrowserProcess {
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}

export interface PreviewDependencies {
  rootDir?: string;
  buildFilters?: (rootDir: string) => Promise<void>;
  ensureToolchain?: () => Promise<ToolchainPaths>;
  prepareSession?: (options: PrepareSessionOptions) => BrowserSession;
  spawnFirefox?: (
    firefoxBin: string,
    args: string[],
    env: Record<string, string>,
  ) => SpawnedBrowserProcess;
}

export interface CaptureCliArgs {
  command: "capture";
  host?: string;
  variant?: string;
  baseRef?: string;
  ci: boolean;
  keepProfile: boolean;
}

export interface CaptureDependencies extends DiffSelectDependencies, CaptureRunnerDependencies {
  rootDir?: string;
  outDir?: string;
  ensureToolchain?: () => Promise<ToolchainPaths>;
  stepSummaryPath?: string;
  now?: () => Date;
}

export function parsePreviewArgs(args: string[]): PreviewCliArgs {
  const [command, ...rest] = args;
  if (command !== "preview") {
    throw new Error(PREVIEW_USAGE);
  }

  let host: string | undefined;
  let variant: string | undefined;
  let keepProfile = false;

  for (let index = 0; index < rest.length; ) {
    const token = rest[index];
    if (token === undefined) {
      break;
    }

    if (token === "--keep-profile") {
      if (keepProfile) {
        throw new Error(PREVIEW_USAGE);
      }
      keepProfile = true;
      index += 1;
      continue;
    }

    if (token === "--host" || token === "--variant") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(PREVIEW_USAGE);
      }
      if (token === "--host") {
        if (host !== undefined) {
          throw new Error(PREVIEW_USAGE);
        }
        host = value;
      } else {
        if (variant !== undefined) {
          throw new Error(PREVIEW_USAGE);
        }
        variant = value;
      }
      index += 2;
      continue;
    }

    throw new Error(PREVIEW_USAGE);
  }

  if (host === undefined) {
    throw new Error(PREVIEW_USAGE);
  }

  return {
    command: "preview",
    host,
    keepProfile,
    ...(variant !== undefined ? { variant } : {}),
  };
}

export function parseCaptureArgs(args: string[]): CaptureCliArgs {
  const [command, ...rest] = args;
  if (command !== "capture") {
    throw new Error(CAPTURE_USAGE);
  }

  let host: string | undefined;
  let variant: string | undefined;
  let baseRef: string | undefined;
  let ci = false;
  let keepProfile = false;

  for (let index = 0; index < rest.length; ) {
    const token = rest[index];
    if (token === undefined) {
      break;
    }

    if (token === "--ci") {
      if (ci) {
        throw new Error(CAPTURE_USAGE);
      }
      ci = true;
      index += 1;
      continue;
    }

    if (token === "--keep-profile") {
      if (keepProfile) {
        throw new Error(CAPTURE_USAGE);
      }
      keepProfile = true;
      index += 1;
      continue;
    }

    if (token === "--host" || token === "--variant" || token === "--base-ref") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(CAPTURE_USAGE);
      }
      if (token === "--host") {
        if (host !== undefined) {
          throw new Error(CAPTURE_USAGE);
        }
        host = value;
      } else if (token === "--variant") {
        if (variant !== undefined) {
          throw new Error(CAPTURE_USAGE);
        }
        variant = value;
      } else {
        if (baseRef !== undefined) {
          throw new Error(CAPTURE_USAGE);
        }
        baseRef = value;
      }
      index += 2;
      continue;
    }

    throw new Error(CAPTURE_USAGE);
  }

  if (variant !== undefined && host === undefined) {
    throw new Error(CAPTURE_USAGE);
  }

  return {
    command: "capture",
    ci,
    keepProfile,
    ...(host !== undefined ? { host } : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(baseRef !== undefined ? { baseRef } : {}),
  };
}

export function resolveVariantName(
  hostMeta: HostMeta,
  requestedVariant?: string,
): string {
  const available = Object.keys(hostMeta.variants);
  if (requestedVariant !== undefined) {
    if (!Object.hasOwn(hostMeta.variants, requestedVariant)) {
      throw new Error(
        `Unknown variant '${requestedVariant}' for host '${hostMeta.host}'. Available variants: ${available.join(", ")}`,
      );
    }
    return requestedVariant;
  }

  if (hostMeta.default_variant !== undefined) {
    return hostMeta.default_variant;
  }

  if (available.length === 1 && available[0] !== undefined) {
    return available[0];
  }

  throw new Error(
    `Host '${hostMeta.host}' has multiple variants (${available.join(", ")}) and no default_variant; pass --variant <variant>`,
  );
}

export function loadPreviewConfig(
  rootDir: string,
  host: string,
  requestedVariant?: string,
): PreviewConfig {
  const filterTomlPath = join(rootDir, "filters", host, "filter.toml");
  if (!existsSync(filterTomlPath)) {
    throw new Error(
      `Host descriptor not found for '${host}' at ${filterTomlPath}`,
    );
  }

  const parsedToml = Bun.TOML.parse(readFileSync(filterTomlPath, "utf8"));
  const hostMeta = parseHostMeta(parsedToml, host);
  const variant = resolveVariantName(hostMeta, requestedVariant);

  if (!hostMeta.preview || hostMeta.preview.targets.length === 0) {
    throw new Error(
      `Host '${host}' does not declare [preview] targets in ${filterTomlPath}`,
    );
  }

  return {
    host,
    variant,
    targets: hostMeta.preview.targets,
  };
}

async function defaultBuildFilters(rootDir: string): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "packages/builder/src/index.ts", "build"],
    {
      cwd: rootDir,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Filter build failed with exit code ${exitCode}`);
  }
}

function defaultSpawnFirefox(
  firefoxBin: string,
  args: string[],
  env: Record<string, string>,
): SpawnedBrowserProcess {
  return Bun.spawn([firefoxBin, ...args], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
}

export async function runPreview(
  parsedArgs: PreviewCliArgs,
  deps: PreviewDependencies = {},
): Promise<void> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR;
  const buildFilters = deps.buildFilters ?? defaultBuildFilters;
  const getToolchain = deps.ensureToolchain ?? (() => ensureToolchain());
  const createSession = deps.prepareSession ?? prepareSession;
  const launchFirefox = deps.spawnFirefox ?? defaultSpawnFirefox;

  const config = loadPreviewConfig(rootDir, parsedArgs.host, parsedArgs.variant);

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
  const userFilters = readFileSync(filterFilePath, "utf8");

  const toolchain = await getToolchain();
  const session = createSession({
    firefoxDir: toolchain.firefoxDir,
    uboXpiPath: toolchain.uboXpiPath,
    mode: "filtered",
    userFilters,
    keepProfile: parsedArgs.keepProfile,
  });

  try {
    const targetUrls = config.targets.map((target) => target.url);
    const proc = launchFirefox(
      session.firefoxBin,
      ["--no-remote", "-profile", session.profileDir, ...targetUrls],
      session.env,
    );
    session.trackChild(proc);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Firefox exited with code ${exitCode}`);
    }
  } finally {
    session.cleanup();
  }
}

type CaptureTarget = Extract<PlannedCaptureTarget, { kind: "capture" }>;

function toSpec(target: CaptureTarget): CaptureTargetSpec {
  return {
    host: target.host,
    variant: target.variant,
    label: target.label,
    url: target.url,
    ...(target.waitFor !== undefined ? { waitFor: target.waitFor } : {}),
  };
}

function groupByVariant(targets: CaptureTarget[]): Map<string, CaptureTarget[]> {
  const grouped = new Map<string, CaptureTarget[]>();
  for (const target of targets) {
    const key = `${target.host}::${target.variant}`;
    let list = grouped.get(key);
    if (!list) {
      list = [];
      grouped.set(key, list);
    }
    list.push(target);
  }
  return grouped;
}

export async function runCapture(
  parsedArgs: CaptureCliArgs,
  deps: CaptureDependencies = {},
): Promise<VisualReport> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR;
  const outDir = deps.outDir ?? join(rootDir, ".artifacts", "visual");
  const getToolchain = deps.ensureToolchain ?? (() => ensureToolchain());
  const now = deps.now ?? (() => new Date());

  const plan = await selectCapturePlan(
    {
      rootDir,
      ci: parsedArgs.ci,
      ...(parsedArgs.host !== undefined ? { host: parsedArgs.host } : {}),
      ...(parsedArgs.variant !== undefined ? { variant: parsedArgs.variant } : {}),
      ...(parsedArgs.baseRef !== undefined ? { baseRef: parsedArgs.baseRef } : {}),
    },
    deps,
  );

  try {
    const captureTargets = plan.targets.filter(
      (target): target is CaptureTarget => target.kind === "capture",
    );

    const rawOutcomes = new Map<string, PassOutcome>();
    const baseOutcomes = new Map<string, PassOutcome>();
    const prOutcomes = new Map<string, PassOutcome>();

    if (captureTargets.length > 0) {
      const toolchain = await getToolchain();
      const rawResults = await executePassForTargets(
        {
          pass: "raw",
          targets: captureTargets.map(toSpec),
          outDir,
          toolchain,
          keepProfile: parsedArgs.keepProfile,
        },
        deps,
      );
      for (const [k, v] of rawResults) {
        rawOutcomes.set(k, v);
      }

      const threeWayTargets = captureTargets.filter(
        (target) => target.panelsMode === "3-way" && target.baseFilterPath !== undefined,
      );
      for (const [, group] of groupByVariant(threeWayTargets)) {
        const first = group[0];
        if (!first?.baseFilterPath) {
          continue;
        }
        const baseFilterText = readFileSync(first.baseFilterPath, "utf8");
        const groupResults = await executePassForTargets(
          {
            pass: "base",
            targets: group.map(toSpec),
            outDir,
            toolchain,
            userFilters: `${CANARY_RULE}\n${baseFilterText}`,
            keepProfile: parsedArgs.keepProfile,
          },
          deps,
        );
        for (const [k, v] of groupResults) {
          baseOutcomes.set(k, v);
        }
      }

      for (const [, group] of groupByVariant(captureTargets)) {
        const first = group[0];
        if (!first) {
          continue;
        }
        const prFilterText = readFileSync(first.prFilterPath, "utf8");
        const groupResults = await executePassForTargets(
          {
            pass: "pr",
            targets: group.map(toSpec),
            outDir,
            toolchain,
            userFilters: `${CANARY_RULE}\n${prFilterText}`,
            keepProfile: parsedArgs.keepProfile,
          },
          deps,
        );
        for (const [k, v] of groupResults) {
          prOutcomes.set(k, v);
        }
      }
    }

    const results: TargetResult[] = plan.targets.map((planned) => {
      if (planned.kind === "skipped_by_config") {
        return {
          host: planned.host,
          variant: planned.variant,
          label: planned.label,
          url: planned.url,
          status: "skipped_by_config",
          panels: {},
        };
      }
      if (planned.kind === "removed") {
        return {
          host: planned.host,
          variant: planned.variant,
          label: planned.label,
          url: planned.url,
          status: "removed",
          panels: {},
        };
      }

      const key = targetKey(planned);
      const raw = rawOutcomes.get(key);
      const base = baseOutcomes.get(key);
      const pr = prOutcomes.get(key);

      const panels: TargetResult["panels"] = {};
      if (raw?.ok) panels.raw = raw.relativePath;
      if (base?.ok) panels.base = base.relativePath;
      if (pr?.ok) panels.pr = pr.relativePath;

      const firstError =
        (raw && !raw.ok ? raw.error : undefined) ??
        (base && !base.ok ? base.error : undefined) ??
        (pr && !pr.ok ? pr.error : undefined);

      if (firstError) {
        return {
          host: planned.host,
          variant: planned.variant,
          label: planned.label,
          url: planned.url,
          status: "error",
          panels,
          error: firstError,
        };
      }

      return {
        host: planned.host,
        variant: planned.variant,
        label: planned.label,
        url: planned.url,
        status: "captured",
        panels,
      };
    });

    const report: VisualReport = {
      generatedAt: now().toISOString(),
      results,
      ...(parsedArgs.baseRef !== undefined ? { baseRef: parsedArgs.baseRef } : {}),
    };

    writeVisualReport(outDir, report);
    appendStepSummary(formatStepSummaryMarkdown(report), deps.stepSummaryPath);

    const errorCount = results.filter((result) => result.status === "error").length;
    if (errorCount > 0) {
      throw new Error(`Visual capture failed for ${errorCount} target(s)`);
    }

    return report;
  } finally {
    plan.cleanup();
  }
}

export async function runCli(
  argv: string[],
  deps: PreviewDependencies & CaptureDependencies = {},
): Promise<void> {
  const command = argv[0];
  if (command === "preview") {
    const parsed = parsePreviewArgs(argv);
    await runPreview(parsed, deps);
    return;
  }
  if (command === "capture") {
    const parsed = parseCaptureArgs(argv);
    await runCapture(parsed, deps);
    return;
  }
  throw new Error(CLI_USAGE);
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
