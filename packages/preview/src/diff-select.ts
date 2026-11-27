import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parseHostMeta } from "@ubdf/schema";
import type { HostMeta } from "@ubdf/schema";
import {
  compiledFilterPath,
  getTransitiveVariantIds,
  loadComposedVariantRules,
  tryLoadComposedVariantRules,
} from "./filters.ts";

const SHARED_BUILD_EXACT_FILES = new Set(["package.json", "bun.lock"]);
const SHARED_BUILD_PREFIXES = ["packages/builder/", "packages/schema/"];

export interface DiffClassification {
  hasSharedBuildChange: boolean;
  changedTomlHosts: Set<string>;
  changedUboFilesByHost: Map<string, Set<string>>;
}

export type PlannedCaptureTarget =
  | {
      kind: "capture";
      host: string;
      variant: string;
      label: string;
      url: string;
      waitFor?: string;
      panelsMode: "2-way" | "3-way";
      prFilterPath: string;
      baseFilterPath?: string;
    }
  | {
      kind: "skipped_by_config";
      host: string;
      variant: string;
      label: string;
      url: string;
    }
  | {
      kind: "removed";
      host: string;
      variant: string;
      label: string;
      url: string;
    };

export interface CapturePlan {
  targets: PlannedCaptureTarget[];
  cleanup: () => void;
}

export interface SelectCapturePlanOptions {
  rootDir: string;
  baseRef?: string;
  host?: string;
  variant?: string;
  ci: boolean;
}

export interface BaseCheckout {
  baseRootDir: string;
  baseDistDir: string;
  cleanup: () => void;
}

export interface DiffSelectDependencies {
  getChangedFiles?: (rootDir: string, baseRef: string) => Promise<string[]>;
  buildFilters?: (rootDir: string) => Promise<void>;
  prepareBaseCheckout?: (rootDir: string, baseRef: string) => Promise<BaseCheckout>;
}

/**
 * Resolves CI enablement with host-level opt-out precedence:
 * `preview.ci === false` disables CI for the entire host; otherwise
 * `target.ci === false` opts out an individual target.
 */
export function isTargetEnabledForCi(hostCi?: boolean, targetCi?: boolean): boolean {
  if (hostCi === false) {
    return false;
  }
  if (targetCi === false) {
    return false;
  }
  return true;
}

export function classifyChangedPaths(changedPaths: string[]): DiffClassification {
  let hasSharedBuildChange = false;
  const changedTomlHosts = new Set<string>();
  const changedUboFilesByHost = new Map<string, Set<string>>();

  for (const rawPath of changedPaths) {
    const normalized = posix.normalize(rawPath.replaceAll("\\", "/"));
    if (normalized === "" || normalized === ".") {
      continue;
    }

    if (
      SHARED_BUILD_EXACT_FILES.has(normalized) ||
      SHARED_BUILD_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      hasSharedBuildChange = true;
      continue;
    }

    if (!normalized.startsWith("filters/")) {
      continue;
    }

    const rest = normalized.slice("filters/".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) {
      continue;
    }

    const host = rest.slice(0, slashIdx);
    const relPath = rest.slice(slashIdx + 1);
    if (relPath === "filter.toml") {
      changedTomlHosts.add(host);
      continue;
    }

    if (relPath.endsWith(".ubo")) {
      let set = changedUboFilesByHost.get(host);
      if (!set) {
        set = new Set<string>();
        changedUboFilesByHost.set(host, set);
      }
      set.add(relPath);
    }
  }

  return {
    hasSharedBuildChange,
    changedTomlHosts,
    changedUboFilesByHost,
  };
}

function loadHostMetaIfExists(rootDir: string, host: string): HostMeta | undefined {
  const filterTomlPath = join(rootDir, "filters", host, "filter.toml");
  if (!existsSync(filterTomlPath)) {
    return undefined;
  }
  const parsedToml = Bun.TOML.parse(readFileSync(filterTomlPath, "utf8"));
  return parseHostMeta(parsedToml, host);
}

function listHostDirs(rootDir: string): string[] {
  const filtersDir = join(rootDir, "filters");
  if (!existsSync(filtersDir)) {
    return [];
  }
  const hosts: string[] = [];
  for (const entry of readdirSync(filtersDir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(filtersDir, entry.name, "filter.toml"))) {
      hosts.push(entry.name);
    }
  }
  return hosts.sort();
}

async function runCheckedCommand(cmd: string[], cwd: string, description: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`${description} failed: ${detail}`);
  }
  return stdout;
}

async function defaultGetChangedFiles(rootDir: string, baseRef: string): Promise<string[]> {
  const stdout = await runCheckedCommand(
    ["git", "diff", "--name-only", `${baseRef}...HEAD`],
    rootDir,
    `git diff against ${baseRef}`,
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function defaultBuildFilters(rootDir: string): Promise<void> {
  await runCheckedCommand(
    ["bun", "packages/builder/src/index.ts", "build"],
    rootDir,
    "Filter build",
  );
}

async function defaultPrepareBaseCheckout(
  rootDir: string,
  baseRef: string,
): Promise<BaseCheckout> {
  const tmpParent = mkdtempSync(join(tmpdir(), "ubouf-base-"));
  const worktreeDir = join(tmpParent, "worktree");
  const baseDistDir = join(tmpParent, "dist");

  const cleanupWorktree = (): void => {
    if (existsSync(worktreeDir)) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", worktreeDir], {
        cwd: rootDir,
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    rmSync(tmpParent, { recursive: true, force: true });
  };

  try {
    await runCheckedCommand(
      ["git", "worktree", "add", "--detach", worktreeDir, baseRef],
      rootDir,
      `git worktree add ${baseRef}`,
    );
    await runCheckedCommand(
      ["bun", "install", "--frozen-lockfile"],
      worktreeDir,
      `bun install --frozen-lockfile in ${baseRef} worktree`,
    );
    await runCheckedCommand(
      ["bun", "packages/builder/src/index.ts", "build", "--out", baseDistDir],
      worktreeDir,
      `Base build for ${baseRef}`,
    );
    return {
      baseRootDir: worktreeDir,
      baseDistDir,
      cleanup: cleanupWorktree,
    };
  } catch (error) {
    cleanupWorktree();
    throw error;
  }
}

function addTargetPlansForVariant(
  plans: PlannedCaptureTarget[],
  hostMeta: HostMeta,
  variant: string,
  ci: boolean,
  prDistDir: string,
  baseDistDir?: string,
): void {
  const preview = hostMeta.preview;
  if (!preview) {
    return;
  }

  const prFilterPath = compiledFilterPath(prDistDir, hostMeta.host, variant);
  loadComposedVariantRules(prDistDir, hostMeta.host, variant);

  const candidateBasePath =
    baseDistDir !== undefined ? compiledFilterPath(baseDistDir, hostMeta.host, variant) : undefined;
  const hasBase =
    baseDistDir !== undefined &&
    tryLoadComposedVariantRules(baseDistDir, hostMeta.host, variant) !== undefined;

  for (const target of preview.targets) {
    if (ci && !isTargetEnabledForCi(preview.ci, target.ci)) {
      plans.push({
        kind: "skipped_by_config",
        host: hostMeta.host,
        variant,
        label: target.label,
        url: target.url,
      });
      continue;
    }

    plans.push({
      kind: "capture",
      host: hostMeta.host,
      variant,
      label: target.label,
      url: target.url,
      panelsMode: hasBase ? "3-way" : "2-way",
      prFilterPath,
      ...(target.wait_for !== undefined ? { waitFor: target.wait_for } : {}),
      ...(hasBase && candidateBasePath !== undefined ? { baseFilterPath: candidateBasePath } : {}),
    });
  }
}

function validateHostAndVariantFilter(
  rootDir: string,
  host?: string,
  variant?: string,
): void {
  if (variant !== undefined && host === undefined) {
    throw new Error("--variant requires --host");
  }
  if (host === undefined) {
    return;
  }
  const hostMeta = loadHostMetaIfExists(rootDir, host);
  if (hostMeta && variant !== undefined && !Object.hasOwn(hostMeta.variants, variant)) {
    const available = Object.keys(hostMeta.variants).join(", ");
    throw new Error(
      `Unknown variant '${variant}' for host '${host}'. Available variants: ${available}`,
    );
  }
}

export async function selectCapturePlan(
  options: SelectCapturePlanOptions,
  deps: DiffSelectDependencies = {},
): Promise<CapturePlan> {
  const { rootDir, baseRef, host, variant, ci } = options;
  validateHostAndVariantFilter(rootDir, host, variant);

  const buildFilters = deps.buildFilters ?? defaultBuildFilters;
  const getChangedFiles = deps.getChangedFiles ?? defaultGetChangedFiles;
  const prepareBaseCheckout = deps.prepareBaseCheckout ?? defaultPrepareBaseCheckout;

  const prDistDir = join(rootDir, "dist");

  if (baseRef === undefined) {
    await buildFilters(rootDir);
    const plans: PlannedCaptureTarget[] = [];
    const hosts = host !== undefined ? [host] : listHostDirs(rootDir);

    for (const currentHost of hosts) {
      const hostMeta = loadHostMetaIfExists(rootDir, currentHost);
      if (!hostMeta) {
        if (host !== undefined) {
          throw new Error(`Host descriptor not found for '${currentHost}'`);
        }
        continue;
      }
      if (!hostMeta.preview) {
        if (host !== undefined) {
          throw new Error(`Host '${currentHost}' does not declare [preview] targets`);
        }
        continue;
      }

      const variants = variant !== undefined ? [variant] : Object.keys(hostMeta.variants).sort();
      for (const currentVariant of variants) {
        addTargetPlansForVariant(plans, hostMeta, currentVariant, ci, prDistDir);
      }
    }

    return { targets: plans, cleanup: () => {} };
  }

  const changedFiles = await getChangedFiles(rootDir, baseRef);
  const diff = classifyChangedPaths(changedFiles);
  const hasAnyRelevantChange =
    diff.hasSharedBuildChange ||
    diff.changedTomlHosts.size > 0 ||
    diff.changedUboFilesByHost.size > 0;

  if (!hasAnyRelevantChange) {
    return { targets: [], cleanup: () => {} };
  }

  await buildFilters(rootDir);
  const baseCheckout = await prepareBaseCheckout(rootDir, baseRef);
  const plans: PlannedCaptureTarget[] = [];

  try {
    const candidateHosts = new Set<string>(listHostDirs(rootDir));
    for (const baseHost of listHostDirs(baseCheckout.baseRootDir)) {
      candidateHosts.add(baseHost);
    }
    for (const tomlHost of diff.changedTomlHosts) {
      candidateHosts.add(tomlHost);
    }

    const headMetaCache = new Map<string, HostMeta | undefined>();
    const getHeadHostMeta = (hostName: string): HostMeta | undefined => {
      if (!headMetaCache.has(hostName)) {
        headMetaCache.set(hostName, loadHostMetaIfExists(rootDir, hostName));
      }
      return headMetaCache.get(hostName);
    };

    const hostsToCheck =
      host !== undefined ? [host] : Array.from(candidateHosts).sort();

    for (const currentHost of hostsToCheck) {
      const headMeta = getHeadHostMeta(currentHost);
      const baseMeta = loadHostMetaIfExists(baseCheckout.baseRootDir, currentHost);
      const tomlChanged = diff.changedTomlHosts.has(currentHost);

      if (headMeta?.preview) {
        const variantNames =
          variant !== undefined ? [variant] : Object.keys(headMeta.variants).sort();

        for (const currentVariant of variantNames) {
          const variantMeta = headMeta.variants[currentVariant];
          if (!variantMeta) {
            continue;
          }

          const prText = tryLoadComposedVariantRules(prDistDir, currentHost, currentVariant);
          const baseText = tryLoadComposedVariantRules(
            baseCheckout.baseDistDir,
            currentHost,
            currentVariant,
          );
          const compiledChanged = prText !== baseText;
          const transitiveIds = getTransitiveVariantIds(
            prDistDir,
            currentHost,
            currentVariant,
            getHeadHostMeta,
          );
          const uboChanged = transitiveIds.some((id) => {
            const sepIdx = id.indexOf("::");
            if (sepIdx <= 0) {
              return false;
            }
            const depHost = id.slice(0, sepIdx);
            const depVariant = id.slice(sepIdx + 2);
            const depFile = getHeadHostMeta(depHost)?.variants[depVariant]?.file;
            return depFile !== undefined && (diff.changedUboFilesByHost.get(depHost)?.has(depFile) ?? false);
          });
          const isAffected =
            tomlChanged ||
            uboChanged ||
            (diff.hasSharedBuildChange && compiledChanged) ||
            compiledChanged;

          if (!isAffected) {
            continue;
          }

          addTargetPlansForVariant(
            plans,
            headMeta,
            currentVariant,
            ci,
            prDistDir,
            baseCheckout.baseDistDir,
          );
        }

        if (tomlChanged && baseMeta?.preview) {
          const headLabels = new Set(headMeta.preview.targets.map((target) => target.label));
          const baseVariants = Object.keys(baseMeta.variants).sort();

          for (const baseVariant of baseVariants) {
            if (variant !== undefined && baseVariant !== variant) {
              continue;
            }
            const variantRemoved = !Object.hasOwn(headMeta.variants, baseVariant);
            for (const baseTarget of baseMeta.preview.targets) {
              if (variantRemoved || !headLabels.has(baseTarget.label)) {
                plans.push({
                  kind: "removed",
                  host: currentHost,
                  variant: baseVariant,
                  label: baseTarget.label,
                  url: baseTarget.url,
                });
              }
            }
          }
        }
      } else if (tomlChanged && baseMeta?.preview) {
        const baseVariants = Object.keys(baseMeta.variants).sort();
        for (const baseVariant of baseVariants) {
          if (variant !== undefined && baseVariant !== variant) {
            continue;
          }
          for (const baseTarget of baseMeta.preview.targets) {
            plans.push({
              kind: "removed",
              host: currentHost,
              variant: baseVariant,
              label: baseTarget.label,
              url: baseTarget.url,
            });
          }
        }
      }
    }

    return {
      targets: plans,
      cleanup: baseCheckout.cleanup,
    };
  } catch (error) {
    baseCheckout.cleanup();
    throw error;
  }
}
