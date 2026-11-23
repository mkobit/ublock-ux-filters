import { fileURLToPath } from "node:url";
import { compileWorkspace, lintWorkspace } from "./compiler.ts";
import type { FilterParserAdapter } from "./compiler.ts";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const homepageUrl = "https://github.com/mkobit/ublock-ux-filters";
const usage = "Usage: lint [--host <host>] | build [--host <host>] [--out <directory>]";

export async function runCli(args: string[], adapter: FilterParserAdapter) {
  const [command] = args;
  if (command !== "build" && command !== "lint") throw new Error(usage);
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index]!;
    const value = args[index + 1];
    if ((option !== "--host" && (command !== "build" || option !== "--out"))
      || options.has(option) || !value || value.startsWith("--")) {
      throw new Error(usage);
    }
    options.set(option, value);
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
  if (epoch !== undefined && !/^\d+$/.test(epoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a nonnegative integer");
  }
  const generatedAt = epoch !== undefined
    ? new Date(Number(epoch) * 1000).toISOString()
    : gitDate ? new Date(gitDate).toISOString() : undefined;
  const outDir = options.get("--out") ?? (host === undefined ? "dist" : `filters/${host}/dist`);
  await compileWorkspace({
    rootDir,
    outDir,
    gitSha,
    homepageUrl,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  }, adapter, host);
}
