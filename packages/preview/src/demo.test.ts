import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDemoArgs, runCli } from "./cli.ts";
import { DEFAULT_DEMO_MAX_BYTES, runDemo } from "./demo.ts";
import type { DemoDependencies, DemoDriver } from "./demo.ts";
import type { BrowserSession } from "./session.ts";

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubouf-demo-test-"));
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

function writeFixtureHost(rootDir: string): void {
  const hostDir = join(rootDir, "filters", "news.ycombinator.com");
  const distDir = join(rootDir, "dist", "raw", "news.ycombinator.com");
  mkdirSync(hostDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  writeFileSync(
    join(hostDir, "filter.toml"),
    [
      'host = "news.ycombinator.com"',
      'display_name = "Hacker News"',
      'allowed_domains = ["news.ycombinator.com", "hn.algolia.com"]',
      'default_variant = "dark-mode-github-dark"',
      "",
      "[variants.dark-mode-github-dark]",
      'file = "dark-mode-github-dark.ubo"',
      'description = "Dark theme"',
      'tags = ["dark-mode"]',
      "",
      "[preview]",
      "ci = true",
      "",
      "[[preview.targets]]",
      'url = "https://news.ycombinator.com/"',
      'label = "hn-frontpage"',
      'wait_for = ".athing"',
      "",
      "[[preview.targets]]",
      'url = "https://hn.algolia.com/"',
      'label = "hn-algolia"',
      'wait_for = "input[type=\'search\']"',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(distDir, "dark-mode-github-dark.txt"), "news.ycombinator.com##body:style(color: #fff)\n", "utf8");
}

function createFakeSession(): BrowserSession & { cleanedUp: boolean } {
  const session = {
    tmpDir: "/tmp/fake-demo-session",
    firefoxBinDir: "/tmp/fake-demo-session/firefox-bin",
    firefoxBin: "/usr/bin/firefox",
    profileDir: "/tmp/fake-demo-session/profile",
    env: { TZ: "UTC", LANG: "en-US.UTF-8" },
    keepProfile: false,
    cleanedUp: false,
    trackChild: () => {},
    cleanup: () => {
      session.cleanedUp = true;
    },
  };
  return session;
}

describe("parseDemoArgs", () => {
  test("parses required --host with defaults", () => {
    expect(parseDemoArgs(["demo", "--host", "news.ycombinator.com"])).toEqual({
      command: "demo",
      host: "news.ycombinator.com",
      format: "png",
      scrollY: 0,
      maxBytes: DEFAULT_DEMO_MAX_BYTES,
      keepProfile: false,
    });
  });

  test("parses all optional demo flags", () => {
    expect(
      parseDemoArgs([
        "demo",
        "--host",
        "news.ycombinator.com",
        "--variant",
        "dark-mode-github-dark",
        "--label",
        "hn-algolia",
        "--format",
        "webp",
        "--scroll-y",
        "420",
        "--hover",
        ".athing",
        "--max-bytes",
        "1048576",
        "--keep-profile",
      ]),
    ).toEqual({
      command: "demo",
      host: "news.ycombinator.com",
      variant: "dark-mode-github-dark",
      label: "hn-algolia",
      format: "webp",
      scrollY: 420,
      hover: ".athing",
      maxBytes: 1048576,
      keepProfile: true,
    });
  });

  test("rejects invalid flags, missing --host, and bad numeric/format values", () => {
    expect(() => parseDemoArgs(["demo"])).toThrow(/Usage: demo/);
    expect(() => parseDemoArgs(["preview", "--host", "news.ycombinator.com"])).toThrow(/Usage: demo/);
    expect(() => parseDemoArgs(["demo", "--host", "news.ycombinator.com", "--format", "gif"])).toThrow(
      /Usage: demo/,
    );
    expect(() => parseDemoArgs(["demo", "--host", "news.ycombinator.com", "--scroll-y", "-10"])).toThrow(
      /Usage: demo/,
    );
    expect(() => parseDemoArgs(["demo", "--host", "news.ycombinator.com", "--max-bytes", "0"])).toThrow(
      /Usage: demo/,
    );
    expect(() => parseDemoArgs(["demo", "--host", "news.ycombinator.com", "--unknown"])).toThrow(
      /Usage: demo/,
    );
  });
});

describe("runDemo", () => {
  test("captures PNG for default target with scroll and hover, then cleans up", async () => {
    const rootDir = createTempWorkspace();
    writeFixtureHost(rootDir);

    const session = createFakeSession();
    const events: string[] = [];
    const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

    const fakeDriver: DemoDriver = {
      navigate: async (url) => {
        events.push(`navigate:${url}`);
      },
      getCurrentUrl: async () => "https://news.ycombinator.com/",
      getTitle: async () => "Hacker News",
      getHttpStatus: async () => 200,
      executeScript: async <T>(script: string, args: unknown[] = []): Promise<T> => {
        if (script.includes("window.scrollTo")) {
          events.push(`scroll:${String(args[0])}`);
        }
        return "" as T;
      },
      waitForSelector: async (selector) => {
        events.push(`wait:${selector}`);
      },
      hoverSelector: async (selector) => {
        events.push(`hover:${selector}`);
      },
      takeScreenshot: async () => pngBytes,
      close: async () => {
        events.push("close");
      },
    };

    const deps: DemoDependencies = {
      rootDir,
      buildFilters: async () => {
        events.push("build");
      },
      ensureToolchain: async () => ({
        firefoxDir: "/cache/firefox",
        geckodriverBin: "/cache/geckodriver",
        uboXpiPath: "/cache/ubo.xpi",
      }),
      prepareSession: () => session,
      launchWebDriver: async () => fakeDriver,
      verifyCanary: async () => {
        events.push("canary");
        return { canaryMs: 12, observedColor: "rgb(255, 0, 128)" };
      },
      sleep: async () => {},
    };

    const result = await runDemo(
      parseDemoArgs([
        "demo",
        "--host",
        "news.ycombinator.com",
        "--scroll-y",
        "300",
        "--hover",
        ".storylink",
      ]),
      deps,
    );

    const expectedPath = join(
      rootDir,
      "filters",
      "news.ycombinator.com",
      "assets",
      "dark-mode-github-dark-hn-frontpage.png",
    );
    expect(result).toEqual({
      host: "news.ycombinator.com",
      variant: "dark-mode-github-dark",
      label: "hn-frontpage",
      format: "png",
      outputPath: expectedPath,
      bytes: pngBytes.byteLength,
    });
    expect(new Uint8Array(readFileSync(expectedPath))).toEqual(pngBytes);
    expect(events).toEqual([
      "build",
      "canary",
      "navigate:https://news.ycombinator.com/",
      "wait:.athing",
      "scroll:300",
      "wait:.storylink",
      "hover:.storylink",
      "close",
    ]);
    expect(session.cleanedUp).toBe(true);
  });

  test("fails with actionable install message when ffmpeg is missing for --format webp", async () => {
    const rootDir = createTempWorkspace();
    writeFixtureHost(rootDir);
    let launched = false;

    await expect(
      runDemo(parseDemoArgs(["demo", "--host", "news.ycombinator.com", "--format", "webp"]), {
        rootDir,
        checkFfmpeg: async () => false,
        launchWebDriver: async () => {
          launched = true;
          throw new Error("should not launch");
        },
      }),
    ).rejects.toThrow(/ffmpeg is required for --format webp/);
    expect(launched).toBe(false);
  });

  test("captures sequential frames and encodes animated WebP via ffmpeg", async () => {
    const rootDir = createTempWorkspace();
    writeFixtureHost(rootDir);

    const session = createFakeSession();
    let frameCount = 0;
    let encodedOutputPath = "";

    const fakeDriver: DemoDriver = {
      navigate: async () => {},
      getCurrentUrl: async () => "https://hn.algolia.com/",
      getTitle: async () => "HN Search",
      getHttpStatus: async () => 200,
      executeScript: async <T>() => "" as T,
      waitForSelector: async () => {},
      hoverSelector: async () => {},
      takeScreenshot: async () => {
        frameCount += 1;
        return new Uint8Array([1, 2, 3, frameCount]);
      },
      close: async () => {},
    };

    await runCli(
      [
        "demo",
        "--host",
        "news.ycombinator.com",
        "--label",
        "hn-algolia",
        "--format",
        "webp",
        "--scroll-y",
        "200",
      ],
      {
        rootDir,
        buildFilters: async () => {},
        ensureToolchain: async () => ({
          firefoxDir: "/cache/firefox",
          geckodriverBin: "/cache/geckodriver",
          uboXpiPath: "/cache/ubo.xpi",
        }),
        prepareSession: () => session,
        launchWebDriver: async () => fakeDriver,
        verifyCanary: async () => ({ canaryMs: 10, observedColor: "rgb(255, 0, 128)" }),
        checkFfmpeg: async () => true,
        encodeWebp: async (framesDir, outputPath) => {
          encodedOutputPath = outputPath;
          expect(existsSync(join(framesDir, "frame-000.png"))).toBe(true);
          expect(existsSync(join(framesDir, "frame-004.png"))).toBe(true);
          writeFileSync(outputPath, new Uint8Array([82, 73, 70, 70]));
        },
        sleep: async () => {},
      },
    );

    expect(frameCount).toBe(5);
    expect(encodedOutputPath).toBe(
      join(
        rootDir,
        "filters",
        "news.ycombinator.com",
        "assets",
        "dark-mode-github-dark-hn-algolia.webp",
      ),
    );
    expect(existsSync(encodedOutputPath)).toBe(true);
  });

  test("removes output and throws when demo exceeds --max-bytes", async () => {
    const rootDir = createTempWorkspace();
    writeFixtureHost(rootDir);
    const session = createFakeSession();

    const fakeDriver: DemoDriver = {
      navigate: async () => {},
      getCurrentUrl: async () => "https://news.ycombinator.com/",
      getTitle: async () => "Hacker News",
      getHttpStatus: async () => 200,
      executeScript: async <T>() => "" as T,
      waitForSelector: async () => {},
      hoverSelector: async () => {},
      takeScreenshot: async () => new Uint8Array(64),
      close: async () => {},
    };

    await expect(
      runDemo(
        parseDemoArgs([
          "demo",
          "--host",
          "news.ycombinator.com",
          "--max-bytes",
          "16",
        ]),
        {
          rootDir,
          buildFilters: async () => {},
          ensureToolchain: async () => ({
            firefoxDir: "/cache/firefox",
            geckodriverBin: "/cache/geckodriver",
            uboXpiPath: "/cache/ubo.xpi",
          }),
          prepareSession: () => session,
          launchWebDriver: async () => fakeDriver,
          verifyCanary: async () => ({ canaryMs: 5, observedColor: "rgb(255, 0, 128)" }),
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/exceeds --max-bytes limit/);

    const outputPath = join(
      rootDir,
      "filters",
      "news.ycombinator.com",
      "assets",
      "dark-mode-github-dark-hn-frontpage.png",
    );
    expect(existsSync(outputPath)).toBe(false);
  });

  test("throws when --label does not match any target", async () => {
    const rootDir = createTempWorkspace();
    writeFixtureHost(rootDir);

    await expect(
      runDemo(
        parseDemoArgs([
          "demo",
          "--host",
          "news.ycombinator.com",
          "--label",
          "nonexistent",
        ]),
        { rootDir },
      ),
    ).rejects.toThrow(/Target label 'nonexistent' not found.*Available labels: hn-frontpage, hn-algolia/);
  });
});
