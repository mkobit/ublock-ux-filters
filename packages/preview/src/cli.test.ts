import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostMeta } from "@ubdf/schema";
import {
  loadPreviewConfig,
  parsePreviewArgs,
  resolveVariantName,
  runCli,
  runPreview,
} from "./cli.ts";
import type { PreviewDependencies } from "./cli.ts";
import type { BrowserSession, PrepareSessionOptions } from "./session.ts";

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubouf-cli-test-"));
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

describe("parsePreviewArgs", () => {
  test("parses required --host flag with defaults", () => {
    expect(parsePreviewArgs(["preview", "--host", "news.ycombinator.com"])).toEqual({
      command: "preview",
      host: "news.ycombinator.com",
      keepProfile: false,
    });
  });

  test("parses --variant and --keep-profile in any order", () => {
    expect(
      parsePreviewArgs([
        "preview",
        "--keep-profile",
        "--variant",
        "dark-mode-github-dark",
        "--host",
        "ebay.com",
      ]),
    ).toEqual({
      command: "preview",
      host: "ebay.com",
      variant: "dark-mode-github-dark",
      keepProfile: true,
    });
  });

  test("rejects missing or unknown subcommand", () => {
    expect(() => parsePreviewArgs([])).toThrow(/Usage: preview/);
    expect(() => parsePreviewArgs(["capture", "--host", "ebay.com"])).toThrow(/Usage: preview/);
  });

  test("rejects missing --host, missing values, duplicate flags, and unknown flags", () => {
    expect(() => parsePreviewArgs(["preview"])).toThrow(/Usage: preview/);
    expect(() => parsePreviewArgs(["preview", "--host"])).toThrow(/Usage: preview/);
    expect(() => parsePreviewArgs(["preview", "--host", "--keep-profile"])).toThrow(/Usage: preview/);
    expect(() => parsePreviewArgs(["preview", "--host", "ebay.com", "--variant"])).toThrow(
      /Usage: preview/,
    );
    expect(() =>
      parsePreviewArgs(["preview", "--host", "a.com", "--host", "b.com"]),
    ).toThrow(/Usage: preview/);
    expect(() =>
      parsePreviewArgs(["preview", "--host", "a.com", "--variant", "x", "--variant", "y"]),
    ).toThrow(/Usage: preview/);
    expect(() =>
      parsePreviewArgs(["preview", "--host", "a.com", "--keep-profile", "--keep-profile"]),
    ).toThrow(/Usage: preview/);
    expect(() => parsePreviewArgs(["preview", "--host", "a.com", "--unknown"])).toThrow(
      /Usage: preview/,
    );
  });
});

describe("resolveVariantName", () => {
  const baseMeta: HostMeta = {
    host: "example.com",
    display_name: "Example",
    allowed_domains: ["example.com"],
    variants: {
      alpha: { file: "alpha.ubo", description: "Alpha", tags: [] },
      beta: { file: "beta.ubo", description: "Beta", tags: [] },
    },
  };

  test("returns requested variant when present", () => {
    expect(resolveVariantName(baseMeta, "beta")).toBe("beta");
  });

  test("throws when requested variant does not exist", () => {
    expect(() => resolveVariantName(baseMeta, "gamma")).toThrow(
      /Unknown variant 'gamma' for host 'example\.com'\. Available variants: alpha, beta/,
    );
  });

  test("falls back to default_variant when omitted", () => {
    expect(resolveVariantName({ ...baseMeta, default_variant: "alpha" })).toBe("alpha");
  });

  test("falls back to sole variant when default_variant is omitted", () => {
    const singleVariantMeta: HostMeta = {
      ...baseMeta,
      variants: {
        only: { file: "only.ubo", description: "Only", tags: [] },
      },
    };
    expect(resolveVariantName(singleVariantMeta)).toBe("only");
  });

  test("throws when multiple variants exist and no default_variant is set", () => {
    expect(() => resolveVariantName(baseMeta)).toThrow(
      /has multiple variants \(alpha, beta\) and no default_variant/,
    );
  });
});

describe("loadPreviewConfig", () => {
  test("loads host targets and resolves default variant", () => {
    const rootDir = createTempWorkspace();
    const hostDir = join(rootDir, "filters", "news.ycombinator.com");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "filter.toml"),
      `host = "news.ycombinator.com"
display_name = "Hacker News"
allowed_domains = ["news.ycombinator.com", "hn.algolia.com"]
default_variant = "dark-mode"

[variants.dark-mode]
file = "dark-mode.ubo"
description = "Dark theme"
tags = ["dark-mode"]

[preview]
ci = true

[[preview.targets]]
url = "https://news.ycombinator.com/"
label = "hn-frontpage"

[[preview.targets]]
url = "https://hn.algolia.com/"
label = "hn-algolia"
`,
      "utf8",
    );

    const config = loadPreviewConfig(rootDir, "news.ycombinator.com");
    expect(config.host).toBe("news.ycombinator.com");
    expect(config.variant).toBe("dark-mode");
    expect(config.targets.map((target) => target.url)).toEqual([
      "https://news.ycombinator.com/",
      "https://hn.algolia.com/",
    ]);
  });

  test("throws when host descriptor is missing", () => {
    const rootDir = createTempWorkspace();
    expect(() => loadPreviewConfig(rootDir, "missing.example")).toThrow(
      /Host descriptor not found/,
    );
  });

  test("throws when [preview] is omitted", () => {
    const rootDir = createTempWorkspace();
    const hostDir = join(rootDir, "filters", "no-preview.example");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "filter.toml"),
      `host = "no-preview.example"
display_name = "No Preview"
allowed_domains = ["no-preview.example"]

[variants.only]
file = "only.ubo"
description = "Only"
tags = []
`,
      "utf8",
    );

    expect(() => loadPreviewConfig(rootDir, "no-preview.example")).toThrow(
      /does not declare \[preview\] targets/,
    );
  });
});

describe("runPreview", () => {
  function setupHostFixture(rootDir: string, writeCompiled = true): void {
    const hostDir = join(rootDir, "filters", "example.com");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "filter.toml"),
      `host = "example.com"
display_name = "Example"
allowed_domains = ["example.com"]

[variants.dark]
file = "dark.ubo"
description = "Dark"
tags = ["dark-mode"]

[preview]
ci = true

[[preview.targets]]
url = "https://example.com/one"
label = "one"

[[preview.targets]]
url = "https://example.com/two"
label = "two"
`,
      "utf8",
    );

    if (writeCompiled) {
      const distDir = join(rootDir, "dist", "raw", "example.com");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "dark.txt"), "example.com##body:style(color: #fff)\n", "utf8");
    }
  }

  test("builds filters, launches isolated visible Firefox with target URLs, and cleans up", async () => {
    const rootDir = createTempWorkspace();
    setupHostFixture(rootDir, true);

    const events: string[] = [];
    let capturedSessionOptions: PrepareSessionOptions | undefined;
    let capturedSpawn: { bin: string; args: string[]; env: Record<string, string> } | undefined;

    const fakeSession: BrowserSession = {
      tmpDir: "/tmp/ubouf-session-test",
      firefoxBinDir: "/tmp/ubouf-session-test/firefox-bin",
      firefoxBin: "/tmp/ubouf-session-test/firefox-bin/firefox",
      profileDir: "/tmp/ubouf-session-test/profile",
      env: { DISPLAY: ":0", TZ: "UTC", LANG: "en-US.UTF-8" },
      keepProfile: true,
      trackChild: () => {
        events.push("trackChild");
      },
      cleanup: () => {
        events.push("cleanup");
      },
    };

    const deps: PreviewDependencies = {
      rootDir,
      buildFilters: async () => {
        events.push("buildFilters");
      },
      ensureToolchain: async () => {
        events.push("ensureToolchain");
        return {
          firefoxDir: "/cache/firefox",
          geckodriverBin: "/cache/geckodriver",
          uboXpiPath: "/cache/ubo.xpi",
        };
      },
      prepareSession: (options) => {
        events.push("prepareSession");
        capturedSessionOptions = options;
        return fakeSession;
      },
      spawnFirefox: (bin, args, env) => {
        events.push("spawnFirefox");
        capturedSpawn = { bin, args, env };
        return {
          exited: Promise.resolve(0),
          kill: () => {},
        };
      },
    };

    await runCli(["preview", "--host", "example.com", "--keep-profile"], deps);

    expect(events).toEqual([
      "buildFilters",
      "ensureToolchain",
      "prepareSession",
      "spawnFirefox",
      "trackChild",
      "cleanup",
    ]);
    expect(capturedSessionOptions).toEqual({
      firefoxDir: "/cache/firefox",
      uboXpiPath: "/cache/ubo.xpi",
      mode: "filtered",
      userFilters: "example.com##body:style(color: #fff)\n",
      keepProfile: true,
    });
    expect(capturedSpawn).toEqual({
      bin: "/tmp/ubouf-session-test/firefox-bin/firefox",
      args: [
        "--no-remote",
        "-profile",
        "/tmp/ubouf-session-test/profile",
        "https://example.com/one",
        "https://example.com/two",
      ],
      env: { DISPLAY: ":0", TZ: "UTC", LANG: "en-US.UTF-8" },
    });
  });

  test("cleans up session when Firefox exits non-zero", async () => {
    const rootDir = createTempWorkspace();
    setupHostFixture(rootDir, true);

    let cleaned = false;
    const deps: PreviewDependencies = {
      rootDir,
      buildFilters: async () => {},
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: () => ({
        tmpDir: "/tmp/s",
        firefoxBinDir: "/tmp/s/firefox-bin",
        firefoxBin: "/tmp/s/firefox-bin/firefox",
        profileDir: "/tmp/s/profile",
        env: {},
        keepProfile: false,
        trackChild: () => {},
        cleanup: () => {
          cleaned = true;
        },
      }),
      spawnFirefox: () => ({
        exited: Promise.resolve(1),
        kill: () => {},
      }),
    };

    await expect(
      runPreview({ command: "preview", host: "example.com", keepProfile: false }, deps),
    ).rejects.toThrow(/Firefox exited with code 1/);
    expect(cleaned).toBe(true);
  });

  test("fails before launching browser when compiled filter is missing", async () => {
    const rootDir = createTempWorkspace();
    setupHostFixture(rootDir, false);

    let toolchainCalled = false;
    const deps: PreviewDependencies = {
      rootDir,
      buildFilters: async () => {},
      ensureToolchain: async () => {
        toolchainCalled = true;
        return {
          firefoxDir: "/cache/firefox",
          geckodriverBin: "/cache/geckodriver",
          uboXpiPath: "/cache/ubo.xpi",
        };
      },
    };

    await expect(
      runPreview({ command: "preview", host: "example.com", keepProfile: false }, deps),
    ).rejects.toThrow(/Compiled filter not found/);
    expect(toolchainCalled).toBe(false);
  });
});
