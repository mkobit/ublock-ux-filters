import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureError } from "./webdriver.ts";

export type TargetStatus = "captured" | "skipped_by_config" | "removed" | "error";

export interface TargetResult {
  host: string;
  variant: string;
  label: string;
  url: string;
  status: TargetStatus;
  panels: { raw?: string; base?: string; pr?: string };
  error?: CaptureError;
}

export interface VisualReport {
  generatedAt: string;
  baseRef?: string;
  results: TargetResult[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function isNewVariantResult(result: TargetResult): boolean {
  return (
    result.status === "captured" &&
    result.panels.raw !== undefined &&
    result.panels.pr !== undefined &&
    result.panels.base === undefined
  );
}

function renderBadge(result: TargetResult): string {
  switch (result.status) {
    case "captured":
      return isNewVariantResult(result)
        ? '<span class="badge badge-new">New variant</span>'
        : '<span class="badge badge-ok">Captured</span>';
    case "skipped_by_config":
      return '<span class="badge badge-skip">SKIPPED_BY_CONFIG</span>';
    case "removed":
      return '<span class="badge badge-removed">Removed</span>';
    case "error":
      return `<span class="badge badge-err">${escapeHtml(result.error?.kind ?? "ERROR")}</span>`;
  }
}

function renderPanel(title: string, imagePath: string): string {
  const safePath = escapeHtml(imagePath);
  const safeTitle = escapeHtml(title);
  return `<figure class="panel"><figcaption>${safeTitle}</figcaption><a href="${safePath}"><img src="${safePath}" alt="${safeTitle} screenshot" loading="lazy"></a></figure>`;
}

function renderResultCard(result: TargetResult): string {
  const header = `<div class="card-header">
    <div>
      <strong>${escapeHtml(result.host)}</strong> :: <code>${escapeHtml(result.variant)}</code> / <code>${escapeHtml(result.label)}</code>
      <div class="url"><a href="${escapeHtml(result.url)}" rel="noreferrer">${escapeHtml(result.url)}</a></div>
    </div>
    ${renderBadge(result)}
  </div>`;

  if (result.status === "captured") {
    const panels: string[] = [];
    if (result.panels.raw !== undefined) {
      panels.push(renderPanel("Raw", result.panels.raw));
    }
    if (result.panels.base !== undefined) {
      panels.push(renderPanel("Base", result.panels.base));
    }
    if (result.panels.pr !== undefined) {
      panels.push(renderPanel("PR", result.panels.pr));
    }
    return `<section class="card">${header}<div class="panels">${panels.join("")}</div></section>`;
  }

  if (result.status === "skipped_by_config") {
    return `<section class="card">${header}<p class="note">Skipped in CI mode by host or target configuration (<code>SKIPPED_BY_CONFIG</code>).</p></section>`;
  }

  if (result.status === "removed") {
    return `<section class="card">${header}<p class="note">Variant or preview target was removed in this branch.</p></section>`;
  }

  const err = result.error;
  if (!err) {
    return `<section class="card">${header}<p class="note">Capture failed without error details.</p></section>`;
  }

  const failureShot = err.failureScreenshotPath
    ? `<div class="panels">${renderPanel("Failure screenshot", err.failureScreenshotPath)}</div>`
    : "";

  return `<section class="card card-error">${header}
    <dl class="error-meta">
      <dt>Kind</dt><dd><code>${escapeHtml(err.kind)}</code></dd>
      <dt>Message</dt><dd>${escapeHtml(err.message)}</dd>
      <dt>Final URL</dt><dd><code>${escapeHtml(err.finalUrl)}</code></dd>
      <dt>HTTP status</dt><dd>${err.httpStatus === null ? "n/a" : String(err.httpStatus)}</dd>
      <dt>Retries</dt><dd>${String(err.retryCount)}</dd>
      <dt>Timings (ms)</dt><dd><code>${escapeHtml(JSON.stringify(err.phaseTimingsMs))}</code></dd>
    </dl>
    ${failureShot}
  </section>`;
}

export function renderGalleryHtml(report: VisualReport): string {
  const counts = {
    captured: report.results.filter((r) => r.status === "captured").length,
    skipped: report.results.filter((r) => r.status === "skipped_by_config").length,
    removed: report.results.filter((r) => r.status === "removed").length,
    error: report.results.filter((r) => r.status === "error").length,
  };

  const body =
    report.results.length === 0
      ? '<p class="empty">No affected preview targets.</p>'
      : report.results.map(renderResultCard).join("\n");

  const baseInfo = report.baseRef
    ? ` &middot; Base ref: <code>${escapeHtml(report.baseRef)}</code>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual capture gallery</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  header { margin-bottom: 24px; border-bottom: 1px solid #334155; padding-bottom: 16px; }
  h1 { margin: 0 0 8px; font-size: 1.5rem; }
  .meta { color: #94a3b8; font-size: 0.9rem; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .card-error { border-color: #ef4444; }
  .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
  .url { font-size: 0.85rem; margin-top: 4px; }
  .url a { color: #93c5fd; }
  .badge { padding: 3px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
  .badge-ok { background: #14532d; color: #bbf7d0; }
  .badge-new { background: #1e3a8a; color: #bfdbfe; }
  .badge-skip { background: #3f3f46; color: #e4e4e7; }
  .badge-removed { background: #78350f; color: #fde68a; }
  .badge-err { background: #7f1d1d; color: #fecaca; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  .panel { margin: 0; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px; }
  .panel figcaption { font-size: 0.8rem; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; }
  .panel img { width: 100%; height: auto; display: block; border-radius: 4px; }
  .note, .empty { color: #94a3b8; margin: 8px 0 0; }
  .error-meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 0.85rem; margin: 0 0 12px; }
  .error-meta dt { color: #94a3b8; font-weight: 600; }
  .error-meta dd { margin: 0; word-break: break-word; }
</style>
</head>
<body>
  <header>
    <h1>Visual capture gallery</h1>
    <div class="meta">
      Generated: <code>${escapeHtml(report.generatedAt)}</code>${baseInfo}
      &middot; Captured: ${counts.captured}
      &middot; Skipped: ${counts.skipped}
      &middot; Removed: ${counts.removed}
      &middot; Errors: ${counts.error}
    </div>
  </header>
  <main>
    ${body}
  </main>
</body>
</html>
`;
}

function formatPanelsCell(result: TargetResult): string {
  if (result.status !== "captured") {
    return "-";
  }
  const names: string[] = [];
  if (result.panels.raw !== undefined) names.push("raw");
  if (result.panels.base !== undefined) names.push("base");
  if (result.panels.pr !== undefined) names.push("pr");
  if (names.length === 0) {
    return "-";
  }
  return isNewVariantResult(result) ? `${names.join(", ")} (new variant)` : names.join(", ");
}

function formatDetailsCell(result: TargetResult): string {
  switch (result.status) {
    case "captured":
      return isNewVariantResult(result) ? "New variant" : "OK";
    case "skipped_by_config":
      return "SKIPPED_BY_CONFIG";
    case "removed":
      return "Removed in PR";
    case "error": {
      const err = result.error;
      if (!err) {
        return "Error";
      }
      const statusPart = err.httpStatus === null ? "n/a" : String(err.httpStatus);
      return `\`${err.kind}\`: ${err.message} (HTTP ${statusPart}, retries: ${err.retryCount})`;
    }
  }
}

export function formatStepSummaryMarkdown(report: VisualReport): string {
  const lines: string[] = ["## Visual capture summary", ""];
  if (report.results.length === 0) {
    lines.push("No affected preview targets.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Host | Variant | Target | Status | Panels | Details |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const result of report.results) {
    lines.push(
      `| ${escapeMarkdownCell(result.host)} | ${escapeMarkdownCell(result.variant)} | ${escapeMarkdownCell(result.label)} | ${escapeMarkdownCell(result.status)} | ${escapeMarkdownCell(formatPanelsCell(result))} | ${escapeMarkdownCell(formatDetailsCell(result))} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function writeVisualReport(
  outDir: string,
  report: VisualReport,
): { reportJsonPath: string; indexHtmlPath: string } {
  mkdirSync(outDir, { recursive: true });
  const reportJsonPath = join(outDir, "report.json");
  const indexHtmlPath = join(outDir, "index.html");

  writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(indexHtmlPath, renderGalleryHtml(report), "utf8");

  return { reportJsonPath, indexHtmlPath };
}

export function appendStepSummary(
  markdown: string,
  summaryPath = process.env["GITHUB_STEP_SUMMARY"],
): void {
  if (!summaryPath || summaryPath.trim() === "") {
    return;
  }
  appendFileSync(summaryPath, `${markdown}\n`, "utf8");
}
