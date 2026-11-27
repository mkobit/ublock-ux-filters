export interface ManifestHost {
  displayName: string;
  defaultVariant?: string;
  variants: string[];
}

export interface ManifestSet {
  name: string;
  description: string;
  setPath: string;
  members: string[];
}

export interface ManifestEntry {
  id: string;
  host: string;
  variant: string;
  description: string;
  tags: string[];
  resolvedIncludes: string[];
  fragmentPath: string;
  ruleCount: number;
  sha256: string;
}

export interface BuildManifest {
  version: string;
  generatedAt: string;
  expires: string;
  hosts: Record<string, ManifestHost>;
  sets: Record<string, ManifestSet>;
  aliases: Record<string, string>;
  entries: Record<string, ManifestEntry>;
}

export interface VariantCatalogItem {
  entry: ManifestEntry;
  displayName: string;
  isDefault: boolean;
  rulesText: string;
  assets: string[];
}

export interface RenderCatalogInput {
  manifest: BuildManifest;
  variants: VariantCatalogItem[];
  baseUrl?: string;
}

export const FALLBACK_BASE_URL = "https://mkobit.github.io/ublock-ux-filters/";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const withSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return new URL(withSlash).toString();
}

export function buildSubscribeHref(relativePath: string, title: string, baseUrl?: string): string {
  const effectiveBase = baseUrl ? normalizeBaseUrl(baseUrl) : FALLBACK_BASE_URL;
  const locationUrl = new URL(relativePath, effectiveBase).toString();
  return `abp:subscribe?location=${encodeURIComponent(locationUrl)}&title=${encodeURIComponent(title)}`;
}

function collectTags(variants: readonly VariantCatalogItem[]): string[] {
  const tags = new Set<string>();
  for (const item of variants) {
    for (const tag of item.entry.tags) {
      tags.add(tag);
    }
  }
  return [...tags].sort((left, right) => left.localeCompare(right));
}

function renderSetCard(set: ManifestSet, baseUrl?: string): string {
  const title = `uBlock UX filters: ${set.name}`;
  const subscribeHref = buildSubscribeHref(set.setPath, title, baseUrl);
  const memberLabel = set.members.length === 1 ? "1 filter" : `${set.members.length} filters`;
  return [
    `<article class="card set-card">`,
    `  <div class="card-header">`,
    `    <h3>${escapeHtml(set.name)}</h3>`,
    `    <span class="badge">${escapeHtml(memberLabel)}</span>`,
    `  </div>`,
    `  <p class="card-description">${escapeHtml(set.description)}</p>`,
    `  <div class="card-actions">`,
    `    <a class="button button-primary" href="${escapeHtml(subscribeHref)}" data-subscribe-path="${escapeHtml(set.setPath)}" data-subscribe-title="${escapeHtml(title)}">Subscribe</a>`,
    `    <a class="button button-secondary" href="${escapeHtml(set.setPath)}">Raw rules</a>`,
    `    <button type="button" class="button button-secondary" data-copy-path="${escapeHtml(set.setPath)}">Copy URL</button>`,
    `  </div>`,
    `</article>`,
  ].join("\n");
}

function renderAssetGallery(assets: readonly string[], displayName: string): string {
  if (assets.length === 0) return "";
  const images = assets.map((assetPath) => {
    const fileName = assetPath.split("/").pop() ?? assetPath;
    return `    <figure class="asset-item"><img src="${escapeHtml(assetPath)}" alt="${escapeHtml(`${displayName} preview (${fileName})`)}" loading="lazy"></figure>`;
  });
  return [
    `  <div class="asset-gallery">`,
    ...images,
    `  </div>`,
  ].join("\n");
}

function renderVariantCard(item: VariantCatalogItem, baseUrl?: string): string {
  const { entry, displayName, isDefault, rulesText, assets } = item;
  const title = `${displayName} (${entry.variant})`;
  const subscribeHref = buildSubscribeHref(entry.fragmentPath, title, baseUrl);
  const ruleLabel = entry.ruleCount === 1 ? "1 rule" : `${entry.ruleCount} rules`;
  const searchBlob = [displayName, entry.host, entry.variant, entry.description, ...entry.tags]
    .join(" ")
    .toLowerCase();
  const tagsHtml = entry.tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
  const defaultBadge = isDefault ? `<span class="badge badge-accent">Default</span>` : "";

  return [
    `<article class="card variant-card" data-entry-id="${escapeHtml(entry.id)}" data-host="${escapeHtml(entry.host)}" data-variant="${escapeHtml(entry.variant)}" data-tags="${escapeHtml(entry.tags.join(","))}" data-search="${escapeHtml(searchBlob)}">`,
    `  <div class="card-header">`,
    `    <div>`,
    `      <h3>${escapeHtml(displayName)}</h3>`,
    `      <p class="card-meta"><code>${escapeHtml(entry.host)}</code> · <code>${escapeHtml(entry.variant)}</code> · ${escapeHtml(ruleLabel)}</p>`,
    `    </div>`,
    `    <div class="badge-group">${defaultBadge}</div>`,
    `  </div>`,
    `  <p class="card-description">${escapeHtml(entry.description)}</p>`,
    entry.tags.length > 0 ? `  <div class="tag-list">${tagsHtml}</div>` : "",
    renderAssetGallery(assets, displayName),
    `  <label class="custom-select">`,
    `    <input type="checkbox" class="custom-select-checkbox" data-entry-id="${escapeHtml(entry.id)}">`,
    `    <span>Include in custom list</span>`,
    `  </label>`,
    `  <div class="card-actions">`,
    `    <a class="button button-primary" href="${escapeHtml(subscribeHref)}" data-subscribe-path="${escapeHtml(entry.fragmentPath)}" data-subscribe-title="${escapeHtml(title)}">Subscribe</a>`,
    `    <a class="button button-secondary" href="${escapeHtml(entry.fragmentPath)}">Raw rules</a>`,
    `    <button type="button" class="button button-secondary" data-copy-path="${escapeHtml(entry.fragmentPath)}">Copy URL</button>`,
    `  </div>`,
    `  <details class="rules-details">`,
    `    <summary>View rules</summary>`,
    `    <pre><code>${escapeHtml(rulesText)}</code></pre>`,
    `  </details>`,
    `</article>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderHtml(input: RenderCatalogInput): string {
  const { manifest, variants, baseUrl } = input;
  const sets = Object.values(manifest.sets).sort((left, right) => left.name.localeCompare(right.name));
  const tags = collectTags(variants);
  const normalizedBaseUrl = baseUrl ? normalizeBaseUrl(baseUrl) : "";

  const tagButtons = [
    `<button type="button" class="tag-filter is-active" data-tag="" aria-pressed="true">All</button>`,
    ...tags.map(
      (tag) => `<button type="button" class="tag-filter" data-tag="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(tag)}</button>`,
    ),
  ].join("\n        ");

  const setsHtml = sets.length > 0
    ? sets.map((set) => renderSetCard(set, baseUrl)).join("\n")
    : `<p class="empty-state">No subscription sets available.</p>`;

  const variantsHtml = variants.length > 0
    ? variants.map((item) => renderVariantCard(item, baseUrl)).join("\n")
    : `<p class="empty-state">No filter variants available.</p>`;

  return `<!DOCTYPE html>
<html lang="en"${normalizedBaseUrl ? ` data-base-url="${escapeHtml(normalizedBaseUrl)}"` : ""}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>uBlock UX filters</title>
  <link rel="stylesheet" href="styles.css">
  <script src="app.js" defer></script>
</head>
<body>
  <header class="site-header">
    <div class="container">
      <h1>uBlock UX filters</h1>
      <p class="subtitle">Modular uBlock Origin filter lists for cleaner web experiences.</p>
      <p class="build-meta">Version <code>${escapeHtml(manifest.version)}</code> · Expires ${escapeHtml(manifest.expires)} · Generated ${escapeHtml(manifest.generatedAt)}</p>
    </div>
  </header>

  <main class="container">
    <section aria-labelledby="sets-heading">
      <h2 id="sets-heading">Subscription sets</h2>
      <p class="section-intro">Subscribe to a curated bundle of filters in uBlock Origin.</p>
      <div class="grid sets-grid">
        ${setsHtml}
      </div>
    </section>

    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading">Filter catalog</h2>
      <div class="catalog-controls">
        <label class="search-label" for="catalog-search">Search filters</label>
        <input id="catalog-search" class="search-input" type="search" placeholder="Search by host, variant, or description" autocomplete="off">
        <div class="tag-filters" role="group" aria-label="Filter by tag">
          ${tagButtons}
        </div>
        <p id="catalog-count" class="catalog-count" aria-live="polite">Showing ${variants.length} of ${variants.length} filters</p>
      </div>
      <div id="custom-list-bar" class="custom-list-bar" role="region" aria-label="Custom filter list">
        <div class="custom-list-summary">
          <h3 class="custom-list-title">Custom filter list</h3>
          <p id="custom-selected-count" class="custom-selected-count" aria-live="polite">0 selected</p>
        </div>
        <div class="custom-list-actions">
          <button type="button" id="custom-copy-rules" class="button button-primary" disabled>Copy rules for My filters</button>
          <a id="custom-subscribe-link" class="button button-secondary is-disabled" href="${escapeHtml(buildSubscribeHref("custom.txt", "uBlock UX filters: custom", baseUrl))}" aria-disabled="true" tabindex="-1">Subscribe to custom list</a>
          <button type="button" id="custom-copy-url" class="button button-secondary" disabled>Copy custom URL</button>
          <button type="button" id="custom-clear" class="button button-secondary" disabled>Clear selection</button>
        </div>
      </div>
      <div class="grid variants-grid" id="catalog-grid">
        ${variantsHtml}
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>Generated from <a href="manifest.json">manifest.json</a>.</p>
    </div>
  </footer>

  <div id="copy-status" class="sr-only" role="status" aria-live="polite"></div>
</body>
</html>
`;
}

export function renderCss(): string {
  return `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f6f8fa;
  --surface-raised: #ffffff;
  --border: #d0d7de;
  --text: #1f2328;
  --text-muted: #59636e;
  --accent: #0969da;
  --accent-text: #ffffff;
  --accent-subtle: #ddf4ff;
  --focus: #0969da;
  --code-bg: #eff1f3;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-raised: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #9198a1;
    --accent: #4493f8;
    --accent-text: #0d1117;
    --accent-subtle: #13233a;
    --focus: #58a6ff;
    --code-bg: #161b22;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
  background-color: var(--bg);
  color: var(--text);
}

.container {
  max-width: 72rem;
  margin: 0 auto;
  padding: 0 1.25rem;
}

.site-header {
  border-bottom: 1px solid var(--border);
  background-color: var(--surface);
  padding: 2rem 0;
}

.site-header h1 {
  margin: 0 0 0.5rem;
  font-size: 2rem;
  line-height: 1.2;
}

.subtitle {
  margin: 0 0 0.5rem;
  color: var(--text-muted);
}

.build-meta {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-muted);
}

main {
  padding: 2rem 0 3rem;
  display: grid;
  gap: 2.5rem;
}

section h2 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
}

.section-intro {
  margin: 0 0 1rem;
  color: var(--text-muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
  gap: 1rem;
}

.card {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background-color: var(--surface-raised);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.card[hidden] {
  display: none;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}

.card-header h3 {
  margin: 0;
  font-size: 1.125rem;
}

.card-meta {
  margin: 0.25rem 0 0;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.card-description {
  margin: 0;
}

.badge-group,
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.badge,
.tag {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--border);
  background-color: var(--surface);
  color: var(--text);
}

.badge-accent {
  background-color: var(--accent-subtle);
  border-color: var(--accent);
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: auto;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 0.85rem;
  border-radius: 0.375rem;
  border: 1px solid var(--border);
  font-size: 0.875rem;
  font-weight: 600;
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
}

.button-primary {
  background-color: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.button-secondary {
  background-color: var(--surface);
  color: var(--text);
}

.button:disabled,
.button.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.button.is-disabled {
  pointer-events: none;
}

.custom-list-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem;
  margin-bottom: 1.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background-color: var(--surface);
}

.custom-list-summary {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.custom-list-title {
  margin: 0;
  font-size: 1rem;
}

.custom-selected-count {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.custom-list-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.custom-select {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}

.custom-select-checkbox {
  width: 1rem;
  height: 1rem;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.catalog-controls {
  display: grid;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.search-label {
  font-weight: 600;
  font-size: 0.875rem;
}

.search-input {
  width: 100%;
  max-width: 28rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background-color: var(--surface-raised);
  color: var(--text);
  font: inherit;
}

.tag-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.tag-filter {
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background-color: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}

.tag-filter.is-active {
  background-color: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.catalog-count {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.asset-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: 0.5rem;
}

.asset-item {
  margin: 0;
}

.asset-item img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 0.375rem;
  border: 1px solid var(--border);
}

.rules-details {
  border-top: 1px solid var(--border);
  padding-top: 0.625rem;
}

.rules-details summary {
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
}

.rules-details pre {
  margin: 0.625rem 0 0;
  padding: 0.75rem;
  border-radius: 0.375rem;
  background-color: var(--code-bg);
  overflow-x: auto;
  font-size: 0.8125rem;
  line-height: 1.45;
  max-height: 20rem;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.site-footer {
  border-top: 1px solid var(--border);
  padding: 1.5rem 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.site-footer a {
  color: inherit;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
`;
}

export function renderAppJs(): string {
  return `(() => {
  const FALLBACK_BASE_URL = ${JSON.stringify(FALLBACK_BASE_URL)};
  const configuredBaseUrl = document.documentElement.dataset.baseUrl || "";

  function resolveBaseUrl() {
    if (configuredBaseUrl) {
      return configuredBaseUrl;
    }
    if (window.location.protocol === "file:") {
      return FALLBACK_BASE_URL;
    }
    return window.location.href;
  }

  function resolveAssetUrl(relativePath) {
    return new URL(relativePath, resolveBaseUrl()).toString();
  }

  function updateSubscribeLinks() {
    if (configuredBaseUrl) {
      return;
    }
    const links = document.querySelectorAll("[data-subscribe-path]");
    for (const link of links) {
      const path = link.getAttribute("data-subscribe-path");
      const title = link.getAttribute("data-subscribe-title") || "";
      if (!path) continue;
      const locationUrl = resolveAssetUrl(path);
      link.setAttribute(
        "href",
        "abp:subscribe?location=" + encodeURIComponent(locationUrl) + "&title=" + encodeURIComponent(title),
      );
    }
  }

  function setupCopyButtons() {
    const status = document.getElementById("copy-status");
    const buttons = document.querySelectorAll("[data-copy-path]");
    for (const button of buttons) {
      button.addEventListener("click", async () => {
        const path = button.getAttribute("data-copy-path");
        if (!path || !navigator.clipboard || !navigator.clipboard.writeText) {
          return;
        }
        const url = resolveAssetUrl(path);
        try {
          await navigator.clipboard.writeText(url);
          const original = button.textContent;
          button.textContent = "Copied";
          if (status) {
            status.textContent = "Copied URL for " + path;
          }
          window.setTimeout(() => {
            button.textContent = original;
          }, 1500);
        } catch {
          if (status) {
            status.textContent = "Failed to copy URL";
          }
        }
      });
    }
  }

  function setupCatalogFilter() {
    const searchInput = document.getElementById("catalog-search");
    const countNode = document.getElementById("catalog-count");
    const cards = Array.from(document.querySelectorAll(".variant-card"));
    const tagButtons = Array.from(document.querySelectorAll(".tag-filter"));
    const checkboxes = Array.from(document.querySelectorAll(".custom-select-checkbox"));
    const selectedCountNode = document.getElementById("custom-selected-count");
    const copyRulesButton = document.getElementById("custom-copy-rules");
    const subscribeLink = document.getElementById("custom-subscribe-link");
    const copyUrlButton = document.getElementById("custom-copy-url");
    const clearButton = document.getElementById("custom-clear");
    const status = document.getElementById("copy-status");
    const cardById = new Map();
    for (const card of cards) {
      const entryId = card.getAttribute("data-entry-id");
      if (entryId) {
        cardById.set(entryId, card);
      }
    }
    let activeTag = "";

    function getSelectedIds() {
      const ids = [];
      for (const checkbox of checkboxes) {
        if (!checkbox.checked) continue;
        const entryId = checkbox.getAttribute("data-entry-id");
        if (entryId) {
          ids.push(entryId);
        }
      }
      ids.sort((left, right) => left.localeCompare(right));
      return ids;
    }

    function buildCustomPath(selectedIds) {
      if (selectedIds.length === 0) {
        return "custom.txt";
      }
      return "custom.txt?include=" + selectedIds.join(",");
    }

    function stripHeaderLines(rulesText) {
      const lines = rulesText.replace(/\\r\\n/g, "\\n").split("\\n");
      let start = 0;
      while (start < lines.length) {
        const trimmed = lines[start].trim();
        if (trimmed === "" || trimmed.startsWith("!")) {
          start += 1;
        } else {
          break;
        }
      }
      while (lines.length > start && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }
      return lines.slice(start).join("\\n");
    }

    function buildCombinedRules(selectedIds) {
      const sections = ["! Title: ublock-ux-filters (custom)"];
      for (const entryId of selectedIds) {
        const card = cardById.get(entryId);
        if (!card || typeof card.querySelector !== "function") continue;
        const codeNode = card.querySelector("pre code");
        const raw = codeNode ? codeNode.textContent || "" : "";
        const body = stripHeaderLines(raw);
        if (body) {
          sections.push(body);
        }
      }
      return sections.join("\\n") + "\\n";
    }

    function updateCustomListUi() {
      const selectedIds = getSelectedIds();
      const hasSelection = selectedIds.length > 0;
      if (selectedCountNode) {
        selectedCountNode.textContent = selectedIds.length + " selected";
      }
      if (copyRulesButton) {
        copyRulesButton.disabled = !hasSelection;
      }
      if (copyUrlButton) {
        copyUrlButton.disabled = !hasSelection;
      }
      if (clearButton) {
        clearButton.disabled = !hasSelection;
      }
      if (subscribeLink) {
        const customPath = buildCustomPath(selectedIds);
        const locationUrl = resolveAssetUrl(customPath);
        subscribeLink.setAttribute(
          "href",
          "abp:subscribe?location=" + encodeURIComponent(locationUrl) + "&title=" + encodeURIComponent("uBlock UX filters: custom"),
        );
        subscribeLink.classList.toggle("is-disabled", !hasSelection);
        if (hasSelection) {
          subscribeLink.removeAttribute("aria-disabled");
          subscribeLink.removeAttribute("tabindex");
        } else {
          subscribeLink.setAttribute("aria-disabled", "true");
          subscribeLink.setAttribute("tabindex", "-1");
        }
      }
    }

    function setActiveTagButton(targetButton) {
      activeTag = targetButton ? targetButton.getAttribute("data-tag") || "" : "";
      for (const candidate of tagButtons) {
        const isCurrent = candidate === targetButton;
        candidate.classList.toggle("is-active", isCurrent);
        candidate.setAttribute("aria-pressed", isCurrent ? "true" : "false");
      }
    }

    function applyFilter() {
      const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
      let visible = 0;
      for (const card of cards) {
        const searchText = card.getAttribute("data-search") || "";
        const tagsRaw = card.getAttribute("data-tags") || "";
        const cardTags = tagsRaw ? tagsRaw.split(",") : [];
        const matchesQuery = !query || searchText.includes(query);
        const matchesTag = !activeTag || cardTags.includes(activeTag);
        const show = matchesQuery && matchesTag;
        card.hidden = !show;
        if (show) visible += 1;
      }
      if (countNode) {
        countNode.textContent = "Showing " + visible + " of " + cards.length + " filters";
      }
    }

    function syncUrl() {
      if (
        window.location.protocol === "file:" ||
        !window.history ||
        typeof window.history.replaceState !== "function"
      ) {
        return;
      }
      const params = new URLSearchParams(window.location.search || "");
      const query = searchInput ? searchInput.value.trim() : "";
      if (query) {
        params.set("q", query);
      } else {
        params.delete("q");
      }
      if (activeTag) {
        params.set("tag", activeTag);
      } else {
        params.delete("tag");
      }
      const selectedIds = getSelectedIds();
      if (selectedIds.length > 0) {
        params.set("include", selectedIds.join(","));
      } else {
        params.delete("include");
      }
      const search = params.toString();
      const pathname = window.location.pathname || "/";
      const hash = window.location.hash || "";
      const nextUrl = pathname + (search ? "?" + search : "") + hash;
      window.history.replaceState(null, "", nextUrl);
    }

    function applyFromUrl() {
      const params = new URLSearchParams(window.location.search || "");
      if (searchInput) {
        const q = params.get("q");
        searchInput.value = q !== null ? q : "";
      }
      const tagParam = params.get("tag") || "";
      const matched = tagParam
        ? tagButtons.find((button) => button.getAttribute("data-tag") === tagParam) || null
        : null;
      const fallback = tagButtons.find((button) => (button.getAttribute("data-tag") || "") === "") || null;
      setActiveTagButton(matched || fallback);
      const includeRaw = params.get("include") || "";
      const includeSet = new Set(
        includeRaw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      for (const checkbox of checkboxes) {
        const entryId = checkbox.getAttribute("data-entry-id") || "";
        checkbox.checked = Boolean(entryId && includeSet.has(entryId));
      }
      updateCustomListUi();
      applyFilter();
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        applyFilter();
        syncUrl();
      });
    }

    for (const button of tagButtons) {
      button.addEventListener("click", () => {
        setActiveTagButton(button);
        applyFilter();
        syncUrl();
      });
    }

    for (const checkbox of checkboxes) {
      checkbox.addEventListener("change", () => {
        updateCustomListUi();
        syncUrl();
      });
    }

    if (clearButton) {
      clearButton.addEventListener("click", () => {
        for (const checkbox of checkboxes) {
          checkbox.checked = false;
        }
        updateCustomListUi();
        syncUrl();
      });
    }

    if (subscribeLink) {
      subscribeLink.addEventListener("click", (event) => {
        if (subscribeLink.getAttribute("aria-disabled") === "true" && event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
      });
    }

    if (copyUrlButton) {
      copyUrlButton.addEventListener("click", async () => {
        const selectedIds = getSelectedIds();
        if (selectedIds.length === 0 || !navigator.clipboard || !navigator.clipboard.writeText) {
          return;
        }
        const url = resolveAssetUrl(buildCustomPath(selectedIds));
        try {
          await navigator.clipboard.writeText(url);
          const original = copyUrlButton.textContent;
          copyUrlButton.textContent = "Copied";
          if (status) {
            status.textContent = "Copied custom list URL";
          }
          window.setTimeout(() => {
            copyUrlButton.textContent = original;
          }, 1500);
        } catch {
          if (status) {
            status.textContent = "Failed to copy custom list URL";
          }
        }
      });
    }

    if (copyRulesButton) {
      copyRulesButton.addEventListener("click", async () => {
        const selectedIds = getSelectedIds();
        if (selectedIds.length === 0 || !navigator.clipboard || !navigator.clipboard.writeText) {
          return;
        }
        const rules = buildCombinedRules(selectedIds);
        try {
          await navigator.clipboard.writeText(rules);
          const original = copyRulesButton.textContent;
          copyRulesButton.textContent = "Copied";
          if (status) {
            status.textContent =
              "Copied rules for " + selectedIds.length + (selectedIds.length === 1 ? " filter" : " filters");
          }
          window.setTimeout(() => {
            copyRulesButton.textContent = original;
          }, 1500);
        } catch {
          if (status) {
            status.textContent = "Failed to copy rules";
          }
        }
      });
    }

    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
  }

  updateSubscribeLinks();
  setupCopyButtons();
  setupCatalogFilter();
})();
`;
}
