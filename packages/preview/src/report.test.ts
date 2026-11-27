import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStepSummary,
  formatStepSummaryMarkdown,
  renderGalleryHtml,
  writeVisualReport,
} from "./report.ts";
import type { VisualReport } from "./report.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubouf-report-test-"));
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

describe("report", () => {
  const sampleReport: VisualReport = {
    generatedAt: "2026-11-27T12:00:00.000Z",
    baseRef: "abc1234",
    results: [
      {
        host: "news.ycombinator.com",
        variant: "dark-mode-github-dark",
        label: "hn-frontpage",
        url: "https://news.ycombinator.com/",
        status: "captured",
        panels: {
          raw: "news.ycombinator.com/dark-mode-github-dark/hn-frontpage/raw.png",
          base: "news.ycombinator.com/dark-mode-github-dark/hn-frontpage/base.png",
          pr: "news.ycombinator.com/dark-mode-github-dark/hn-frontpage/pr.png",
        },
      },
      {
        host: "news.ycombinator.com",
        variant: "compact-layout",
        label: "hn-algolia",
        url: "https://hn.algolia.com/",
        status: "captured",
        panels: {
          raw: "news.ycombinator.com/compact-layout/hn-algolia/raw.png",
          pr: "news.ycombinator.com/compact-layout/hn-algolia/pr.png",
        },
      },
      {
        host: "ebay.com",
        variant: "dark-mode-github-dark",
        label: "ebay-search",
        url: "https://www.ebay.com/sch/i.html?_nkw=keyboard",
        status: "skipped_by_config",
        panels: {},
      },
      {
        host: "reddit.com",
        variant: "old-variant",
        label: "reddit-home",
        url: "https://www.reddit.com/",
        status: "removed",
        panels: {},
      },
      {
        host: "example.com",
        variant: "dark",
        label: "blocked",
        url: "https://example.com/",
        status: "error",
        panels: { raw: "example.com/dark/blocked/raw.png" },
        error: {
          kind: "BOT_CHALLENGE",
          message: "Bot challenge <detected>",
          finalUrl: "https://example.com/challenge",
          httpStatus: 403,
          retryCount: 2,
          phaseTimingsMs: { canaryMs: 420, navigateMs: 1200 },
          failureScreenshotPath: "example.com/dark/blocked/failure-pr.png",
        },
      },
    ],
  };

  test("writes report.json and self-contained index.html", () => {
    const outDir = createTempDir();
    const { reportJsonPath, indexHtmlPath } = writeVisualReport(outDir, sampleReport);

    expect(existsSync(reportJsonPath)).toBe(true);
    expect(existsSync(indexHtmlPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(reportJsonPath, "utf8")) as VisualReport;
    expect(parsed).toEqual(sampleReport);

    const html = readFileSync(indexHtmlPath, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("New variant");
    expect(html).toContain("SKIPPED_BY_CONFIG");
    expect(html).toContain("Removed");
    expect(html).toContain("BOT_CHALLENGE");
    expect(html).toContain("Bot challenge &lt;detected&gt;");
    expect(html).toContain("example.com/dark/blocked/failure-pr.png");
    expect(html).toContain("news.ycombinator.com/dark-mode-github-dark/hn-frontpage/base.png");
  });

  test("renders empty state when no targets are affected", () => {
    const html = renderGalleryHtml({
      generatedAt: "2026-11-27T12:00:00.000Z",
      results: [],
    });
    expect(html).toContain("No affected preview targets.");
  });

  test("formats Markdown table for GITHUB_STEP_SUMMARY and appends to file", () => {
    const markdown = formatStepSummaryMarkdown(sampleReport);
    expect(markdown).toContain("## Visual capture summary");
    expect(markdown).toContain("| Host | Variant | Target | Status | Panels | Details |");
    expect(markdown).toContain("| news.ycombinator.com | dark-mode-github-dark | hn-frontpage | captured | raw, base, pr | OK |");
    expect(markdown).toContain("| news.ycombinator.com | compact-layout | hn-algolia | captured | raw, pr (new variant) | New variant |");
    expect(markdown).toContain("| ebay.com | dark-mode-github-dark | ebay-search | skipped_by_config | - | SKIPPED_BY_CONFIG |");
    expect(markdown).toContain("| reddit.com | old-variant | reddit-home | removed | - | Removed in PR |");
    expect(markdown).toContain("`BOT_CHALLENGE`: Bot challenge <detected> (HTTP 403, retries: 2)");

    const outDir = createTempDir();
    const summaryFile = join(outDir, "summary.md");
    appendStepSummary(markdown, summaryFile);
    expect(readFileSync(summaryFile, "utf8")).toContain("## Visual capture summary");
  });
});
