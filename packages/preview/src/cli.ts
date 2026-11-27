import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostMeta } from "@ubdf/schema";
import type { HostMeta, PreviewTargetMeta } from "@ubdf/schema";
import { prepareSession } from "./session.ts";
import type { BrowserSession, PrepareSessionOptions } from "./session.ts";
import { ensureToolchain } from "./toolchain.ts";
import type { ToolchainPaths } from "./toolchain.ts";

const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const USAGE =
  "Usage: preview --host <host> [--variant <variant>] [--keep-profile]";

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

export function parsePreviewArgs(args: string[]): PreviewCliArgs {
  const [command, ...rest] = args;
  if (command !== "preview") {
    throw new Error(USAGE);
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
        throw new Error(USAGE);
      }
      keepProfile = true;
      index += 1;
      continue;
    }

    if (token === "--host" || token === "--variant") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(USAGE);
      }
      if (token === "--host") {
        if (host !== undefined) {
          throw new Error(USAGE);
        }
        host = value;
      } else {
        if (variant !== undefined) {
          throw new Error(USAGE);
        }
        variant = value;
      }
      index += 2;
      continue;
    }

    throw new Error(USAGE);
  }

  if (host === undefined) {
    throw new Error(USAGE);
  }

  return {
    command: "preview",
    host,
    keepProfile,
    ...(variant !== undefined ? { variant } : {}),
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

export async function runCli(
  argv: string[],
  deps: PreviewDependencies = {},
): Promise<void> {
  const parsed = parsePreviewArgs(argv);
  await runPreview(parsed, deps);
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
