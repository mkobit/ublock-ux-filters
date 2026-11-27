import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostMeta } from "@ubdf/schema";
import type { HostMeta, PreviewTargetMeta } from "@ubdf/schema";

export interface PreviewConfig {
  host: string;
  variant: string;
  targets: PreviewTargetMeta[];
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

export async function defaultBuildFilters(rootDir: string): Promise<void> {
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
