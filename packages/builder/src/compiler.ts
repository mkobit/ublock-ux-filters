import { link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFilterSetMeta, parseHostMeta, splitFilterToken } from "@ubdf/schema";
import type { CanonicalFilterId, FilterSetMeta, HostMeta } from "@ubdf/schema";

export interface LintReport {
  filePath: string;
  ruleCount: number;
  errors: Array<{ line: number; rule: string; message: string }>;
}

export interface FilterParserAdapter {
  lint(filePath: string, content: string): Promise<LintReport>;
}

export interface CompileOptions {
  rootDir: string;
  outDir: string;
  gitSha: string;
  homepageUrl: string;
  generatedAt?: string;
  incremental?: boolean;
  cacheKey?: string;
}

export interface CompileHooks {
  beforeOutputSwap?: () => Promise<void> | void;
}

type ErrorCode = "INVALID_META" | "INVALID_SET" | "LINT_FAILED"
  | "MISSING_INCLUDE" | "INCLUDE_CYCLE" | "ALIAS_CONFLICT";

export class FilterBuildError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

class BuildLockError extends Error {
  readonly code = "EEXIST";
}

interface CompiledEntry {
  id: CanonicalFilterId;
  host: string;
  variant: string;
  description: string;
  tags: string[];
  resolvedIncludes: CanonicalFilterId[];
  fragmentPath: string;
  ruleCount: number;
  sha256: string;
}

interface CompiledSet {
  name: string;
  description: string;
  setPath: string;
  members: CanonicalFilterId[];
}

interface IncrementalCache {
  version: 1;
  shared: string;
  key: string;
  variants: Record<string, { source: string; ruleCount: number }>;
}

export interface CompiledManifest {
  version: string;
  generatedAt: string;
  expires: string;
  hosts: Record<string, { displayName: string; defaultVariant?: string; variants: string[] }>;
  sets: Record<string, CompiledSet>;
  aliases: Record<string, CanonicalFilterId>;
  entries: Partial<Record<CanonicalFilterId, CompiledEntry>>;
}

async function status(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function childPath(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function rejectSymlinks(parent: string, child: string) {
  if (!childPath(parent, child)) {
    throw new Error(`Path must be inside ${parent}: ${child}`);
  }
  let path = parent;
  for (const segment of relative(parent, child).split(sep)) {
    path = join(path, segment);
    if ((await status(path))?.isSymbolicLink()) {
      throw new Error(`Path contains a symbolic link: ${path}`);
    }
  }
}

async function readText(root: string, path: string) {
  await rejectSymlinks(root, path);
  if (!(await status(path))?.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
  return Bun.file(path).text();
}

async function list(root: string, directory: string) {
  await rejectSymlinks(root, directory);
  return (await status(directory)) ? (await readdir(directory)).sort() : [];
}

async function readDescriptor<T>(
  root: string,
  path: string,
  parse: (raw: unknown) => T,
  code: "INVALID_META" | "INVALID_SET",
): Promise<T> {
  try {
    return parse(Bun.TOML.parse(await readText(root, path)));
  } catch (error) {
    throw new FilterBuildError(code, `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFragment(content: string) {
  const normalized = content.replace(/^\uFEFF/, "").replaceAll(/\r\n?/g, "\n").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

function digest(content: string) {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

async function cacheFor(root: string, path: string): Promise<IncrementalCache | undefined> {
  try {
    await rejectSymlinks(root, path);
    if ((await status(path))?.isSymbolicLink()) return undefined;
    const value = await Bun.file(path).json() as Partial<IncrementalCache>;
    if (value.version !== 1 || typeof value.shared !== "string" || typeof value.key !== "string"
      || typeof value.variants !== "object" || value.variants === null) return undefined;
    return value as IncrementalCache;
  } catch {
    return undefined;
  }
}

async function writeCache(root: string, path: string, value: IncrementalCache) {
  try {
    await rejectSymlinks(root, path);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    if ((await status(directory))?.isSymbolicLink() || (await status(path))?.isSymbolicLink()) return;
    const temporary = await mkdtemp(join(directory, ".filter-build-cache-"));
    try {
      const next = join(temporary, "next.json");
      await Bun.write(next, `${JSON.stringify(value)}\n`);
      await rename(next, path);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } catch {
    // A cache write failure must not invalidate successful artifacts.
  }
}

async function sharedFingerprint(root: string) {
  const paths = ["bun.lock", "bunfig.toml", "mise.toml", "package.json", "tsconfig.json", "packages/builder/package.json", "packages/schema/package.json"];
  for (const directory of ["packages/builder/src", "packages/schema/src"]) {
    const full = join(root, directory);
    if ((await status(full))?.isDirectory()) {
      for (const entry of await readdir(full, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) paths.push(relative(root, join(entry.parentPath, entry.name)));
      }
    }
  }
  const parts: string[] = [];
  for (const path of paths.sort()) {
    const full = join(root, path);
    if ((await status(full))?.isFile()) parts.push(`${path}\0${await readText(root, full)}`);
  }
  return digest(`${Bun.version}\0${parts.join("\0")}`);
}

async function outputEntries(destination: string): Promise<Record<string, unknown> | undefined> {
  try {
    const manifest = await Bun.file(join(destination, "manifest.json")).json() as { entries?: unknown };
    if (typeof manifest.entries !== "object" || manifest.entries === null || Array.isArray(manifest.entries)) {
      return undefined;
    }
    return manifest.entries as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function cachedReport(value: unknown, source: string, content: string, filePath: string, previous: unknown): LintReport | undefined {
  if (typeof value !== "object" || value === null
    || Reflect.get(value, "source") !== source
    || !Number.isSafeInteger(Reflect.get(value, "ruleCount"))
    || Reflect.get(value, "ruleCount") < 0
    || typeof previous !== "object" || previous === null
    || Reflect.get(previous, "sha256") !== digest(content)
    || Reflect.get(previous, "ruleCount") !== Reflect.get(value, "ruleCount")) return undefined;
  return { filePath, ruleCount: Reflect.get(value, "ruleCount") as number, errors: [] };
}

async function readHost(
  root: string,
  hostDir: string,
  adapter: FilterParserAdapter,
  cache?: IncrementalCache,
  previousEntries?: Record<string, unknown>,
) {
  const descriptorPath = join(hostDir, "filter.toml");
  const descriptor = await readText(root, descriptorPath);
  let meta: HostMeta;
  try {
    meta = parseHostMeta(Bun.TOML.parse(descriptor), basename(hostDir));
  } catch (error) {
    throw new FilterBuildError("INVALID_META", `${descriptorPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fragments = [];
  for (const variant of Object.keys(meta.variants).sort()) {
    const description = meta.variants[variant]!;
    const file = join(hostDir, description.file);
    const raw = await readText(root, file);
    const content = normalizeFragment(raw);
    const id = filterId(meta.host, variant);
    const source = digest(`${relative(root, file)}\0${raw}`);
    const report = cachedReport(cache?.variants[id], source, content, file, previousEntries?.[id])
      ?? await adapter.lint(file, content);
    fragments.push({ variant, meta: description, content, report, source });
  }
  return { meta, fragments };
}

export async function lintHostPackage(hostDir: string, adapter: FilterParserAdapter) {
  const path = resolve(hostDir);
  const { fragments } = await readHost(await realpath(dirname(path)), path, adapter);
  return fragments.map(({ report }) => report);
}

async function readHosts(
  root: string,
  adapter: FilterParserAdapter,
  onlyHost?: string,
  cache?: IncrementalCache,
  previousEntries?: Record<string, unknown>,
) {
  const directory = join(root, "filters");
  const hosts = [];
  for (const name of await list(root, directory)) {
    if (name.startsWith(".") || (onlyHost !== undefined && name !== onlyHost)) {
      continue;
    }
    const path = join(directory, name);
    await rejectSymlinks(root, path);
    if ((await status(path))?.isDirectory()) {
      hosts.push(await readHost(root, path, adapter, cache, previousEntries));
    }
  }
  if (onlyHost !== undefined && hosts.length === 0) {
    throw new FilterBuildError("INVALID_META", `Unknown host: ${onlyHost}`);
  }
  return hosts;
}

function assertLint(reports: LintReport[]) {
  const errors = reports.flatMap(({ filePath, errors }) =>
    errors.map(({ line, rule, message }) => `${filePath}:${line} [${rule}] ${message}`));
  if (errors.length > 0) {
    throw new FilterBuildError("LINT_FAILED", errors.join("\n"));
  }
}

export async function lintWorkspace(rootDir: string, adapter: FilterParserAdapter, host?: string) {
  const hosts = await readHosts(await realpath(rootDir), adapter, host);
  assertLint(hosts.flatMap(({ fragments }) => fragments.map(({ report }) => report)));
}

function filterId(host: string, variant: string): CanonicalFilterId {
  return `${host}::${variant}`;
}

function compileAliases(hosts: HostMeta[], entries: Map<CanonicalFilterId, CompiledEntry>) {
  const aliases = new Map<string, CanonicalFilterId>();
  for (const host of hosts) {
    const declared = Object.entries(host.aliases ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0);
    for (const [key, value] of declared) {
      const source = key.includes("::") ? key as CanonicalFilterId : filterId(host.host, key);
      const target = value.includes("::") ? value as CanonicalFilterId : filterId(host.host, value);
      if (entries.has(source) || aliases.has(source) || !entries.has(target)) {
        throw new FilterBuildError("ALIAS_CONFLICT", `Invalid alias ${source} → ${target}`);
      }
      aliases.set(source, target);
    }
  }
  return aliases;
}

function orderEntries(members: CanonicalFilterId[], entries: Map<CanonicalFilterId, CompiledEntry>) {
  const ordered = new Set<CanonicalFilterId>();
  const active = new Set<CanonicalFilterId>();
  function visit(id: CanonicalFilterId) {
    if (ordered.has(id)) return;
    if (active.has(id)) {
      throw new FilterBuildError("INCLUDE_CYCLE", `Include cycle: ${[...active, id].join(" → ")}`);
    }
    const entry = entries.get(id);
    if (!entry) {
      throw new FilterBuildError("MISSING_INCLUDE", `Missing include: ${id}`);
    }
    active.add(id);
    entry.resolvedIncludes.forEach(visit);
    active.delete(id);
    ordered.add(id);
  }
  members.forEach(visit);
  return [...ordered];
}

function selectMembers(
  set: FilterSetMeta,
  hosts: Map<string, HostMeta>,
  entries: Map<CanonicalFilterId, CompiledEntry>,
  aliases: Map<string, CanonicalFilterId>,
) {
  function resolveToken(token: string, allowHost: boolean): CanonicalFilterId[] {
    const parsed = splitFilterToken(token);
    if (parsed?.variant !== undefined) {
      const id = filterId(parsed.host, parsed.variant);
      const target = aliases.get(id) ?? id;
      if (entries.has(target)) return [target];
    }
    const host = parsed && hosts.get(parsed.host);
    if (parsed && host) {
      if (parsed.variant === undefined && allowHost) {
        return Object.keys(host.variants).map((variant) => filterId(host.host, variant));
      }
      if (parsed.variant === undefined && host.default_variant !== undefined) {
        return [filterId(host.host, host.default_variant)];
      }
    }
    throw new FilterBuildError("INVALID_SET", `Set ${set.name} references unknown filter ${token}`);
  }

  const members = new Set<CanonicalFilterId>();
  if (set.mode === "all-defaults") {
    for (const host of hosts.values()) {
      if (host.default_variant !== undefined) members.add(filterId(host.host, host.default_variant));
    }
  }
  if (set.mode === "tag") {
    for (const entry of entries.values()) {
      if (entry.tags.includes(set.tag!)) members.add(entry.id);
    }
  }
  for (const token of set.include ?? []) {
    for (const id of resolveToken(token, false)) members.add(id);
  }
  for (const token of set.exclude ?? []) {
    for (const id of resolveToken(token, true)) members.delete(id);
  }
  return [...members].sort();
}

const reservedPaths = [".git", ".beads", "filters", "sets", "packages", "node_modules"];

function artifactPaths(value: unknown, group: string, field: string, pattern: RegExp) {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, group)) {
    return undefined;
  }
  const entries = Reflect.get(value, group);
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return undefined;
  }
  const paths = new Set<string>();
  for (const entry of Object.values(entries)) {
    const path = entry && typeof entry === "object" ? Reflect.get(entry, field) : undefined;
    if (typeof path !== "string" || !pattern.test(path)) return undefined;
    paths.add(path);
  }
  return paths;
}

async function isBuildOutput(directory: string) {
  const manifestPath = join(directory, "manifest.json");
  if (!(await status(manifestPath))?.isFile()) return false;
  let manifest: unknown;
  try {
    manifest = await Bun.file(manifestPath).json();
  } catch {
    return false;
  }
  const fragments = artifactPaths(manifest, "entries", "fragmentPath", /^raw\/[a-z0-9][a-z0-9.-]*\/[a-z0-9-]+\.txt$/);
  const sets = artifactPaths(manifest, "sets", "setPath", /^sets\/[a-z0-9-]+\.txt$/);
  if (!fragments || !sets) return false;
  const expected = new Set(["manifest.json", ...fragments, ...sets]);
  const found = new Set<string>();
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = relative(directory, join(file.parentPath, file.name)).split(sep).join("/");
    if (file.isDirectory() && [...expected].some((name) => name.startsWith(`${path}/`))) continue;
    if (!file.isFile() || !expected.has(path)) return false;
    found.add(path);
  }
  return expected.size === found.size;
}

interface LockOwner {
  pid: number;
  startedAt: string;
  hostname: string;
}

function isProcessAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function readLockOwner(ownerPath: string): Promise<LockOwner | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await Bun.file(ownerPath).json() as Partial<LockOwner>;
      if (typeof raw === "object" && raw !== null
        && typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid > 0
        && typeof raw.startedAt === "string"
        && typeof raw.hostname === "string") {
        return raw as LockOwner;
      }
      return undefined;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && attempt < 2) {
        await Bun.sleep(15);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

function activeLockError(destination: string, lock: string, owner?: LockOwner) {
  if (owner) {
    return new BuildLockError(
      `Output ${destination} is locked by an active build (PID ${owner.pid}, started ${owner.startedAt} on ${owner.hostname}). Wait for it to finish, or remove ${lock} if that process is no longer running.`,
    );
  }
  return new BuildLockError(
    `Output ${destination} is locked (${lock}; owner metadata unavailable). Wait for any active build to finish, or remove ${lock} if no build is running.`,
  );
}

async function recoverInterruptedSwap(parent: string, destination: string, prefix: string) {
  const tempDirs = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(parent, entry.name));
  if (tempDirs.length === 0) return;

  if (!(await status(destination))) {
    let bestPath: string | undefined;
    let bestValid = false;
    let bestMtime = -1;
    for (const dir of tempDirs) {
      const previous = join(dir, "previous");
      const info = await status(previous);
      if (!info?.isDirectory()) continue;
      const valid = await isBuildOutput(previous);
      if (bestPath === undefined || (valid && !bestValid) || (valid === bestValid && info.mtimeMs > bestMtime)) {
        bestPath = previous;
        bestValid = valid;
        bestMtime = info.mtimeMs;
      }
    }
    if (bestPath !== undefined) {
      await rename(bestPath, destination);
    }
  }

  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withOutputLock<T>(
  destination: string,
  run: () => Promise<T>,
): Promise<T> {
  const parent = dirname(destination);
  const base = basename(destination);
  const lock = join(parent, `.${base}.filter-build.lock`);
  const ownerPath = join(lock, "owner.json");
  const currentHost = hostname();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(lock, { recursive: false });
      try {
        const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), hostname: currentHost };
        await Bun.write(ownerPath, `${JSON.stringify(owner)}\n`);
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      try {
        await recoverInterruptedSwap(parent, destination, `.${base}.filter-build-`);
        return await run();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const lockInfo = await status(lock);
      if (lockInfo && !lockInfo.isDirectory()) {
        throw new BuildLockError(`Output lock path ${lock} is not a directory. Remove it if no build is running.`);
      }
      const owner = await readLockOwner(ownerPath);
      if (owner && owner.hostname === currentHost && !isProcessAlive(owner.pid)) {
        const stale = join(parent, `.${base}.filter-build.lock.stale-${process.pid}-${crypto.randomUUID()}`);
        try {
          await rename(lock, stale);
          await rm(stale, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError instanceof Error && "code" in renameError && renameError.code === "ENOENT") {
            continue;
          }
          throw renameError;
        }
      }
      throw activeLockError(destination, lock, owner);
    }
  }
  throw activeLockError(destination, lock, await readLockOwner(ownerPath));
}

async function validateOutputPath(root: string, destination: string, host?: string) {
  if (!childPath(root, destination)) {
    throw new Error(`Output must be inside the workspace: ${destination}`);
  }
  await rejectSymlinks(root, destination);
  const hostOutput = host === undefined ? undefined : join(root, "filters", host, "dist");
  if (destination !== hostOutput && (dirname(destination) !== root
    || basename(destination).startsWith(".") || reservedPaths.includes(basename(destination)))) {
    throw new Error(`Output must be a workspace directory outside source directories: ${destination}`);
  }
  if (host !== undefined && destination === hostOutput && !(await status(dirname(destination)))?.isDirectory()) {
    throw new FilterBuildError("INVALID_META", `Unknown host: ${host}`);
  }
}

async function validateOutputDirectory(destination: string) {
  const current = await status(destination);
  if (current && (!current.isDirectory()
    || ((await readdir(destination)).length > 0 && !(await isBuildOutput(destination))))) {
    throw new Error(`Output must be empty or contain only files from a previous build: ${destination}`);
  }
}

async function writeArtifacts(
  destination: string,
  files: Map<string, string>,
  reuseUnchanged = false,
  hooks?: CompileHooks,
) {
  const parent = dirname(destination);
  const temporary = await mkdtemp(join(parent, `.${basename(destination)}.filter-build-`));
  const next = join(temporary, "next");
  const previous = join(temporary, "previous");
  let restorePrevious = false;
  try {
    await validateOutputDirectory(destination);
    for (const [path, content] of files) {
      const source = join(destination, path);
      const target = join(next, path);
      if (reuseUnchanged && (await status(source))?.isFile()
        && Buffer.from(await Bun.file(source).arrayBuffer()).equals(Buffer.from(content))) {
        try {
          await mkdir(dirname(target), { recursive: true });
          await link(source, target);
          continue;
        } catch {
          // Filesystems without hard-link support write a fresh artifact.
        }
      }
      await Bun.write(target, content);
    }
    if (await status(destination)) {
      await rename(destination, previous);
      restorePrevious = true;
    }
    await hooks?.beforeOutputSwap?.();
    await rename(next, destination);
    restorePrevious = false;
  } finally {
    if (restorePrevious) await rename(previous, destination);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function compileWorkspace(
  options: CompileOptions,
  adapter: FilterParserAdapter,
  onlyHost?: string,
  hooks?: CompileHooks,
) {
  const root = await realpath(options.rootDir);
  if (onlyHost !== undefined) {
    const token = splitFilterToken(onlyHost);
    if (token === null || token.variant !== undefined) {
      throw new FilterBuildError("INVALID_META", `Invalid host: ${onlyHost}`);
    }
  }
  const destination = resolve(root, options.outDir);
  await validateOutputPath(root, destination, onlyHost);
  return await withOutputLock(destination, async () => {
    await validateOutputDirectory(destination);
    const cacheEnabled = options.incremental && options.cacheKey !== undefined;
    const cachePath = join(root, ".filter-build-cache", `${digest(relative(root, destination))}.json`);
    const shared = cacheEnabled ? await sharedFingerprint(root) : undefined;
    const previous = cacheEnabled ? await cacheFor(root, cachePath) : undefined;
    const cache = previous !== undefined && previous.shared === shared && previous.key === options.cacheKey
      ? previous
      : undefined;
    const previousEntries = cache === undefined ? undefined : await outputEntries(destination);
    const hosts = new Map<string, HostMeta>();
    const entries = new Map<CanonicalFilterId, CompiledEntry>();
    const files = new Map<string, string>();
    const packages = await readHosts(root, adapter, undefined, cache, previousEntries);
    const selected = onlyHost === undefined
      ? packages
      : packages.filter(({ meta }) => meta.host === onlyHost);
    if (onlyHost !== undefined && selected.length === 0) {
      throw new FilterBuildError("INVALID_META", `Unknown host: ${onlyHost}`);
    }
    const reports = new Map<CanonicalFilterId, LintReport>();
    for (const { meta, fragments } of packages) {
      hosts.set(meta.host, meta);
      for (const fragment of fragments) {
        const id = filterId(meta.host, fragment.variant);
        reports.set(id, fragment.report);
        const fragmentPath = `raw/${meta.host}/${fragment.variant}.txt`;
        entries.set(id, {
          id, host: meta.host, variant: fragment.variant,
          description: fragment.meta.description, tags: fragment.meta.tags,
          resolvedIncludes: fragment.meta.includes ?? [], fragmentPath,
          ruleCount: fragment.report.ruleCount,
          sha256: digest(fragment.content),
        });
        files.set(fragmentPath, fragment.content);
      }
    }
    const aliases = compileAliases([...hosts.values()], entries);
    for (const entry of entries.values()) {
      entry.resolvedIncludes = entry.resolvedIncludes.map((id) => aliases.get(id) ?? id);
    }
    const requested = [...entries.values()]
      .filter((entry) => onlyHost === undefined || entry.host === onlyHost)
      .map((entry) => entry.id);
    const relevant = new Set(orderEntries(requested, entries));
    assertLint([...relevant].map((id) => reports.get(id)!));
    const sets = new Map<string, CompiledSet>();
    const expires = "1 day";
    const directory = join(root, "sets");
    for (const filename of onlyHost === undefined ? await list(root, directory) : []) {
      if (!filename.endsWith(".toml")) continue;
      const path = join(directory, filename);
      const raw = await readText(root, path);
      let set: FilterSetMeta;
      try {
        set = parseFilterSetMeta(Bun.TOML.parse(raw), basename(filename, ".toml"));
      } catch (error) {
        throw new FilterBuildError("INVALID_SET", `${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const members = selectMembers(set, hosts, entries, aliases);
      const ids = orderEntries(members, entries);
      const setPath = `sets/${set.name}.txt`;
      const header = [
        `! Title: ${set.name}`,
        `! Expires: ${expires}`,
        `! Version: ${options.gitSha}`,
        `! Homepage: ${options.homepageUrl}`,
        `! Included: ${ids.join(", ")}`,
      ].join("\n");
      const content = ids.map((id) => files.get(entries.get(id)!.fragmentPath)!)
        .map((fragment) => fragment.replace(/^(?:\[Adblock[^\n]*\]|!\s*(?:Title|Expires|Version|Homepage):[^\n]*)\n/gim, ""));
      files.set(setPath, `${header}\n\n${content.join("")}`);
      sets.set(set.name, { name: set.name, description: set.description, setPath, members });
    }
    if (onlyHost !== undefined) {
      for (const [id, entry] of entries) {
        if (!relevant.has(id)) {
          entries.delete(id);
          files.delete(entry.fragmentPath);
        }
      }
    }
    const manifest: CompiledManifest = {
      version: options.gitSha,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      expires,
      hosts: Object.fromEntries(packages.flatMap(({ meta, fragments }) => {
        const variants = fragments.filter(({ variant }) => entries.has(filterId(meta.host, variant)))
          .map(({ variant }) => variant);
        if (variants.length === 0) return [];
        const defaultVariant = meta.default_variant;
        return [[meta.host, {
          displayName: meta.display_name,
          ...(defaultVariant !== undefined && variants.includes(defaultVariant) ? { defaultVariant } : {}),
          variants,
        }]];
      })),
      sets: Object.fromEntries(sets),
      aliases: Object.fromEntries([...aliases].filter(([, id]) => entries.has(id))),
      entries: Object.fromEntries(entries),
    };
    files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    await writeArtifacts(destination, files, previousEntries !== undefined, hooks);
    if (cacheEnabled) {
      const variants: IncrementalCache["variants"] = {};
      for (const { meta, fragments } of packages) {
        for (const fragment of fragments) {
          if (fragment.report.errors.length === 0) {
            variants[filterId(meta.host, fragment.variant)] = {
              source: fragment.source,
              ruleCount: fragment.report.ruleCount,
            };
          }
        }
      }
      await writeCache(root, cachePath, {
        version: 1,
        shared: shared!,
        key: options.cacheKey!,
        variants,
      });
    }
    return manifest;
  });
}
