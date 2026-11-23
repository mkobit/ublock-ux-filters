import { runCli } from "./cli.ts";
import { aglintAdapter } from "./parser-adapter.ts";

try {
  await runCli(Bun.argv.slice(2), aglintAdapter);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
