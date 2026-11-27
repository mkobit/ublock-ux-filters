import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { composeFragments, orderEntries } from "@ubdf/builder/compiler";
import type { CompiledEntry, CompiledManifest } from "@ubdf/builder/compiler";
import type { CanonicalFilterId, HostMeta } from "@ubdf/schema";

export function compiledFilterPath(distDir: string, host: string, variant: string): string {
  return join(distDir, "raw", host, `${variant}.txt`);
}

function readCompiledManifest(distDir: string): CompiledManifest | undefined {
  const manifestPath = join(distDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as CompiledManifest;
}

function buildEntriesMap(manifest: CompiledManifest): Map<CanonicalFilterId, CompiledEntry> {
  const entries = new Map<CanonicalFilterId, CompiledEntry>();
  for (const [id, entry] of Object.entries(manifest.entries)) {
    if (entry !== undefined) {
      entries.set(id as CanonicalFilterId, entry);
    }
  }
  return entries;
}

type ComposeResult =
  | { ok: true; content: string }
  | { ok: false; missingPath: string };

function tryComposeFromDist(distDir: string, host: string, variant: string): ComposeResult {
  const manifest = readCompiledManifest(distDir);
  if (manifest !== undefined) {
    const entries = buildEntriesMap(manifest);
    const id: CanonicalFilterId = `${host}::${variant}`;
    if (!entries.has(id)) {
      return { ok: false, missingPath: compiledFilterPath(distDir, host, variant) };
    }
    const orderedIds = orderEntries([id], entries);
    const fragments = new Map<CanonicalFilterId, string>();
    for (const resolvedId of orderedIds) {
      const entry = entries.get(resolvedId);
      if (!entry) {
        return { ok: false, missingPath: compiledFilterPath(distDir, host, variant) };
      }
      const fragmentPath = join(distDir, entry.fragmentPath);
      if (!existsSync(fragmentPath)) {
        return { ok: false, missingPath: fragmentPath };
      }
      fragments.set(resolvedId, readFileSync(fragmentPath, "utf8"));
    }
    return {
      ok: true,
      content: composeFragments(orderedIds, (resolvedId) => fragments.get(resolvedId)!),
    };
  }

  const rawPath = compiledFilterPath(distDir, host, variant);
  if (!existsSync(rawPath)) {
    return { ok: false, missingPath: rawPath };
  }
  return { ok: true, content: readFileSync(rawPath, "utf8") };
}

/**
 * Loads composed filter rules for `host::variant` in subscription composition order.
 */
export function loadComposedVariantRules(distDir: string, host: string, variant: string): string {
  const result = tryComposeFromDist(distDir, host, variant);
  if (!result.ok) {
    throw new Error(`Compiled filter not found at ${result.missingPath} after build`);
  }
  return result.content;
}

/**
 * Attempts to load composed filter rules, returning `undefined` when absent.
 */
export function tryLoadComposedVariantRules(
  distDir: string,
  host: string,
  variant: string,
): string | undefined {
  const result = tryComposeFromDist(distDir, host, variant);
  return result.ok ? result.content : undefined;
}

/**
 * Loads filter text for a capture pass, resolving includes when a build manifest is present.
 */
export function loadFilterTextForCapture(
  filterPath: string,
  host: string,
  variant: string,
): string {
  const distDir = resolve(filterPath, "../../..");
  if (existsSync(join(distDir, "manifest.json"))) {
    return loadComposedVariantRules(distDir, host, variant);
  }
  return readFileSync(filterPath, "utf8");
}

/**
 * Returns all transitive filter IDs (dependencies and self) for `host::variant`.
 */
export function getTransitiveVariantIds(
  distDir: string,
  host: string,
  variant: string,
  loadHostMeta: (hostName: string) => HostMeta | undefined,
): CanonicalFilterId[] {
  const id: CanonicalFilterId = `${host}::${variant}`;
  const manifest = readCompiledManifest(distDir);
  if (manifest !== undefined) {
    const entries = buildEntriesMap(manifest);
    if (entries.has(id)) {
      return orderEntries([id], entries);
    }
  }

  const visited = new Set<CanonicalFilterId>();
  const visit = (currentId: CanonicalFilterId): void => {
    if (visited.has(currentId)) {
      return;
    }
    visited.add(currentId);
    const sepIndex = currentId.indexOf("::");
    if (sepIndex <= 0) {
      return;
    }
    const currentHost = currentId.slice(0, sepIndex);
    const currentVariant = currentId.slice(sepIndex + 2);
    const meta = loadHostMeta(currentHost);
    const includes = meta?.variants[currentVariant]?.includes ?? [];
    for (const includeId of includes) {
      visit(includeId);
    }
  };
  visit(id);
  return Array.from(visited);
}
