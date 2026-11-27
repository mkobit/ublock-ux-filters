import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BrowserArtifact {
  version: string;
  url: string;
  sha256: string;
}

export interface BrowserManifest {
  firefox: BrowserArtifact;
  geckodriver: BrowserArtifact;
  ublockOrigin: BrowserArtifact;
}

export interface ToolchainPaths {
  firefoxDir: string;
  geckodriverBin: string;
  uboXpiPath: string;
}

export type FetchFn = (input: string | URL | Request) => Promise<Response>;

export interface EnsureToolchainOptions {
  cacheDir?: string;
  manifest?: BrowserManifest;
  fetchFn?: FetchFn;
}

const DEFAULT_MANIFEST_URL = new URL("../browser-manifest.json", import.meta.url);

export function loadBrowserManifest(): BrowserManifest {
  return JSON.parse(readFileSync(DEFAULT_MANIFEST_URL, "utf8")) as BrowserManifest;
}

export function resolveCacheDir(override?: string): string {
  if (override && override.trim().length > 0) {
    return override;
  }
  const envDir = process.env["UBOUF_CACHE_DIR"]?.trim();
  if (envDir && envDir.length > 0) {
    return envDir;
  }
  return join(homedir(), ".cache", "ublock-ux-filters", "browser");
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(filePath).stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

async function verifyFileSha256(filePath: string, expectedSha256: string, label: string): Promise<void> {
  const actual = await computeFileSha256(filePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${label} (${filePath}): expected ${expectedSha256}, got ${actual}`,
    );
  }
}

async function ensureDownloaded(
  artifact: BrowserArtifact,
  destPath: string,
  label: string,
  fetchFn: FetchFn,
): Promise<void> {
  if (existsSync(destPath)) {
    await verifyFileSha256(destPath, artifact.sha256, label);
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const response = await fetchFn(artifact.url);
    if (!response.ok) {
      throw new Error(`Failed to download ${label} from ${artifact.url}: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await Bun.write(tmpPath, bytes);
    await verifyFileSha256(tmpPath, artifact.sha256, label);
    renameSync(tmpPath, destPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function setReadOnlyRecursive(dirPath: string): void {
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      setReadOnlyRecursive(fullPath);
      chmodSync(fullPath, 0o555);
    } else {
      const isExecutable = (stat.mode & 0o111) !== 0;
      chmodSync(fullPath, isExecutable ? 0o555 : 0o444);
    }
  }
  chmodSync(dirPath, 0o555);
}

function extractTarArchive(
  archivePath: string,
  destDir: string,
  stripComponents: number,
  label: string,
): void {
  mkdirSync(dirname(destDir), { recursive: true });
  const stagingDir = `${destDir}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(stagingDir, { recursive: true });

  try {
    const tarFlag = archivePath.endsWith(".tar.xz") ? "-xJf" : "-xzf";
    const args = [tarFlag, archivePath];
    if (stripComponents > 0) {
      args.push(`--strip-components=${stripComponents}`);
    }
    args.push("-C", stagingDir);

    const result = Bun.spawnSync(["tar", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim();
      throw new Error(`Failed to extract ${label} (${archivePath}): ${stderr || `exit ${result.exitCode}`}`);
    }

    setReadOnlyRecursive(stagingDir);
    renameSync(stagingDir, destDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function ensureToolchain(options: EnsureToolchainOptions = {}): Promise<ToolchainPaths> {
  const manifest = options.manifest ?? loadBrowserManifest();
  const cacheRoot = resolveCacheDir(options.cacheDir);
  const downloadsDir = join(cacheRoot, "downloads");
  const fetchFn = options.fetchFn ?? fetch;

  const firefoxArchive = join(downloadsDir, `firefox-${manifest.firefox.version}.tar.xz`);
  const firefoxDir = join(cacheRoot, `firefox-${manifest.firefox.version}`);
  const firefoxBin = join(firefoxDir, "firefox");

  if (!existsSync(firefoxBin)) {
    await ensureDownloaded(manifest.firefox, firefoxArchive, "Firefox", fetchFn);
    extractTarArchive(firefoxArchive, firefoxDir, 1, "Firefox");
  } else if (existsSync(firefoxArchive)) {
    await verifyFileSha256(firefoxArchive, manifest.firefox.sha256, "Firefox");
  }

  const geckodriverArchive = join(
    downloadsDir,
    `geckodriver-v${manifest.geckodriver.version}-linux64.tar.gz`,
  );
  const geckodriverDir = join(cacheRoot, `geckodriver-${manifest.geckodriver.version}`);
  const geckodriverBin = join(geckodriverDir, "geckodriver");

  if (!existsSync(geckodriverBin)) {
    await ensureDownloaded(manifest.geckodriver, geckodriverArchive, "geckodriver", fetchFn);
    extractTarArchive(geckodriverArchive, geckodriverDir, 0, "geckodriver");
  } else if (existsSync(geckodriverArchive)) {
    await verifyFileSha256(geckodriverArchive, manifest.geckodriver.sha256, "geckodriver");
  }

  const uboDownload = join(
    downloadsDir,
    `uBlock0_${manifest.ublockOrigin.version}.firefox.signed.xpi`,
  );
  const uboDir = join(cacheRoot, `ublock-origin-${manifest.ublockOrigin.version}`);
  const uboXpiPath = join(uboDir, `uBlock0_${manifest.ublockOrigin.version}.firefox.signed.xpi`);

  if (!existsSync(uboXpiPath)) {
    await ensureDownloaded(manifest.ublockOrigin, uboDownload, "uBlock Origin XPI", fetchFn);
    mkdirSync(uboDir, { recursive: true });
    const tmpXpi = `${uboXpiPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(uboDownload, tmpXpi);
      chmodSync(tmpXpi, 0o444);
      renameSync(tmpXpi, uboXpiPath);
      chmodSync(uboDir, 0o555);
    } catch (error) {
      rmSync(tmpXpi, { force: true });
      throw error;
    }
  } else {
    await verifyFileSha256(uboXpiPath, manifest.ublockOrigin.sha256, "uBlock Origin XPI");
  }

  return {
    firefoxDir,
    geckodriverBin,
    uboXpiPath,
  };
}
