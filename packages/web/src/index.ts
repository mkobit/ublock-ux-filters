import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  renderAppJs,
  renderCss,
  renderHtml,
} from "./render.ts";
import type {
  BuildManifest,
  VariantCatalogItem,
} from "./render.ts";
import worker from "./worker.ts";

const usage = "Usage: <build [--dist <dir>] [--out <dir>] [--base-url <url>] | serve [--out <dir>] [--port <n>]>";
const assetExtensions = new Set([".png", ".webp", ".jpg", ".jpeg", ".svg"]);
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export interface BuildWebOptions {
  distDir: string;
  outDir: string;
  baseUrl?: string;
  filtersDir?: string;
}

async function pathStatus(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readManifest(distDir: string): Promise<BuildManifest> {
  const manifestPath = join(distDir, "manifest.json");
  if (!(await pathStatus(manifestPath))?.isFile()) {
    throw new Error(`Missing build manifest at ${manifestPath}. Run the filter build first.`);
  }
  return await Bun.file(manifestPath).json() as BuildManifest;
}

async function listHostAssets(filtersDir: string, host: string): Promise<string[]> {
  const assetsDir = join(filtersDir, host, "assets");
  const info = await pathStatus(assetsDir);
  if (!info?.isDirectory()) {
    return [];
  }
  const names = (await readdir(assetsDir)).sort();
  const files: string[] = [];
  for (const name of names) {
    if (!assetExtensions.has(extname(name).toLowerCase())) {
      continue;
    }
    const fileInfo = await pathStatus(join(assetsDir, name));
    if (fileInfo?.isFile()) {
      files.push(name);
    }
  }
  return files;
}

async function copyInto(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export async function buildWebCatalog(options: BuildWebOptions): Promise<void> {
  const distDir = resolve(options.distDir);
  const outDir = resolve(options.outDir);
  const filtersDir = options.filtersDir
    ? resolve(options.filtersDir)
    : join(dirname(distDir), "filters");

  const manifest = await readManifest(distDir);

  const variants: VariantCatalogItem[] = [];
  const assetCopies: Array<{ source: string; target: string }> = [];
  const entries = Object.values(manifest.entries).sort((left, right) => {
    const hostCmp = left.host.localeCompare(right.host);
    return hostCmp !== 0 ? hostCmp : left.variant.localeCompare(right.variant);
  });

  const hostAssetCache = new Map<string, string[]>();
  for (const entry of entries) {
    const fragmentSource = join(distDir, entry.fragmentPath);
    if (!(await pathStatus(fragmentSource))?.isFile()) {
      throw new Error(`Missing fragment file ${fragmentSource} referenced by manifest.`);
    }
    const rulesText = await Bun.file(fragmentSource).text();
    const hostMeta = manifest.hosts[entry.host];
    const displayName = hostMeta?.displayName ?? entry.host;
    const isDefault = hostMeta?.defaultVariant === entry.variant;

    let assetNames = hostAssetCache.get(entry.host);
    if (assetNames === undefined) {
      assetNames = await listHostAssets(filtersDir, entry.host);
      hostAssetCache.set(entry.host, assetNames);
      for (const fileName of assetNames) {
        assetCopies.push({
          source: join(filtersDir, entry.host, "assets", fileName),
          target: `assets/${entry.host}/${fileName}`,
        });
      }
    }

    variants.push({
      entry,
      displayName,
      isDefault,
      rulesText,
      assets: assetNames.map((fileName) => `assets/${entry.host}/${fileName}`),
    });
  }

  const outParent = dirname(outDir);
  await mkdir(outParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(outParent, `.${basename(outDir)}.web-build-`));
  const nextDir = join(stagingRoot, "next");
  try {
    await mkdir(nextDir, { recursive: true });
    await copyInto(join(distDir, "manifest.json"), join(nextDir, "manifest.json"));

    for (const set of Object.values(manifest.sets)) {
      const setSource = join(distDir, set.setPath);
      if (!(await pathStatus(setSource))?.isFile()) {
        throw new Error(`Missing set file ${setSource} referenced by manifest.`);
      }
      await copyInto(setSource, join(nextDir, set.setPath));
    }

    for (const item of variants) {
      await copyInto(
        join(distDir, item.entry.fragmentPath),
        join(nextDir, item.entry.fragmentPath),
      );
    }

    for (const asset of assetCopies) {
      await copyInto(asset.source, join(nextDir, asset.target));
    }

    const html = renderHtml({
      manifest,
      variants,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    await Bun.write(join(nextDir, "index.html"), html);
    await Bun.write(join(nextDir, "styles.css"), renderCss());
    await Bun.write(join(nextDir, "app.js"), renderAppJs());

    await rm(outDir, { recursive: true, force: true });
    await rename(nextDir, outDir);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function createLocalWebHandler(outDir: string): (request: Request) => Promise<Response> {
  const rootDir = resolve(outDir);

  async function assetsFetch(input: Request | string): Promise<Response> {
    const request = typeof input === "string" ? new Request(input) : input;
    const url = new URL(request.url);

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
      return new Response("Bad Request", { status: 400 });
    }

    const segments = decodedPath.split("/");
    if (segments.includes("..")) {
      return new Response("Bad Request", { status: 400 });
    }

    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const filePath = resolve(rootDir, relativePath || "index.html");
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
      return new Response("Bad Request", { status: 400 });
    }

    if (!(await pathStatus(filePath))?.isFile()) {
      return new Response("Not Found", { status: 404 });
    }

    const contentType = contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const headers = { "Content-Type": contentType };
    return new Response(request.method === "HEAD" ? null : Bun.file(filePath), {
      status: 200,
      headers,
    });
  }

  return (request: Request): Promise<Response> => {
    return worker.fetch(request, {
      ASSETS: {
        fetch: assetsFetch,
      },
    });
  };
}

function parseCliOptions(args: string[], allowedOptions: Set<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !option
      || !allowedOptions.has(option)
      || options.has(option)
      || !value
      || value.startsWith("--")
    ) {
      throw new Error(usage);
    }
    options.set(option, value);
  }
  return options;
}

export async function runCli(args: string[], cwd = process.cwd()): Promise<void> {
  const [command] = args;
  if (command === "build") {
    const options = parseCliOptions(args, new Set(["--dist", "--out", "--base-url"]));
    const distDir = resolve(cwd, options.get("--dist") ?? "dist");
    const outDir = resolve(cwd, options.get("--out") ?? "dist-web");
    const baseUrl = options.get("--base-url");

    await buildWebCatalog({
      distDir,
      outDir,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
    return;
  }

  if (command === "serve") {
    const options = parseCliOptions(args, new Set(["--out", "--port"]));
    const outDir = resolve(cwd, options.get("--out") ?? "dist-web");
    const rawPort = options.get("--port") ?? "8787";
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${rawPort}. Expected an integer between 1 and 65535.`);
    }

    const server = Bun.serve({
      port,
      fetch: createLocalWebHandler(outDir),
    });
    console.log(`Serving ${outDir} at http://localhost:${server.port}`);
    return;
  }

  throw new Error(usage);
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
