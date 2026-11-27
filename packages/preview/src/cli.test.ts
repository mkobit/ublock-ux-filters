import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkspace } from "@ubdf/builder/compiler";
import type { FilterParserAdapter } from "@ubdf/builder/compiler";
import { CANARY_RULE } from "./canary.ts";
import type { HostMeta } from "@ubdf/schema";
import { CaptureFailureError } from "./webdriver.ts";
import {
  loadPreviewConfig,
  parseCaptureArgs,
  parsePreviewArgs,
  resolveVariantName,
  runCapture,
  runCli,
  runPreview,
} from "./cli.ts";
import type { CaptureDependencies, PreviewDependencies } from "./cli.ts";
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

describe("parseCaptureArgs", () => {
  test("parses capture with no optional flags", () => {
    expect(parseCaptureArgs(["capture"])).toEqual({
      command: "capture",
      ci: false,
      keepProfile: false,
    });
  });

  test("parses all capture flags", () => {
    expect(
      parseCaptureArgs([
        "capture",
        "--ci",
        "--keep-profile",
        "--host",
        "news.ycombinator.com",
        "--variant",
        "dark-mode-github-dark",
        "--base-ref",
        "origin/main",
      ]),
    ).toEqual({
      command: "capture",
      host: "news.ycombinator.com",
      variant: "dark-mode-github-dark",
      baseRef: "origin/main",
      ci: true,
      keepProfile: true,
    });
  });

  test("rejects --variant without --host, duplicate flags, and unknown flags", () => {
    expect(() => parseCaptureArgs(["capture", "--variant", "dark"])).toThrow(/Usage: capture/);
    expect(() => parseCaptureArgs(["capture", "--ci", "--ci"])).toThrow(/Usage: capture/);
    expect(() => parseCaptureArgs(["capture", "--base-ref"])).toThrow(/Usage: capture/);
    expect(() => parseCaptureArgs(["capture", "--unknown"])).toThrow(/Usage: capture/);
  });
});

describe("runCapture", () => {
  function setupCaptureFixture(rootDir: string, compiledText: string): void {
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
tags = []

[preview]
ci = true

[[preview.targets]]
url = "https://example.com/"
label = "home"
wait_for = "#main"
`,
      "utf8",
    );
    const rawDir = join(rootDir, "dist", "raw", "example.com");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "dark.txt"), compiledText, "utf8");
  }

  function makeFakeSession(): BrowserSession {
    return {
      tmpDir: "/tmp/ubouf-capture-test",
      firefoxBinDir: "/tmp/ubouf-capture-test/firefox-bin",
      firefoxBin: "/tmp/ubouf-capture-test/firefox-bin/firefox",
      profileDir: "/tmp/ubouf-capture-test/profile",
      env: {},
      keepProfile: false,
      trackChild: () => {},
      cleanup: () => {},
    };
  }

  test("runs 3-way capture, writes report.json, index.html, PNGs, and step summary", async () => {
    const headRoot = createTempWorkspace();
    const baseRoot = createTempWorkspace();
    setupCaptureFixture(headRoot, "example.com##body:style(color: #fff)\n");
    setupCaptureFixture(baseRoot, "example.com##body:style(color: #eee)\n");

    const outDir = join(headRoot, ".artifacts", "visual");
    const summaryPath = join(headRoot, "step-summary.md");
    const modesSeen: string[] = [];

    const deps: CaptureDependencies = {
      rootDir: headRoot,
      outDir,
      stepSummaryPath: summaryPath,
      now: () => new Date("2026-11-27T12:00:00.000Z"),
      getChangedFiles: async () => ["filters/example.com/dark.ubo"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: (opts) => {
        modesSeen.push(opts.mode);
        return makeFakeSession();
      },
      verifyCanary: async () => ({ canaryMs: 120, observedColor: "rgb(255, 0, 128)" }),
      launchWebDriver: async () => ({
        navigate: async () => {},
        getCurrentUrl: async () => "https://example.com/",
        getTitle: async () => "Example",
        getHttpStatus: async () => 200,
        executeScript: (async () => "Example content") as <T>() => Promise<T>,
        waitForSelector: async () => {},
        takeScreenshot: async () => new Uint8Array([137, 80, 78, 71]),
        close: async () => {},
      }),
      sleep: async () => {},
    };

    const report = await runCapture(
      { command: "capture", baseRef: "main", ci: true, keepProfile: false },
      deps,
    );

    expect(modesSeen).toEqual(["raw", "filtered", "filtered"]);
    expect(report.results).toEqual([
      {
        host: "example.com",
        variant: "dark",
        label: "home",
        url: "https://example.com/",
        status: "captured",
        panels: {
          raw: "example.com/dark/home/raw.png",
          base: "example.com/dark/home/base.png",
          pr: "example.com/dark/home/pr.png",
        },
      },
    ]);
    expect(existsSync(join(outDir, "report.json"))).toBe(true);
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "example.com", "dark", "home", "raw.png"))).toBe(true);
    expect(existsSync(join(outDir, "example.com", "dark", "home", "base.png"))).toBe(true);
    expect(existsSync(join(outDir, "example.com", "dark", "home", "pr.png"))).toBe(true);
    expect(readFileSync(summaryPath, "utf8")).toContain("| example.com | dark | home | captured | raw, base, pr | OK |");
  });

  test("records UBO_LOAD_ERROR, writes report, and exits non-zero", async () => {
    const headRoot = createTempWorkspace();
    setupCaptureFixture(headRoot, "example.com##body\n");
    const outDir = join(headRoot, ".artifacts", "visual");

    let currentMode = "";
    let navigatedInFilteredPass = false;
    const deps: CaptureDependencies = {
      rootDir: headRoot,
      outDir,
      buildFilters: async () => {},
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: (opts) => {
        currentMode = opts.mode;
        return makeFakeSession();
      },
      verifyCanary: async () => {
        throw new CaptureFailureError({
          kind: "UBO_LOAD_ERROR",
          message: "Canary failed",
          finalUrl: "http://127.0.0.1:1234/canary",
          httpStatus: 200,
          retryCount: 0,
          phaseTimingsMs: { canaryMs: 10000, navigateMs: 10000 },
        });
      },
      launchWebDriver: async () => ({
        navigate: async (url) => {
          if (currentMode === "filtered" && url.startsWith("https://")) {
            navigatedInFilteredPass = true;
          }
        },
        getCurrentUrl: async () => "https://example.com/",
        getTitle: async () => "Example",
        getHttpStatus: async () => 200,
        executeScript: (async () => "") as <T>() => Promise<T>,
        waitForSelector: async () => {},
        takeScreenshot: async () => new Uint8Array([1, 2, 3]),
        close: async () => {},
      }),
      sleep: async () => {},
    };

    await expect(
      runCli(["capture", "--host", "example.com", "--ci"], deps),
    ).rejects.toThrow(/Visual capture failed for 1 target/);
    expect(navigatedInFilteredPass).toBe(false);
    expect(existsSync(join(outDir, "report.json"))).toBe(true);
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
  });
});

describe("included rules composition in preview and capture", () => {
  const testAdapter: FilterParserAdapter = {
    async lint(filePath, content) {
      const ruleCount = content
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("!") && !line.startsWith("["))
        .length;
      return { filePath, ruleCount, errors: [] };
    },
  };

  function writeMultiHostWorkspace(rootDir: string, sharedRule: string, appRule: string): void {
    const sharedDir = join(rootDir, "filters", "shared.example");
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(
      join(sharedDir, "filter.toml"),
      `host = "shared.example"
display_name = "Shared"
allowed_domains = ["shared.example"]

[variants.base]
file = "base.ubo"
description = "Shared base rules"
tags = []
`,
      "utf8",
    );
    writeFileSync(
      join(sharedDir, "base.ubo"),
      `[Adblock Plus 2.0]\n! Title: Shared\n${sharedRule}\n`,
      "utf8",
    );

    const appDir = join(rootDir, "filters", "app.example");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "filter.toml"),
      `host = "app.example"
display_name = "App"
allowed_domains = ["app.example"]

[variants.dark]
file = "dark.ubo"
description = "App dark"
tags = []
includes = ["shared.example::base"]

[preview]
ci = true

[[preview.targets]]
url = "https://app.example/"
label = "home"
`,
      "utf8",
    );
    writeFileSync(
      join(appDir, "dark.ubo"),
      `! Title: App Dark\n${appRule}\n`,
      "utf8",
    );

    const setsDir = join(rootDir, "sets");
    mkdirSync(setsDir, { recursive: true });
    writeFileSync(
      join(setsDir, "app.toml"),
      `name = "app"
description = "App subscription"
mode = "explicit"
include = ["app.example::dark"]
`,
      "utf8",
    );
  }

  test("runPreview loads included rules from another host in subscription composition order", async () => {
    const rootDir = createTempWorkspace();
    writeMultiHostWorkspace(rootDir, "shared.example##.shared-banner", "app.example##body:style(color: #fff)");

    let capturedUserFilters: string | undefined;
    const deps: PreviewDependencies = {
      rootDir,
      buildFilters: async (dir) => {
        await compileWorkspace(
          {
            rootDir: dir,
            outDir: "dist",
            gitSha: "test-sha",
            homepageUrl: "https://example.org",
          },
          testAdapter,
        );
      },
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: (options) => {
        capturedUserFilters = options.userFilters;
        return {
          tmpDir: "/tmp/s",
          firefoxBinDir: "/tmp/s/firefox-bin",
          firefoxBin: "/tmp/s/firefox-bin/firefox",
          profileDir: "/tmp/s/profile",
          env: {},
          keepProfile: false,
          trackChild: () => {},
          cleanup: () => {},
        };
      },
      spawnFirefox: () => ({
        exited: Promise.resolve(0),
        kill: () => {},
      }),
    };

    await runPreview({ command: "preview", host: "app.example", variant: "dark", keepProfile: false }, deps);

    const setContent = readFileSync(join(rootDir, "dist", "sets", "app.txt"), "utf8");
    const setBody = setContent.slice(setContent.indexOf("\n\n") + 2);
    expect(capturedUserFilters).toBe("shared.example##.shared-banner\napp.example##body:style(color: #fff)\n");
    expect(capturedUserFilters).toBe(setBody);
  });

  test("runCapture loads included rules in subscription composition order for base and pr passes", async () => {
    const headRoot = createTempWorkspace();
    const baseRoot = createTempWorkspace();
    writeMultiHostWorkspace(headRoot, "shared.example##.shared-v2", "app.example##body:style(color: #fff)");
    writeMultiHostWorkspace(baseRoot, "shared.example##.shared-v1", "app.example##body:style(color: #fff)");

    await compileWorkspace(
      { rootDir: headRoot, outDir: "dist", gitSha: "head", homepageUrl: "https://example.org" },
      testAdapter,
    );
    await compileWorkspace(
      { rootDir: baseRoot, outDir: "dist", gitSha: "base", homepageUrl: "https://example.org" },
      testAdapter,
    );

    const userFiltersByMode: Array<{ mode: string; userFilters?: string }> = [];
    const deps: CaptureDependencies = {
      rootDir: headRoot,
      outDir: join(headRoot, ".artifacts", "visual"),
      getChangedFiles: async () => ["filters/shared.example/base.ubo"],
      buildFilters: async () => {},
      prepareBaseCheckout: async () => ({
        baseRootDir: baseRoot,
        baseDistDir: join(baseRoot, "dist"),
        cleanup: () => {},
      }),
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: (opts) => {
        userFiltersByMode.push({
          mode: opts.mode,
          ...(opts.userFilters !== undefined ? { userFilters: opts.userFilters } : {}),
        });
        return {
          tmpDir: "/tmp/ubouf-capture-test",
          firefoxBinDir: "/tmp/ubouf-capture-test/firefox-bin",
          firefoxBin: "/tmp/ubouf-capture-test/firefox-bin/firefox",
          profileDir: "/tmp/ubouf-capture-test/profile",
          env: {},
          keepProfile: false,
          trackChild: () => {},
          cleanup: () => {},
        };
      },
      verifyCanary: async () => ({ canaryMs: 100, observedColor: "rgb(255, 0, 128)" }),
      launchWebDriver: async () => ({
        navigate: async () => {},
        getCurrentUrl: async () => "https://app.example/",
        getTitle: async () => "App",
        getHttpStatus: async () => 200,
        executeScript: (async () => "") as <T>() => Promise<T>,
        waitForSelector: async () => {},
        takeScreenshot: async () => new Uint8Array([1, 2, 3]),
        close: async () => {},
      }),
    };

    await runCli(["capture", "--base-ref", "main", "--ci"], deps);

    const baseSetContent = readFileSync(join(baseRoot, "dist", "sets", "app.txt"), "utf8");
    const baseSetBody = baseSetContent.slice(baseSetContent.indexOf("\n\n") + 2);
    const prSetContent = readFileSync(join(headRoot, "dist", "sets", "app.txt"), "utf8");
    const prSetBody = prSetContent.slice(prSetContent.indexOf("\n\n") + 2);

    expect(userFiltersByMode).toEqual([
      { mode: "raw" },
      { mode: "filtered", userFilters: `${CANARY_RULE}\n${baseSetBody}` },
      { mode: "filtered", userFilters: `${CANARY_RULE}\n${prSetBody}` },
    ]);
  });
});
