import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkspace } from "@ubdf/builder/compiler";
import type { FilterParserAdapter } from "@ubdf/builder/compiler";
import {
  classifyChangedPaths,
  isTargetEnabledForCi,
  selectCapturePlan,
} from "./diff-select.ts";
import type { DiffSelectDependencies } from "./diff-select.ts";

const tempDirs: string[] = [];

function createTempDir(prefix = "ubouf-diff-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface HostFixture {
  host: string;
  previewCi?: boolean;
  targets: Array<{ url: string; label: string; ci?: boolean; wait_for?: string }>;
  variants: Record<string, { file: string; compiledText: string }>;
}

function writeWorkspaceFixture(rootDir: string, hosts: HostFixture[]): void {
  for (const h of hosts) {
    const hostDir = join(rootDir, "filters", h.host);
    mkdirSync(hostDir, { recursive: true });

    const variantLines = Object.entries(h.variants).map(
      ([name, v]) => `[variants.${name}]
file = "${v.file}"
description = "Variant ${name}"
tags = []`,
    );

    const targetLines = h.targets.map((t) => {
      const lines = [
        "[[preview.targets]]",
        `url = "${t.url}"`,
        `label = "${t.label}"`,
      ];
      if (t.ci !== undefined) lines.push(`ci = ${String(t.ci)}`);
      if (t.wait_for !== undefined) lines.push(`wait_for = "${t.wait_for}"`);
      return lines.join("\n");
    });

    const previewHeader = [
      "[preview]",
      ...(h.previewCi !== undefined ? [`ci = ${String(h.previewCi)}`] : []),
    ].join("\n");

    const toml = `host = "${h.host}"
display_name = "${h.host}"
allowed_domains = ["${h.host}"]

${variantLines.join("\n\n")}

${previewHeader}

${targetLines.join("\n\n")}
`;
    writeFileSync(join(hostDir, "filter.toml"), toml, "utf8");

    const rawDir = join(rootDir, "dist", "raw", h.host);
    mkdirSync(rawDir, { recursive: true });
    for (const [name, v] of Object.entries(h.variants)) {
      writeFileSync(join(rawDir, `${name}.txt`), v.compiledText, "utf8");
    }
  }
}

describe("isTargetEnabledForCi (host-level opt-out precedence)", () => {
  const cases: Array<{ hostCi: boolean | undefined; targetCi: boolean | undefined; expected: boolean }> = [
    { hostCi: undefined, targetCi: undefined, expected: true },
    { hostCi: undefined, targetCi: true, expected: true },
    { hostCi: undefined, targetCi: false, expected: false },
    { hostCi: true, targetCi: undefined, expected: true },
    { hostCi: true, targetCi: true, expected: true },
    { hostCi: true, targetCi: false, expected: false },
    { hostCi: false, targetCi: undefined, expected: false },
    { hostCi: false, targetCi: true, expected: false },
    { hostCi: false, targetCi: false, expected: false },
  ];

  for (const c of cases) {
    test(`host=${String(c.hostCi)}, target=${String(c.targetCi)} -> ${String(c.expected)}`, () => {
      expect(isTargetEnabledForCi(c.hostCi, c.targetCi)).toBe(c.expected);
    });
  }
});

describe("classifyChangedPaths", () => {
  test("classifies shared build inputs, filter.toml, .ubo files, and ignores docs", () => {
    const result = classifyChangedPaths([
      "README.md",
      "docs/designs/foo.md",
      "filters/news.ycombinator.com/README.md",
      "filters/news.ycombinator.com/assets/demo.png",
      "filters/news.ycombinator.com/dark.ubo",
      "filters/ebay.com/filter.toml",
      "packages/builder/src/compiler.ts",
    ]);

    expect(result.hasSharedBuildChange).toBe(true);
    expect(Array.from(result.changedTomlHosts)).toEqual(["ebay.com"]);
    expect(Array.from(result.changedUboFilesByHost.get("news.ycombinator.com") ?? [])).toEqual([
      "dark.ubo",
    ]);
  });
});

describe("selectCapturePlan", () => {
  test("docs-only change selects none and skips base checkout", async () => {
    const headRoot = createTempDir("ubouf-head-");
    writeWorkspaceFixture(headRoot, [
      {
        host: "example.com",
        targets: [{ url: "https://example.com/", label: "home" }],
        variants: { dark: { file: "dark.ubo", compiledText: "example.com##body\n" } },
      },
    ]);

    let baseCheckoutCalled = false;
    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => ["README.md", "filters/example.com/README.md"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => {
        baseCheckoutCalled = true;
        throw new Error("should not be called");
      },
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    expect(plan.targets).toEqual([]);
    expect(baseCheckoutCalled).toBe(false);
    plan.cleanup();
  });

  test("shared build change selects only existing variants whose compiled rules changed", async () => {
    const headRoot = createTempDir("ubouf-head-");
    const baseRoot = createTempDir("ubouf-base-");

    writeWorkspaceFixture(headRoot, [
      {
        host: "alpha.example",
        targets: [{ url: "https://alpha.example/", label: "home" }],
        variants: { dark: { file: "dark.ubo", compiledText: "! updated header\nalpha.example##body\n" } },
      },
      {
        host: "beta.example",
        targets: [{ url: "https://beta.example/", label: "home" }],
        variants: { dark: { file: "dark.ubo", compiledText: "beta.example##body\n" } },
      },
    ]);

    writeWorkspaceFixture(baseRoot, [
      {
        host: "alpha.example",
        targets: [{ url: "https://alpha.example/", label: "home" }],
        variants: { dark: { file: "dark.ubo", compiledText: "! old header\nalpha.example##body\n" } },
      },
      {
        host: "beta.example",
        targets: [{ url: "https://beta.example/", label: "home" }],
        variants: { dark: { file: "dark.ubo", compiledText: "beta.example##body\n" } },
      },
    ]);

    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => ["packages/builder/src/compiler.ts"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    expect(plan.targets).toEqual([
      {
        kind: "capture",
        host: "alpha.example",
        variant: "dark",
        label: "home",
        url: "https://alpha.example/",
        panelsMode: "3-way",
        prFilterPath: join(headRoot, "dist", "raw", "alpha.example", "dark.txt"),
        baseFilterPath: join(baseRoot, "dist", "raw", "alpha.example", "dark.txt"),
      },
    ]);
    plan.cleanup();
  });

  test("new variant selects 2-way (raw and pr) when absent from base build", async () => {
    const headRoot = createTempDir("ubouf-head-");
    const baseRoot = createTempDir("ubouf-base-");

    writeWorkspaceFixture(headRoot, [
      {
        host: "example.com",
        targets: [{ url: "https://example.com/", label: "home" }],
        variants: {
          existing: { file: "existing.ubo", compiledText: "example.com##body\n" },
          "brand-new": { file: "brand-new.ubo", compiledText: "example.com##main\n" },
        },
      },
    ]);

    writeWorkspaceFixture(baseRoot, [
      {
        host: "example.com",
        targets: [{ url: "https://example.com/", label: "home" }],
        variants: {
          existing: { file: "existing.ubo", compiledText: "example.com##body\n" },
        },
      },
    ]);

    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => [
        "filters/example.com/filter.toml",
        "filters/example.com/brand-new.ubo",
      ],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    const byVariant = new Map(plan.targets.map((t) => [t.variant, t]));
    expect(byVariant.get("brand-new")).toMatchObject({
      kind: "capture",
      panelsMode: "2-way",
    });
    expect(byVariant.get("existing")).toMatchObject({
      kind: "capture",
      panelsMode: "3-way",
    });
    plan.cleanup();
  });

  test("preview target url and wait_for changes select host variants even when filter rules do not change", async () => {
    const headRoot = createTempDir("ubouf-head-");
    const baseRoot = createTempDir("ubouf-base-");

    writeWorkspaceFixture(headRoot, [
      {
        host: "example.com",
        targets: [
          { url: "https://example.com/v2", label: "home", wait_for: ".new-selector" },
        ],
        variants: { dark: { file: "dark.ubo", compiledText: "example.com##body\n" } },
      },
    ]);

    writeWorkspaceFixture(baseRoot, [
      {
        host: "example.com",
        targets: [
          { url: "https://example.com/v1", label: "home", wait_for: ".old-selector" },
        ],
        variants: { dark: { file: "dark.ubo", compiledText: "example.com##body\n" } },
      },
    ]);

    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => ["filters/example.com/filter.toml"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    expect(plan.targets).toEqual([
      {
        kind: "capture",
        host: "example.com",
        variant: "dark",
        label: "home",
        url: "https://example.com/v2",
        waitFor: ".new-selector",
        panelsMode: "3-way",
        prFilterPath: join(headRoot, "dist", "raw", "example.com", "dark.txt"),
        baseFilterPath: join(baseRoot, "dist", "raw", "example.com", "dark.txt"),
      },
    ]);
    plan.cleanup();
  });

  test("detects removed variants and removed preview targets", async () => {
    const headRoot = createTempDir("ubouf-head-");
    const baseRoot = createTempDir("ubouf-base-");

    writeWorkspaceFixture(headRoot, [
      {
        host: "example.com",
        targets: [{ url: "https://example.com/kept", label: "kept" }],
        variants: {
          kept: { file: "kept.ubo", compiledText: "example.com##body\n" },
        },
      },
    ]);

    writeWorkspaceFixture(baseRoot, [
      {
        host: "example.com",
        targets: [
          { url: "https://example.com/kept", label: "kept" },
          { url: "https://example.com/dropped", label: "dropped" },
        ],
        variants: {
          kept: { file: "kept.ubo", compiledText: "example.com##body\n" },
          legacy: { file: "legacy.ubo", compiledText: "example.com##footer\n" },
        },
      },
    ]);

    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => ["filters/example.com/filter.toml"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    expect(plan.targets).toEqual([
      {
        kind: "capture",
        host: "example.com",
        variant: "kept",
        label: "kept",
        url: "https://example.com/kept",
        panelsMode: "3-way",
        prFilterPath: join(headRoot, "dist", "raw", "example.com", "kept.txt"),
        baseFilterPath: join(baseRoot, "dist", "raw", "example.com", "kept.txt"),
      },
      {
        kind: "removed",
        host: "example.com",
        variant: "kept",
        label: "dropped",
        url: "https://example.com/dropped",
      },
      {
        kind: "removed",
        host: "example.com",
        variant: "legacy",
        label: "kept",
        url: "https://example.com/kept",
      },
      {
        kind: "removed",
        host: "example.com",
        variant: "legacy",
        label: "dropped",
        url: "https://example.com/dropped",
      },
    ]);
    plan.cleanup();
  });

  test("applies host/target ci flags only in --ci mode and runs all targets locally", async () => {
    const headRoot = createTempDir("ubouf-head-");
    writeWorkspaceFixture(headRoot, [
      {
        host: "host-disabled.example",
        previewCi: false,
        targets: [
          { url: "https://host-disabled.example/a", label: "a", ci: true },
          { url: "https://host-disabled.example/b", label: "b" },
        ],
        variants: { dark: { file: "dark.ubo", compiledText: "host-disabled.example##body\n" } },
      },
      {
        host: "mixed.example",
        targets: [
          { url: "https://mixed.example/on", label: "on" },
          { url: "https://mixed.example/off", label: "off", ci: false },
        ],
        variants: { dark: { file: "dark.ubo", compiledText: "mixed.example##body\n" } },
      },
    ]);

    const deps: DiffSelectDependencies = { buildFilters: async () => {} };

    const ciPlan = await selectCapturePlan({ rootDir: headRoot, ci: true }, deps);
    expect(ciPlan.targets.map((t) => `${t.host}/${t.label}:${t.kind}`)).toEqual([
      "host-disabled.example/a:skipped_by_config",
      "host-disabled.example/b:skipped_by_config",
      "mixed.example/on:capture",
      "mixed.example/off:skipped_by_config",
    ]);

    const localPlan = await selectCapturePlan({ rootDir: headRoot, ci: false }, deps);
    expect(localPlan.targets.map((t) => `${t.host}/${t.label}:${t.kind}`)).toEqual([
      "host-disabled.example/a:capture",
      "host-disabled.example/b:capture",
      "mixed.example/on:capture",
      "mixed.example/off:capture",
    ]);
  });

  test("changing an included fragment selects affected dependent variants for capture", async () => {
    const testAdapter: FilterParserAdapter = {
      async lint(filePath, content) {
        return { filePath, ruleCount: content.trim() ? 1 : 0, errors: [] };
      },
    };

    const headRoot = createTempDir("ubouf-head-");
    const baseRoot = createTempDir("ubouf-base-");

    const writeRepo = (root: string, leafRule: string): void => {
      mkdirSync(join(root, "filters", "leaf.example"), { recursive: true });
      writeFileSync(
        join(root, "filters", "leaf.example", "filter.toml"),
        `host = "leaf.example"
display_name = "Leaf"
allowed_domains = ["leaf.example"]

[variants.base]
file = "base.ubo"
description = "Leaf base"
tags = []
`,
        "utf8",
      );
      writeFileSync(join(root, "filters", "leaf.example", "base.ubo"), `${leafRule}\n`, "utf8");

      mkdirSync(join(root, "filters", "mid.example"), { recursive: true });
      writeFileSync(
        join(root, "filters", "mid.example", "filter.toml"),
        `host = "mid.example"
display_name = "Mid"
allowed_domains = ["mid.example"]

[variants.shared]
file = "shared.ubo"
description = "Mid shared"
tags = []
includes = ["leaf.example::base"]
`,
        "utf8",
      );
      writeFileSync(join(root, "filters", "mid.example", "shared.ubo"), "mid.example##.mid\n", "utf8");

      mkdirSync(join(root, "filters", "dependent.example"), { recursive: true });
      writeFileSync(
        join(root, "filters", "dependent.example", "filter.toml"),
        `host = "dependent.example"
display_name = "Dependent"
allowed_domains = ["dependent.example"]

[variants.dark]
file = "dark.ubo"
description = "Dependent dark"
tags = []
includes = ["mid.example::shared"]

[preview]
ci = true

[[preview.targets]]
url = "https://dependent.example/"
label = "home"
`,
        "utf8",
      );
      writeFileSync(join(root, "filters", "dependent.example", "dark.ubo"), "dependent.example##body\n", "utf8");

      mkdirSync(join(root, "filters", "unrelated.example"), { recursive: true });
      writeFileSync(
        join(root, "filters", "unrelated.example", "filter.toml"),
        `host = "unrelated.example"
display_name = "Unrelated"
allowed_domains = ["unrelated.example"]

[variants.dark]
file = "dark.ubo"
description = "Unrelated dark"
tags = []

[preview]
ci = true

[[preview.targets]]
url = "https://unrelated.example/"
label = "home"
`,
        "utf8",
      );
      writeFileSync(join(root, "filters", "unrelated.example", "dark.ubo"), "unrelated.example##body\n", "utf8");
    };

    writeRepo(headRoot, "leaf.example##.v2");
    writeRepo(baseRoot, "leaf.example##.v1");

    await compileWorkspace(
      { rootDir: headRoot, outDir: "dist", gitSha: "head", homepageUrl: "https://example.org" },
      testAdapter,
    );
    await compileWorkspace(
      { rootDir: baseRoot, outDir: "dist", gitSha: "base", homepageUrl: "https://example.org" },
      testAdapter,
    );

    const deps: DiffSelectDependencies = {
      getChangedFiles: async () => ["filters/leaf.example/base.ubo"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
    };

    const plan = await selectCapturePlan({ rootDir: headRoot, baseRef: "main", ci: true }, deps);
    expect(plan.targets).toEqual([
      {
        kind: "capture",
        host: "dependent.example",
        variant: "dark",
        label: "home",
        url: "https://dependent.example/",
        panelsMode: "3-way",
        prFilterPath: join(headRoot, "dist", "raw", "dependent.example", "dark.txt"),
        baseFilterPath: join(baseRoot, "dist", "raw", "dependent.example", "dark.txt"),
      },
    ]);
    plan.cleanup();
  });
});
