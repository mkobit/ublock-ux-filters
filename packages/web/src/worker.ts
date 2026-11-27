import type { BuildManifest, ManifestEntry } from "./render.ts";

export interface AssetsBinding {
  fetch(input: Request | string): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: AssetsBinding;
}

const TEXT_PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8";
const CUSTOM_LIST_CACHE_CONTROL = "public, max-age=300";

function textResponse(
  body: string | null,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": TEXT_PLAIN_CONTENT_TYPE,
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  return new Response(body, { status, headers });
}

function parseIncludeParam(rawInclude: string | null): string[] {
  if (rawInclude === null) {
    return [];
  }
  const unique = new Set<string>();
  for (const part of rawInclude.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function stripFragmentHeaders(fragment: string): string {
  return fragment
    .replace(/^\uFEFF/, "")
    .replaceAll(/\r\n?/g, "\n")
    .replace(/^(?:\[Adblock[^\n]*\]|!\s*(?:Title|Expires|Version|Homepage):[^\n]*)\n/gim, "")
    .trim();
}

function isValidManifest(value: unknown): value is BuildManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entries = Reflect.get(value, "entries");
  return typeof entries === "object" && entries !== null && !Array.isArray(entries);
}

async function fetchManifest(requestUrl: string, assets: AssetsBinding): Promise<BuildManifest | null> {
  const manifestUrl = new URL("/manifest.json", requestUrl);
  const response = await assets.fetch(new Request(manifestUrl.toString()));
  if (!response.ok) {
    return null;
  }
  try {
    const parsed: unknown = await response.json();
    return isValidManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchFragmentText(
  requestUrl: string,
  entry: ManifestEntry,
  assets: AssetsBinding,
): Promise<string | null> {
  const normalizedPath = `/${entry.fragmentPath.replace(/^\/+/, "")}`;
  const fragmentUrl = new URL(normalizedPath, requestUrl);
  const response = await assets.fetch(new Request(fragmentUrl.toString()));
  if (!response.ok) {
    return null;
  }
  return await response.text();
}

export async function handleCustomListRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/custom.txt" || (request.method !== "GET" && request.method !== "HEAD")) {
    return env.ASSETS.fetch(request);
  }

  const requestedIds = parseIncludeParam(url.searchParams.get("include"));
  if (requestedIds.length === 0) {
    return textResponse("Missing or empty 'include' query parameter.\n", 400);
  }

  const manifest = await fetchManifest(request.url, env.ASSETS);
  if (!manifest) {
    return textResponse("Failed to load filter manifest.\n", 500);
  }

  const unknownIds: string[] = [];
  const selectedEntries: ManifestEntry[] = [];
  for (const id of requestedIds) {
    if (!Object.hasOwn(manifest.entries, id)) {
      unknownIds.push(id);
      continue;
    }
    const entry = manifest.entries[id];
    if (!entry) {
      unknownIds.push(id);
      continue;
    }
    selectedEntries.push(entry);
  }

  if (unknownIds.length > 0) {
    return textResponse(`Unknown filter IDs: ${unknownIds.join(", ")}\n`, 400);
  }

  const fragmentTexts = await Promise.all(
    selectedEntries.map((entry) => fetchFragmentText(request.url, entry, env.ASSETS)),
  );
  const missingEntry = selectedEntries.find((_, index) => fragmentTexts[index] === null);
  if (missingEntry) {
    return textResponse(`Failed to load filter fragment for ${missingEntry.id}.\n`, 500);
  }

  const header = [
    "! Title: ublock-ux-filters (custom)",
    "! Expires: 1 day",
    `! Includes: ${requestedIds.join(", ")}`,
  ].join("\n");

  const sections = selectedEntries.map((entry, index) => {
    const cleaned = stripFragmentHeaders(fragmentTexts[index] ?? "");
    return cleaned.length > 0 ? `! --- ${entry.id} ---\n${cleaned}` : `! --- ${entry.id} ---`;
  });

  const body = `${header}\n\n${sections.join("\n\n")}\n`;
  return textResponse(request.method === "HEAD" ? null : body, 200, {
    "Cache-Control": CUSTOM_LIST_CACHE_CONTROL,
  });
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleCustomListRequest(request, env);
  },
};
