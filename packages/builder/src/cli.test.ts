import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

function runBuildCli(args: string[], envOverrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return Bun.spawnSync(["bun", cliEntry, ...args], {
    cwd: rootDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function withTempOutDir(run: (outDir: string) => Promise<void>) {
  const outDir = `dist-cli-test-${crypto.randomUUID()}`;
  try {
    await run(outDir);
  } finally {
    await rm(join(rootDir, outDir), { recursive: true, force: true });
  }
}

test.each([
  { label: "empty string", value: "", expectedError: "SOURCE_DATE_EPOCH must be a nonnegative integer" },
  { label: "negative integer", value: "-1", expectedError: "SOURCE_DATE_EPOCH must be a nonnegative integer" },
  { label: "decimal number", value: "1.5", expectedError: "SOURCE_DATE_EPOCH must be a nonnegative integer" },
  { label: "non-numeric text", value: "abc", expectedError: "SOURCE_DATE_EPOCH must be a nonnegative integer" },
  { label: "leading whitespace", value: " 123", expectedError: "SOURCE_DATE_EPOCH must be a nonnegative integer" },
  { label: "one second above max JS Date", value: "8640000000001", expectedError: "SOURCE_DATE_EPOCH must be between 0 and 8640000000000" },
  { label: "huge digit string", value: "99999999999999999999999999", expectedError: "SOURCE_DATE_EPOCH must be between 0 and 8640000000000" },
])("Rejects invalid SOURCE_DATE_EPOCH ($label)", async ({ value, expectedError }) => {
  await withTempOutDir(async (outDir) => {
    const result = runBuildCli(["build", "--out", outDir], { SOURCE_DATE_EPOCH: value });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(expectedError);
    expect(await Bun.file(join(rootDir, outDir, "manifest.json")).exists()).toBe(false);
  });
});

test.each([
  { label: "epoch zero", value: "0", expectedIso: "1970-01-01T00:00:00.000Z" },
  { label: "regular timestamp", value: "1700000000", expectedIso: "2023-11-14T22:13:20.000Z" },
  { label: "max JS Date seconds", value: "8640000000000", expectedIso: "+275760-09-13T00:00:00.000Z" },
])("Produces deterministic output for valid SOURCE_DATE_EPOCH ($label)", async ({ value, expectedIso }) => {
  await withTempOutDir(async (outDirA) => {
    await withTempOutDir(async (outDirB) => {
      const first = runBuildCli(["build", "--out", outDirA], { SOURCE_DATE_EPOCH: value });
      expect(first.exitCode).toBe(0);

      const second = runBuildCli(["build", "--out", outDirB], { SOURCE_DATE_EPOCH: value });
      expect(second.exitCode).toBe(0);

      const manifestA = await Bun.file(join(rootDir, outDirA, "manifest.json")).text();
      const manifestB = await Bun.file(join(rootDir, outDirB, "manifest.json")).text();
      expect(JSON.parse(manifestA).generatedAt).toBe(expectedIso);
      expect(manifestA).toBe(manifestB);
    });
  });
});
