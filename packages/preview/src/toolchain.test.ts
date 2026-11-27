import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFileSha256,
  ensureToolchain,
  resolveCacheDir,
  type BrowserManifest,
} from "./toolchain.ts";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeWritableRecursive(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      makeWritableRecursive(full);
    } else if (!entry.isSymbolicLink()) {
      chmodSync(full, 0o644);
    }
  }
}

afterEach(() => {
  delete process.env["UBOUF_CACHE_DIR"];
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      makeWritableRecursive(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function createFakeToolchainArtifacts(workDir: string): Promise<{
  manifest: BrowserManifest;
  bytesByUrl: Map<string, Uint8Array>;
}> {
  const firefoxSrc = join(workDir, "src-firefox");
  mkdirSync(join(firefoxSrc, "firefox"), { recursive: true });
  writeFileSync(join(firefoxSrc, "firefox", "firefox"), "#!/bin/sh\necho firefox\n", { mode: 0o755 });
  const firefoxTar = join(workDir, "firefox.tar.xz");
  const ffRes = Bun.spawnSync(["tar", "-cJf", firefoxTar, "-C", firefoxSrc, "firefox"]);
  if (ffRes.exitCode !== 0) {
    throw new Error("Failed to create test firefox.tar.xz");
  }

  const gdSrc = join(workDir, "src-gd");
  mkdirSync(gdSrc, { recursive: true });
  writeFileSync(join(gdSrc, "geckodriver"), "#!/bin/sh\necho geckodriver\n", { mode: 0o755 });
  const gdTar = join(workDir, "geckodriver.tar.gz");
  const gdRes = Bun.spawnSync(["tar", "-czf", gdTar, "-C", gdSrc, "geckodriver"]);
  if (gdRes.exitCode !== 0) {
    throw new Error("Failed to create test geckodriver.tar.gz");
  }

  const xpiPath = join(workDir, "uBlock0.xpi");
  writeFileSync(xpiPath, "fake-signed-xpi-contents");

  const ffUrl = "https://example.invalid/firefox.tar.xz";
  const gdUrl = "https://example.invalid/geckodriver.tar.gz";
  const xpiUrl = "https://example.invalid/uBlock0.xpi";

  const manifest: BrowserManifest = {
    firefox: {
      version: "153.7.0esr-test",
      url: ffUrl,
      sha256: await computeFileSha256(firefoxTar),
    },
    geckodriver: {
      version: "0.37.1-test",
      url: gdUrl,
      sha256: await computeFileSha256(gdTar),
    },
    ublockOrigin: {
      version: "1.77.0-test",
      url: xpiUrl,
      sha256: await computeFileSha256(xpiPath),
    },
  };

  const bytesByUrl = new Map<string, Uint8Array>([
    [ffUrl, new Uint8Array(await Bun.file(firefoxTar).arrayBuffer())],
    [gdUrl, new Uint8Array(await Bun.file(gdTar).arrayBuffer())],
    [xpiUrl, new Uint8Array(await Bun.file(xpiPath).arrayBuffer())],
  ]);

  return { manifest, bytesByUrl };
}

describe("toolchain", () => {
  test("UBOUF_CACHE_DIR overrides default cache directory", () => {
    process.env["UBOUF_CACHE_DIR"] = "/tmp/custom-ubouf-cache";
    expect(resolveCacheDir()).toBe("/tmp/custom-ubouf-cache");
  });

  test("downloads, verifies SHA-256, extracts read-only, and hits cache on subsequent runs", async () => {
    const workDir = makeTempDir("ubouf-tc-work-");
    const cacheDir = makeTempDir("ubouf-tc-cache-");
    process.env["UBOUF_CACHE_DIR"] = cacheDir;

    const { manifest, bytesByUrl } = await createFakeToolchainArtifacts(workDir);
    let fetchCalls = 0;

    const first = await ensureToolchain({
      manifest,
      fetchFn: async (input) => {
        fetchCalls += 1;
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const payload = bytesByUrl.get(url);
        if (!payload) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(Buffer.from(payload), { status: 200 });
      },
    });

    expect(fetchCalls).toBe(3);
    expect(existsSync(join(first.firefoxDir, "firefox"))).toBe(true);
    expect(existsSync(first.geckodriverBin)).toBe(true);
    expect(existsSync(first.uboXpiPath)).toBe(true);

    const second = await ensureToolchain({
      manifest,
      fetchFn: async () => {
        throw new Error("fetch should not be called on cache hit");
      },
    });

    expect(second).toEqual(first);
  });

  test("rejects artifacts with SHA-256 mismatch", async () => {
    const workDir = makeTempDir("ubouf-tc-bad-work-");
    const cacheDir = makeTempDir("ubouf-tc-bad-cache-");
    const { manifest } = await createFakeToolchainArtifacts(workDir);

    await expect(
      ensureToolchain({
        cacheDir,
        manifest,
        fetchFn: async () => new Response("corrupted-bytes", { status: 200 }),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });
});
