import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./index.ts";
import { FALLBACK_BASE_URL } from "./render.ts";
import type { BuildManifest } from "./render.ts";

const tempDirs: string[] = [];

async function makeTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "ubdf-web-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(
  rootDir: string,
  options?: {
    description?: string;
    rulesText?: string;
    includeAssets?: boolean;
  },
) {
  const distDir = join(rootDir, "dist");
  const description = options?.description ?? "Clean layout for example host";
  const rulesText = options?.rulesText ?? "! Title: Example\nexample.com##.banner\n";

  const manifest: BuildManifest = {
    version: "abc1234",
    generatedAt: "2026-01-01T00:00:00.000Z",
    expires: "1 day",
    hosts: {
      "example.com": {
        displayName: "Example",
        defaultVariant: "clean",
        variants: ["clean"],
      },
    },
    sets: {
      "all-defaults": {
        name: "all-defaults",
        description: "All default filters",
        setPath: "sets/all-defaults.txt",
        members: ["example.com::clean"],
      },
    },
    aliases: {},
    entries: {
      "example.com::clean": {
        id: "example.com::clean",
        host: "example.com",
        variant: "clean",
        description,
        tags: ["ux", "clean"],
        resolvedIncludes: [],
        fragmentPath: "raw/example.com/clean.txt",
        ruleCount: 1,
        sha256: "deadbeef",
      },
    },
  };

  await Bun.write(join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await Bun.write(
    join(distDir, "sets/all-defaults.txt"),
    "! Title: all-defaults\nexample.com##.banner\n",
  );
  await Bun.write(join(distDir, "raw/example.com/clean.txt"), rulesText);

  if (options?.includeAssets) {
    await Bun.write(join(rootDir, "filters/example.com/assets/before.png"), "png-bytes");
    await Bun.write(join(rootDir, "filters/example.com/assets/diagram.svg"), "<svg></svg>");
    await Bun.write(join(rootDir, "filters/example.com/assets/notes.txt"), "ignored");
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("@ubdf/web", () => {
  test("generates self-contained static catalog with sets, raw fragments, and assets", async () => {
    const rootDir = await makeTempWorkspace();
    await writeFixture(rootDir, { includeAssets: true });

    await runCli(["build", "--dist", "dist", "--out", "dist-web"], rootDir);

    const outDir = join(rootDir, "dist-web");
    expect(await Bun.file(join(outDir, "index.html")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "styles.css")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "app.js")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "manifest.json")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "sets/all-defaults.txt")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "raw/example.com/clean.txt")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "assets/example.com/before.png")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "assets/example.com/diagram.svg")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "assets/example.com/notes.txt")).exists()).toBe(false);

    const html = await Bun.file(join(outDir, "index.html")).text();
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("<section");
    expect(html).toContain("<footer");
    expect(html).toContain("assets/example.com/before.png");
    expect(html).toContain("assets/example.com/diagram.svg");
    expect(html).toContain("<details class=\"rules-details\">");
    expect(html).toContain("<summary>View rules</summary>");
  });

  test("escapes HTML special characters in descriptions and rules", async () => {
    const rootDir = await makeTempWorkspace();
    await writeFixture(rootDir, {
      description: 'Test & "quote" <script>alert(1)</script>',
      rulesText: '! Note: <script>evil()</script> & "quoted"\nexample.com##div[title="a&b"]\n',
    });

    await runCli(["build", "--dist", "dist", "--out", "dist-web"], rootDir);

    const html = await Bun.file(join(rootDir, "dist-web/index.html")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; &quot;quote&quot;");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt; &amp; &quot;quoted&quot;");
  });

  test("generates abp:subscribe links with and without --base-url", async () => {
    const rootDir = await makeTempWorkspace();
    await writeFixture(rootDir);

    await runCli(["build", "--dist", "dist", "--out", "dist-web-default"], rootDir);
    const defaultHtml = await Bun.file(join(rootDir, "dist-web-default/index.html")).text();
    const expectedFallbackSet = `abp:subscribe?location=${encodeURIComponent(`${FALLBACK_BASE_URL}sets/all-defaults.txt`)}&amp;title=${encodeURIComponent("uBlock UX filters: all-defaults")}`;
    expect(defaultHtml).toContain(expectedFallbackSet);
    expect(defaultHtml).not.toContain("data-base-url=");

    await runCli(
      ["build", "--dist", "dist", "--out", "dist-web-custom", "--base-url", "https://filters.example.org/ublock"],
      rootDir,
    );
    const customHtml = await Bun.file(join(rootDir, "dist-web-custom/index.html")).text();
    const expectedCustomSet = `abp:subscribe?location=${encodeURIComponent("https://filters.example.org/ublock/sets/all-defaults.txt")}&amp;title=${encodeURIComponent("uBlock UX filters: all-defaults")}`;
    expect(customHtml).toContain(expectedCustomSet);
    expect(customHtml).toContain('data-base-url="https://filters.example.org/ublock/"');
  });

  test("fails with a clear error when manifest.json is missing", async () => {
    const rootDir = await makeTempWorkspace();
    await expect(runCli(["build", "--dist", "missing-dist", "--out", "dist-web"], rootDir)).rejects.toThrow(
      /Missing build manifest at .*manifest\.json/,
    );
  });
});
