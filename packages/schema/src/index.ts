export type CanonicalFilterId = `${string}::${string}`;

export interface VariantMeta {
  file: string;
  description: string;
  tags: string[];
  includes?: CanonicalFilterId[];
}

export interface HostMeta {
  host: string;
  display_name: string;
  allowed_domains: string[];
  default_variant?: string;
  variants: Record<string, VariantMeta>;
  aliases?: Record<string, string>;
}

export interface FilterSetMeta {
  name: string;
  description: string;
  mode: "all-defaults" | "tag" | "explicit";
  tag?: string;
  include?: string[];
  exclude?: string[];
}

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isHost(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => hostLabel.test(label));
}

function invalid(field: string, expected: string): never {
  throw new TypeError(`${field} must be ${expected}`);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return invalid(field, "a table");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(field, "a table");
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(field, "a nonempty string");
  }
  return value;
}

function readList<T>(
  value: unknown,
  field: string,
  readItem: (value: unknown, field: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    return invalid(field, "an array");
  }
  return Array.from(value, (item: unknown, index) => readItem(item, `${field}[${index}]`));
}

export function splitFilterToken(raw: string): { host: string; variant?: string } | null {
  const [host, variant, extra] = raw.split("::");
  if (host === undefined || !isHost(host) || extra !== undefined) {
    return null;
  }
  if (variant === undefined) {
    return { host };
  }
  return slug.test(variant) ? { host, variant } : null;
}

function readFilterToken(value: unknown, field: string): string {
  const token = readText(value, field);
  if (splitFilterToken(token) === null) {
    return invalid(field, "a host or host::variant");
  }
  return token;
}

function readInclude(value: unknown, field: string): CanonicalFilterId {
  const token = splitFilterToken(readText(value, field));
  if (token?.variant === undefined) {
    return invalid(field, "a host::variant");
  }
  return `${token.host}::${token.variant}`;
}

function readVariant(value: unknown, field: string): VariantMeta {
  const raw = readRecord(value, field);
  const file = readText(raw.file, `${field}.file`);
  if (
    !file.endsWith(".ubo") ||
    /[\\:\u0000-\u001f]/.test(file) ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return invalid(`${field}.file`, "a relative .ubo path inside the host directory");
  }

  const result: VariantMeta = {
    file,
    description: readText(raw.description, `${field}.description`),
    tags: readList(raw.tags, `${field}.tags`, readText),
  };
  if (raw.includes !== undefined) {
    result.includes = readList(raw.includes, `${field}.includes`, readInclude);
  }
  return result;
}

function readAlias(value: unknown, field: string): string {
  const alias = readText(value, field);
  if (!slug.test(alias) && splitFilterToken(alias)?.variant === undefined) {
    return invalid(field, "a variant or host::variant");
  }
  return alias;
}

export function parseHostMeta(value: unknown, dirHost: string): HostMeta {
  const raw = readRecord(value, "Host descriptor");
  const host = readText(raw.host, "host");
  if (!isHost(host) || host !== dirHost) {
    return invalid("host", "a hostname that matches its directory name");
  }

  const entries = Object.entries(readRecord(raw.variants, "variants"));
  if (entries.length === 0) {
    return invalid("variants", "a table with at least one variant");
  }
  const variants = Object.fromEntries(entries.map(([name, variant]) => {
    if (!slug.test(name)) {
      return invalid(`variants.${name}`, "a lowercase variant identifier");
    }
    return [name, readVariant(variant, `variants.${name}`)];
  }));

  const allowedDomains = readList(raw.allowed_domains, "allowed_domains", readText);
  if (allowedDomains.length === 0) {
    return invalid("allowed_domains", "an array with at least one domain");
  }
  const result: HostMeta = {
    host,
    display_name: readText(raw.display_name, "display_name"),
    allowed_domains: allowedDomains,
    variants,
  };
  if (raw.default_variant !== undefined) {
    const name = readText(raw.default_variant, "default_variant");
    if (!Object.hasOwn(variants, name)) {
      return invalid("default_variant", "a variant in this descriptor");
    }
    result.default_variant = name;
  }
  if (raw.aliases !== undefined) {
    result.aliases = Object.fromEntries(
      Object.entries(readRecord(raw.aliases, "aliases")).map(([source, target]) => [
        readAlias(source, `aliases.${source}`),
        readAlias(target, `aliases.${source}`),
      ]),
    );
  }
  return result;
}

export function parseFilterSetMeta(value: unknown, fileStem: string): FilterSetMeta {
  const raw = readRecord(value, "Set descriptor");
  const name = readText(raw.name, "name");
  if (!slug.test(name) || name !== fileStem) {
    return invalid("name", "a lowercase set identifier that matches its file name");
  }

  const mode = raw.mode;
  if (mode !== "all-defaults" && mode !== "tag" && mode !== "explicit") {
    return invalid("mode", "all-defaults, tag, or explicit");
  }

  const result: FilterSetMeta = {
    name,
    description: readText(raw.description, "description"),
    mode,
  };
  if (mode === "tag" || raw.tag !== undefined) {
    result.tag = readText(raw.tag, "tag");
  }
  if (raw.include !== undefined) {
    result.include = readList(raw.include, "include", readFilterToken);
  }
  if (raw.exclude !== undefined) {
    result.exclude = readList(raw.exclude, "exclude", readFilterToken);
  }
  return result;
}
