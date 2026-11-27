import { fileURLToPath } from "node:url";
import { compileWorkspace, lintWorkspace } from "./compiler.ts";
import type { FilterParserAdapter } from "./compiler.ts";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const homepageUrl = "https://github.com/mkobit/ublock-ux-filters";
const usage = "Usage: lint [--host <host>] | build [--incremental] [--host <host>] [--out <directory>]";

const maxEpochSeconds = 8_640_000_000_000;

function parseSourceDateEpoch(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a nonnegative integer");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > maxEpochSeconds) {
    throw new Error(`SOURCE_DATE_EPOCH must be between 0 and ${maxEpochSeconds}`);
  }
  return new Date(seconds * 1000).toISOString();
}

export async function runCli(args: string[], adapter: FilterParserAdapter) {
  const [command] = args;
  if (command !== "build" && command !== "lint") throw new Error(usage);
  const options = new Map<string, string>();
  let incremental = false;
  for (let index = 1; index < args.length;) {
    const option = args[index]!;
    if (command === "build" && option === "--incremental") {
      if (incremental) throw new Error(usage);
      incremental = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if ((option !== "--host" && (command !== "build" || option !== "--out"))
      || options.has(option) || !value || value.startsWith("--")) {
      throw new Error(usage);
    }
    options.set(option, value);
    index += 2;
  }
  const host = options.get("--host");
  if (command === "lint") {
    await lintWorkspace(rootDir, adapter, host);
    return;
  }
  const gitSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: rootDir })
    .stdout.toString().trim() || "dev";
  const gitDate = Bun.spawnSync(["git", "log", "-1", "--format=%cI"], { cwd: rootDir })
    .stdout.toString().trim();
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = epoch !== undefined
    ? parseSourceDateEpoch(epoch)
    : gitDate ? new Date(gitDate).toISOString() : undefined;
  const outDir = options.get("--out") ?? (host === undefined ? "dist" : `filters/${host}/dist`);
  await compileWorkspace({
    rootDir,
    outDir,
    gitSha,
    homepageUrl,
    ...(incremental ? { incremental: true, cacheKey: "aglint-v1" } : {}),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  }, adapter, host);
}
