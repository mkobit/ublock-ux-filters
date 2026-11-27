import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWorkspace, lintWorkspace } from "./compiler.ts";
import type { FilterParserAdapter, LintOptions } from "./compiler.ts";
import { aglintAdapter } from "./parser-adapter.ts";

const adapter: FilterParserAdapter = {
  async lint(filePath, content) {
    return {
      filePath,
      ruleCount: 1,
      errors: content.includes("BROKEN") ? [{ line: 1, rule: "syntax", message: "Invalid rule" }] : [],
    };
  },
};

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ubouf-builder-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeHost(root: string, host: string, extra = "") {
  await Bun.write(join(root, "filters", host, "filter.toml"), `
host = "${host}"
display_name = "${host}"
allowed_domains = ["${host}"]
default_variant = "dark"
[variants.dark]
file = "dark.ubo"
description = "Dark theme"
tags = ["dark-mode"]
${extra}
`);
  await Bun.write(join(root, "filters", host, "dark.ubo"), `${host}##html:style(color: black;)\n`);
}

async function writeSet(root: string, name: string, mode: string, extra = "") {
  await Bun.write(join(root, "sets", `${name}.toml`), `
name = "${name}"
description = "A subscription list"
mode = "${mode}"
${extra}
`);
}

function build(rootDir: string, outDir = "dist") {
  return compileWorkspace({ rootDir, outDir, gitSha: "demo", homepageUrl: "https://example.org" }, adapter);
}

async function filesIn(directory: string) {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path.slice(directory.length + 1), await Bun.file(path).text());
    }
  }
  return files;
}

test("Reuses validated variants and preserves full-build artifacts after source changes", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    await writeHost(root, "b.example");
    const calls: string[] = [];
    const spy: FilterParserAdapter = {
      async lint(filePath, content) {
        calls.push(filePath);
        return adapter.lint(filePath, content);
      },
    };
    const options = {
      rootDir: root,
      outDir: "incremental",
      gitSha: "demo",
      homepageUrl: "https://example.org",
      generatedAt: "2020-01-01T00:00:00.000Z",
      incremental: true,
      cacheKey: "test-adapter-v1",
    };

    await compileWorkspace(options, spy);
    await compileWorkspace(options, spy);
    expect(calls).toHaveLength(2);
    const unchangedBefore = await lstat(join(root, "incremental/raw/b.example/dark.txt"));
    const changedBefore = await lstat(join(root, "incremental/raw/a.example/dark.txt"));

    await Bun.write(join(root, "filters/a.example/dark.ubo"), "a.example##html:style(color: white;)\n");
    await compileWorkspace(options, spy);
    expect(calls).toHaveLength(3);
    if (process.platform === "linux") {
      expect((await lstat(join(root, "incremental/raw/b.example/dark.txt"))).ino).toBe(unchangedBefore.ino);
      expect((await lstat(join(root, "incremental/raw/a.example/dark.txt"))).ino).not.toBe(changedBefore.ino);
    }

    await compileWorkspace({ ...options, outDir: "full", incremental: false }, adapter);
    expect(await filesIn(join(root, "incremental"))).toEqual(await filesIn(join(root, "full")));
  });
});

test("Rebuilds graph and sets, removes stale artifacts, and invalidates shared inputs", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example", 'includes = ["b.example::dark"]');
    await writeHost(root, "b.example");
    await writeSet(root, "all", "all-defaults");
    const calls: string[] = [];
    const spy: FilterParserAdapter = {
      async lint(filePath, content) {
        calls.push(filePath);
        return adapter.lint(filePath, content);
      },
    };
    const options = {
      rootDir: root,
      outDir: "incremental",
      gitSha: "demo",
      homepageUrl: "https://example.org",
      generatedAt: "2020-01-01T00:00:00.000Z",
      incremental: true,
      cacheKey: "test-adapter-v1",
    };

    await compileWorkspace(options, spy);
    await Bun.write(join(root, "filters/a.example/filter.toml"), `
host = "a.example"
display_name = "A example"
allowed_domains = ["a.example"]
default_variant = "dark"
[variants.dark]
file = "dark.ubo"
description = "Dark theme"
tags = ["dark-mode"]
`);
    await Bun.write(join(root, "sets/all.toml"), `
name = "all"
description = "Changed list"
mode = "explicit"
include = ["a.example"]
`);
    await compileWorkspace(options, spy);
    expect(calls).toHaveLength(2);
    expect((await Bun.file(join(root, "incremental/manifest.json")).json()).sets.all.members)
      .toEqual(["a.example::dark"]);

    await rm(join(root, "filters/b.example"), { recursive: true });
    await compileWorkspace(options, spy);
    expect(calls).toHaveLength(2);
    expect(await Bun.file(join(root, "incremental/raw/b.example/dark.txt")).exists()).toBe(false);

    await Bun.write(join(root, "tsconfig.json"), "{\"compilerOptions\": {}}\n");
    await compileWorkspace(options, spy);
    expect(calls).toHaveLength(3);
    await compileWorkspace({ ...options, outDir: "full", incremental: false }, adapter);
    expect(await filesIn(join(root, "incremental"))).toEqual(await filesIn(join(root, "full")));
  });
});

test("Treats missing and corrupt incremental cache files as cold builds", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    let calls = 0;
    const spy: FilterParserAdapter = {
      async lint(filePath, content) {
        calls += 1;
        return adapter.lint(filePath, content);
      },
    };
    const options = {
      rootDir: root,
      outDir: "incremental",
      gitSha: "demo",
      homepageUrl: "https://example.org",
      generatedAt: "2020-01-01T00:00:00.000Z",
      incremental: true,
      cacheKey: "test-adapter-v1",
    };

    await compileWorkspace(options, spy);
    await rm(join(root, ".filter-build-cache"), { recursive: true });
    await compileWorkspace(options, spy);
    const [cache] = await readdir(join(root, ".filter-build-cache"));
    await Bun.write(join(root, ".filter-build-cache", cache!), "not json");
    await compileWorkspace(options, spy);
    const cachePath = join(root, ".filter-build-cache", cache!);
    const validCache = await Bun.file(cachePath).json();
    validCache.variants["a.example::dark"].ruleCount = 99;
    await Bun.write(cachePath, `${JSON.stringify(validCache)}\n`);
    await compileWorkspace(options, spy);
    expect(calls).toBe(4);
    expect((await Bun.file(join(root, "incremental/manifest.json")).json()).entries["a.example::dark"].ruleCount)
      .toBe(1);
    expect(await Bun.file(join(root, "incremental/manifest.json")).exists()).toBe(true);
  });
});

test("Builds raw files, a manifest, and each set mode in dependency order", async () => {
  await fixture(async (root) => {
    await writeHost(root, "b.example");
    await writeHost(root, "a.example", 'includes = ["b.example::dark"]\n[aliases]\nold = "dark"');
    await writeSet(root, "all", "all-defaults");
    await writeSet(root, "dark-mode", "tag", 'tag = "dark-mode"\nexclude = ["a.example"]');
    await writeSet(root, "manual", "explicit", 'include = ["a.example::old"]');
    const manifest = await build(root);

    expect(manifest.aliases).toEqual({ "a.example::old": "a.example::dark" });
    expect(manifest.sets.all?.members).toEqual(["a.example::dark", "b.example::dark"]);
    expect(manifest.sets["dark-mode"]?.members).toEqual(["b.example::dark"]);
    expect(manifest.sets.manual?.members).toEqual(["a.example::dark"]);
    expect(await Bun.file(join(root, "dist/manifest.json")).json()).toEqual(manifest);
    expect(await Bun.file(join(root, "dist/raw/a.example/dark.txt")).text())
      .toBe("a.example##html:style(color: black;)\n");
    const list = await Bun.file(join(root, "dist/sets/manual.txt")).text();
    expect(list).toStartWith("! Title:");
    expect(list).toContain("! Expires: 1 day");
    expect(list).toContain("b.example##html:style(color: black;)\na.example##html:style(color: black;)");

    await rm(join(root, "sets/manual.toml"));
    await build(root);
    expect(await Bun.file(join(root, "dist/sets/manual.txt")).exists()).toBe(false);
  });
});

test("Keeps existing results when lint fails", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    await build(root);
    await Bun.write(join(root, "filters/a.example/dark.ubo"), "BROKEN");
    await expect(build(root)).rejects.toMatchObject({ code: "LINT_FAILED" });
    expect(await Bun.file(join(root, "dist/raw/a.example/dark.txt")).text())
      .toBe("a.example##html:style(color: black;)\n");
  });
});

test.each([
  ['includes = ["a.example::dark"]', "INCLUDE_CYCLE"],
  ['includes = ["b.example::dark"]', "MISSING_INCLUDE"],
  ['[aliases]\nold = "missing"', "ALIAS_CONFLICT"],
  ['[aliases]\ndark = "dark"', "ALIAS_CONFLICT"],
  ['[aliases]\nold = "older"\nolder = "dark"', "ALIAS_CONFLICT"],
] as const)("Rejects invalid graph data %s", async (extra, code) => {
  await fixture(async (root) => {
    await writeHost(root, "a.example", extra);
    await expect(build(root)).rejects.toMatchObject({ code });
    expect(await Bun.file(join(root, "dist/manifest.json")).exists()).toBe(false);
  });
});

test("Rejects unknown set references", async () => {
  await fixture(async (root) => {
    await writeSet(root, "manual", "explicit", 'include = ["a.example::missing"]');
    await expect(build(root)).rejects.toMatchObject({ code: "INVALID_SET" });
  });
});

test("Rejects output outside the workspace or in an unrelated directory", async () => {
  await fixture(async (root) => {
    await Bun.write(join(root, "unrelated/file.txt"), "Keep me");
    for (const destination of [".", "../outside", "filters/out", "unrelated"]) {
      await expect(build(root, destination)).rejects.toThrow(/output/i);
    }
    expect(await Bun.file(join(root, "unrelated/file.txt")).text()).toBe("Keep me");
  });
});

test("Rejects source files and output parents reached through symlinks", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    await Bun.write(join(root, "outside.ubo"), "Other source");
    await rm(join(root, "filters/a.example/dark.ubo"));
    await symlink(join(root, "outside.ubo"), join(root, "filters/a.example/dark.ubo"));
    await expect(build(root)).rejects.toThrow(/symbolic link/i);
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "linked"));
    await expect(build(root, "linked/out")).rejects.toThrow(/symbolic link/i);
  });
});

test("Builds a selected host and its includes without emitting unrelated hosts or sets", async () => {
  await fixture(async (rootDir) => {
    await writeHost(rootDir, "a.example", 'includes = ["b.example::dark"]');
    await writeHost(rootDir, "b.example");
    await writeHost(rootDir, "c.example");
    await Bun.write(join(rootDir, "filters/c.example/dark.ubo"), "BROKEN");
    await writeSet(rootDir, "all", "all-defaults");
    const manifest = await compileWorkspace({
      rootDir, outDir: "dist", gitSha: "demo", homepageUrl: "https://example.org",
    }, adapter, "a.example");
    expect(Object.keys(manifest.entries)).toEqual(["a.example::dark", "b.example::dark"]);
    expect(Object.keys(manifest.hosts)).toEqual(["a.example", "b.example"]);
    expect(manifest.sets).toEqual({});
    expect(await Bun.file(join(rootDir, "dist/raw/c.example/dark.txt")).exists()).toBe(false);
  });
});

test("Isolates host builds from unrelated missing fragments while preserving cross-host includes and aliases", async () => {
  await fixture(async (rootDir) => {
    await writeHost(rootDir, "a.example", 'includes = ["old.example::dark"]');
    await Bun.write(join(rootDir, "filters/b.example/filter.toml"), `
host = "b.example"
display_name = "b.example"
allowed_domains = ["b.example"]
default_variant = "dark"
[aliases]
"old.example::dark" = "dark"
[variants.dark]
file = "dark.ubo"
description = "Dark theme"
tags = ["dark-mode"]
[variants.extra]
file = "extra.ubo"
description = "Extra theme"
tags = []
`);
    await Bun.write(join(rootDir, "filters/b.example/dark.ubo"), "b.example##html:style(color: black;)\n");
    await writeHost(rootDir, "c.example");
    await rm(join(rootDir, "filters/c.example/dark.ubo"));

    const manifest = await compileWorkspace({
      rootDir, outDir: "dist", gitSha: "demo", homepageUrl: "https://example.org",
    }, adapter, "a.example");

    expect(Object.keys(manifest.entries)).toEqual(["a.example::dark", "b.example::dark"]);
    expect(manifest.entries["a.example::dark"]?.resolvedIncludes).toEqual(["b.example::dark"]);
    expect(manifest.aliases).toEqual({ "old.example::dark": "b.example::dark" });
    expect(manifest.hosts["b.example"]?.variants).toEqual(["dark"]);
    expect(await Bun.file(join(rootDir, "dist/raw/c.example/dark.txt")).exists()).toBe(false);
    expect(await Bun.file(join(rootDir, "dist/raw/b.example/extra.txt")).exists()).toBe(false);

    await expect(build(rootDir, "full-dist")).rejects.toThrow(/regular file/i);
  });
});

test.each([
  { label: "selected host fragment", missingPath: "filters/a.example/dark.ubo" },
  { label: "included host fragment", missingPath: "filters/b.example/dark.ubo" },
])("Fails host build when $label is missing", async ({ missingPath }) => {
  await fixture(async (rootDir) => {
    await writeHost(rootDir, "a.example", 'includes = ["b.example::dark"]');
    await writeHost(rootDir, "b.example");
    await rm(join(rootDir, missingPath));

    await expect(compileWorkspace({
      rootDir, outDir: "dist", gitSha: "demo", homepageUrl: "https://example.org",
    }, adapter, "a.example")).rejects.toThrow(/regular file/i);
  });
});

test("Resolves aliases for retired hosts in set selections and includes", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example", 'includes = ["old.example::dark"]');
    await writeHost(root, "b.example", '[aliases]\n"old.example::dark" = "dark"');
    await writeSet(root, "manual", "explicit", 'include = ["old.example::dark", "a.example"]');
    const manifest = await build(root);
    expect(manifest.entries["a.example::dark"]?.resolvedIncludes).toEqual(["b.example::dark"]);
    expect(manifest.sets.manual?.members).toEqual(["a.example::dark", "b.example::dark"]);
  });
});

test("Protects unrelated files and rejects a competing output lock", async () => {
  await fixture(async (root) => {
    await build(root);
    await Bun.write(join(root, "dist/unrelated.txt"), "Keep me");
    await expect(build(root)).rejects.toThrow(/previous build/i);
    expect(await Bun.file(join(root, "dist/unrelated.txt")).text()).toBe("Keep me");
    await rm(join(root, "dist/unrelated.txt"));
    await mkdir(join(root, ".dist.filter-build.lock"));
    await expect(build(root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await Bun.file(join(root, "dist/manifest.json")).exists()).toBe(true);
  });
});

test("Recovers the last valid output after an interruption between renames and permits a later build", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    await writeSet(root, "all", "all-defaults");
    await compileWorkspace({
      rootDir: root,
      outDir: "dist",
      gitSha: "v1",
      homepageUrl: "https://example.org",
      generatedAt: "2020-01-01T00:00:00.000Z",
    }, adapter);

    await Bun.write(join(root, "filters/a.example/dark.ubo"), "a.example##html:style(color: white;)\n");
    const compilerPath = fileURLToPath(new URL("./compiler.ts", import.meta.url));
    const script = `
      import { compileWorkspace } from ${JSON.stringify(compilerPath)};
      const adapter = {
        async lint(filePath) {
          return { filePath, ruleCount: 1, errors: [] };
        },
      };
      await compileWorkspace(
        { rootDir: ${JSON.stringify(root)}, outDir: "dist", gitSha: "v2", homepageUrl: "https://example.org" },
        adapter,
        undefined,
        { beforeOutputSwap: () => { process.exit(1); } },
      );
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(1);

    expect(await Bun.file(join(root, "dist/manifest.json")).exists()).toBe(false);
    expect(await Bun.file(join(root, ".dist.filter-build.lock/owner.json")).exists()).toBe(true);
    const entriesAfterCrash = await readdir(root);
    expect(entriesAfterCrash.some((name) => name.startsWith(".dist.filter-build-"))).toBe(true);

    // Even if the next build fails lint, the interrupted previous output is recovered.
    await Bun.write(join(root, "filters/a.example/dark.ubo"), "BROKEN");
    await expect(build(root)).rejects.toMatchObject({ code: "LINT_FAILED" });
    expect((await Bun.file(join(root, "dist/manifest.json")).json()).version).toBe("v1");
    expect(await Bun.file(join(root, "dist/raw/a.example/dark.txt")).text())
      .toBe("a.example##html:style(color: black;)\n");
    expect(await Bun.file(join(root, ".dist.filter-build.lock")).exists()).toBe(false);

    // A subsequent valid build completes cleanly.
    await Bun.write(join(root, "filters/a.example/dark.ubo"), "a.example##html:style(color: white;)\n");
    const manifest = await compileWorkspace({
      rootDir: root,
      outDir: "dist",
      gitSha: "v2",
      homepageUrl: "https://example.org",
    }, adapter);
    expect(manifest.version).toBe("v2");
    expect(await Bun.file(join(root, "dist/raw/a.example/dark.txt")).text())
      .toBe("a.example##html:style(color: white;)\n");
    const entriesAfterRecovery = await readdir(root);
    expect(entriesAfterRecovery.some((name) => name.startsWith(".dist.filter-build"))).toBe(false);
  });
});

test("Gives an actionable diagnostic for an active lock owner and preserves simultaneous writer integrity", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    await writeSet(root, "all", "all-defaults");

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const blockingAdapter: FilterParserAdapter = {
      async lint(filePath, content) {
        markFirstEntered();
        await firstGate;
        return adapter.lint(filePath, content);
      },
    };

    const firstBuild = compileWorkspace({
      rootDir: root,
      outDir: "dist",
      gitSha: "first",
      homepageUrl: "https://example.org",
    }, blockingAdapter);
    await firstEntered;

    let caught: unknown;
    try {
      await compileWorkspace({
        rootDir: root,
        outDir: "dist",
        gitSha: "second",
        homepageUrl: "https://example.org",
      }, adapter);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ code: "EEXIST" });
    const message = (caught as Error).message;
    expect(message).toContain(`PID ${process.pid}`);
    expect(message).toContain(".dist.filter-build.lock");
    expect(message).toContain("dist");

    releaseFirst();
    const manifest = await firstBuild;
    expect(manifest.version).toBe("first");
    expect((await Bun.file(join(root, "dist/manifest.json")).json()).version).toBe("first");
    expect(await Bun.file(join(root, "dist/raw/a.example/dark.txt")).text())
      .toBe("a.example##html:style(color: black;)\n");
    expect(await Bun.file(join(root, "dist/sets/all.txt")).exists()).toBe(true);
    expect((await readdir(root)).some((name) => name.startsWith(".dist.filter-build"))).toBe(false);
  });
});

test("Passes allowed_domains from filter.toml to adapter.lint and rejects out-of-scope cosmetic rules", async () => {
  await fixture(async (root) => {
    await writeHost(root, "a.example");
    const seenOptions: Array<LintOptions | undefined> = [];
    const spy: FilterParserAdapter = {
      async lint(filePath, content, options) {
        seenOptions.push(options);
        return aglintAdapter.lint(filePath, content, options);
      },
    };

    await lintWorkspace(root, spy);
    expect(seenOptions).toEqual([{ allowedDomains: ["a.example"] }]);

    await Bun.write(join(root, "filters/a.example/dark.ubo"), "! header\n##.global-rule\n");
    await expect(lintWorkspace(root, aglintAdapter)).rejects.toMatchObject({
      code: "LINT_FAILED",
      message: expect.stringContaining(":2 [domain-scope]"),
    });
  });
});
