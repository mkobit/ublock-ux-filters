import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWebHandler, runCli } from "./index.ts";
import { FALLBACK_BASE_URL, renderAppJs } from "./render.ts";
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
    expect(await Bun.file(join(outDir, "manifest.json")).text()).toBe(
      await Bun.file(join(rootDir, "dist/manifest.json")).text(),
    );
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
    expect(html).toContain('id="custom-list-bar"');
    expect(html).toContain("Custom filter list");
    expect(html).toContain("0 selected");
    expect(html).toContain("Copy rules for My filters");
    expect(html).toContain("Subscribe to custom list");
    expect(html).toContain("Copy custom URL");
    expect(html).toContain("Clear selection");
    expect(html).toContain('class="custom-select-checkbox" data-entry-id="example.com::clean"');
    expect(html).toContain("Include in custom list");
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

  test("app.js syncs catalog search and tag filters with URL query string and popstate", () => {
    type Listener = () => void;

    function createMockElement(initialAttrs: Record<string, string> = {}, initialClasses: string[] = []) {
      const attrs = new Map<string, string>(Object.entries(initialAttrs));
      const classes = new Set<string>(initialClasses);
      const listeners = new Map<string, Listener[]>();

      return {
        value: "",
        hidden: false,
        textContent: "",
        classList: {
          toggle(name: string, force?: boolean) {
            if (force === undefined) {
              if (classes.has(name)) {
                classes.delete(name);
                return false;
              }
              classes.add(name);
              return true;
            }
            if (force) {
              classes.add(name);
            } else {
              classes.delete(name);
            }
            return force;
          },
          contains(name: string) {
            return classes.has(name);
          },
        },
        getAttribute(name: string) {
          return attrs.get(name) ?? null;
        },
        setAttribute(name: string, value: string) {
          attrs.set(name, value);
        },
        addEventListener(type: string, listener: Listener) {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        dispatch(type: string) {
          for (const listener of listeners.get(type) ?? []) {
            listener();
          }
        },
      };
    }

    function createHarness(options: {
      protocol?: string;
      pathname?: string;
      search?: string;
      hash?: string;
      withHistory?: boolean;
    }) {
      const searchInput = createMockElement();
      const countNode = createMockElement();
      const cards = [
        createMockElement({ "data-search": "example clean", "data-tags": "ux,clean" }),
        createMockElement({ "data-search": "other minimal", "data-tags": "minimal" }),
        createMockElement({ "data-search": "example minimal", "data-tags": "minimal" }),
      ];
      const tagButtons = [
        createMockElement({ "data-tag": "", "aria-pressed": "true" }, ["tag-filter", "is-active"]),
        createMockElement({ "data-tag": "ux", "aria-pressed": "false" }, ["tag-filter"]),
        createMockElement({ "data-tag": "clean", "aria-pressed": "false" }, ["tag-filter"]),
        createMockElement({ "data-tag": "minimal", "aria-pressed": "false" }, ["tag-filter"]),
      ];

      const windowListeners = new Map<string, Listener[]>();
      const replaceStateCalls: Array<{ state: unknown; title: string; url: string }> = [];

      const location = {
        protocol: options.protocol ?? "https:",
        pathname: options.pathname ?? "/ublock-ux-filters/",
        search: options.search ?? "",
        hash: options.hash ?? "",
        get href() {
          return `${this.protocol}//example.github.io${this.pathname}${this.search}${this.hash}`;
        },
      };

      const history = options.withHistory === false
        ? undefined
        : {
            replaceState(state: unknown, title: string, url: string) {
              replaceStateCalls.push({ state, title, url });
              const parsed = new URL(url, "https://example.github.io");
              location.pathname = parsed.pathname;
              location.search = parsed.search;
              location.hash = parsed.hash;
            },
          };

      const mockWindow = {
        location,
        history,
        addEventListener(type: string, listener: Listener) {
          const list = windowListeners.get(type) ?? [];
          list.push(listener);
          windowListeners.set(type, list);
        },
        dispatchPopstate() {
          for (const listener of windowListeners.get("popstate") ?? []) {
            listener();
          }
        },
        setTimeout,
      };

      const mockDocument = {
        documentElement: { dataset: { baseUrl: "https://example.github.io/ublock-ux-filters/" } },
        getElementById(id: string) {
          if (id === "catalog-search") return searchInput;
          if (id === "catalog-count") return countNode;
          return null;
        },
        querySelectorAll(selector: string) {
          if (selector === ".variant-card") return cards;
          if (selector === ".tag-filter") return tagButtons;
          return [];
        },
      };

      const runApp = new Function("window", "document", "navigator", "URL", "URLSearchParams", renderAppJs());
      runApp(mockWindow, mockDocument, {}, URL, URLSearchParams);

      return { searchInput, countNode, cards, tagButtons, location, replaceStateCalls, mockWindow };
    }

    // 1. Initializes from ?q= and ?tag= on load
    const initHarness = createHarness({ search: "?q=example&tag=minimal" });
    expect(initHarness.searchInput.value).toBe("example");
    expect(initHarness.tagButtons[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(initHarness.tagButtons[0]!.classList.contains("is-active")).toBe(false);
    expect(initHarness.tagButtons[3]!.getAttribute("aria-pressed")).toBe("true");
    expect(initHarness.tagButtons[3]!.classList.contains("is-active")).toBe(true);
    expect(initHarness.cards.map((card) => card.hidden)).toEqual([true, true, false]);
    expect(initHarness.countNode.textContent).toBe("Showing 1 of 3 filters");

    // 2. Falls back to "All" when ?tag= is unknown
    const unknownTagHarness = createHarness({ search: "?tag=nonexistent" });
    expect(unknownTagHarness.tagButtons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(unknownTagHarness.tagButtons[0]!.classList.contains("is-active")).toBe(true);
    expect(unknownTagHarness.cards.map((card) => card.hidden)).toEqual([false, false, false]);
    expect(unknownTagHarness.countNode.textContent).toBe("Showing 3 of 3 filters");

    // 3. Syncs input and tag clicks via history.replaceState and preserves hash
    const syncHarness = createHarness({ hash: "#catalog-heading" });
    syncHarness.searchInput.value = "example";
    syncHarness.searchInput.dispatch("input");
    expect(syncHarness.replaceStateCalls.at(-1)?.url).toBe("/ublock-ux-filters/?q=example#catalog-heading");

    syncHarness.tagButtons[3]!.dispatch("click");
    expect(syncHarness.replaceStateCalls.at(-1)?.url).toBe("/ublock-ux-filters/?q=example&tag=minimal#catalog-heading");

    syncHarness.searchInput.value = "   ";
    syncHarness.searchInput.dispatch("input");
    expect(syncHarness.replaceStateCalls.at(-1)?.url).toBe("/ublock-ux-filters/?tag=minimal#catalog-heading");

    syncHarness.tagButtons[0]!.dispatch("click");
    expect(syncHarness.replaceStateCalls.at(-1)?.url).toBe("/ublock-ux-filters/#catalog-heading");

    // 4. Re-reads window.location.search and re-applies filters on popstate
    initHarness.location.search = "?q=other";
    initHarness.mockWindow.dispatchPopstate();
    expect(initHarness.searchInput.value).toBe("other");
    expect(initHarness.tagButtons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(initHarness.tagButtons[3]!.getAttribute("aria-pressed")).toBe("false");
    expect(initHarness.cards.map((card) => card.hidden)).toEqual([true, false, true]);
    expect(initHarness.countNode.textContent).toBe("Showing 1 of 3 filters");

    initHarness.location.search = "";
    initHarness.mockWindow.dispatchPopstate();
    expect(initHarness.searchInput.value).toBe("");
    expect(initHarness.cards.map((card) => card.hidden)).toEqual([false, false, false]);
    expect(initHarness.countNode.textContent).toBe("Showing 3 of 3 filters");

    // 5. Guards history.replaceState on file: protocol or missing history.replaceState
    const fileHarness = createHarness({ protocol: "file:", pathname: "/tmp/index.html" });
    fileHarness.searchInput.value = "example";
    fileHarness.searchInput.dispatch("input");
    fileHarness.tagButtons[1]!.dispatch("click");
    expect(fileHarness.replaceStateCalls).toHaveLength(0);
    expect(fileHarness.cards.map((card) => card.hidden)).toEqual([false, true, true]);

    const noHistoryHarness = createHarness({ withHistory: false });
    noHistoryHarness.searchInput.value = "other";
    noHistoryHarness.searchInput.dispatch("input");
    expect(noHistoryHarness.cards.map((card) => card.hidden)).toEqual([true, false, true]);
  });

  test("app.js manages custom list selection, ?include= sync, abp:subscribe URLs, and combined rule copy", async () => {
    type Listener = (event?: { preventDefault?: () => void }) => void;

    function createMockElement(
      initialAttrs: Record<string, string> = {},
      initialClasses: string[] = [],
      rulesText = "",
    ) {
      const attrs = new Map<string, string>(Object.entries(initialAttrs));
      const classes = new Set<string>(initialClasses);
      const listeners = new Map<string, Listener[]>();
      const codeNode = { textContent: rulesText };

      return {
        value: "",
        checked: false,
        disabled: false,
        hidden: false,
        textContent: "",
        classList: {
          toggle(name: string, force?: boolean) {
            if (force === undefined) {
              if (classes.has(name)) {
                classes.delete(name);
                return false;
              }
              classes.add(name);
              return true;
            }
            if (force) {
              classes.add(name);
            } else {
              classes.delete(name);
            }
            return force;
          },
          contains(name: string) {
            return classes.has(name);
          },
        },
        getAttribute(name: string) {
          return attrs.get(name) ?? null;
        },
        setAttribute(name: string, value: string) {
          attrs.set(name, value);
        },
        removeAttribute(name: string) {
          attrs.delete(name);
        },
        querySelector(selector: string) {
          if (selector === "pre code") {
            return codeNode;
          }
          return null;
        },
        addEventListener(type: string, listener: Listener) {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        dispatch(type: string, event?: { preventDefault?: () => void }) {
          for (const listener of listeners.get(type) ?? []) {
            listener(event);
          }
        },
      };
    }

    function createCustomHarness(options: { search?: string; baseUrl?: string } = {}) {
      const searchInput = createMockElement();
      const countNode = createMockElement();
      const selectedCountNode = createMockElement();
      const copyRulesButton = createMockElement();
      copyRulesButton.textContent = "Copy rules for My filters";
      copyRulesButton.disabled = true;
      const subscribeLink = createMockElement({ "aria-disabled": "true", tabindex: "-1" }, ["button", "is-disabled"]);
      const copyUrlButton = createMockElement();
      copyUrlButton.textContent = "Copy custom URL";
      copyUrlButton.disabled = true;
      const clearButton = createMockElement();
      clearButton.disabled = true;
      const statusNode = createMockElement();

      const cards = [
        createMockElement(
          { "data-entry-id": "zeta.org::minimal", "data-search": "zeta minimal", "data-tags": "minimal" },
          [],
          "! Title: Zeta\n! Expires: 1 day\n\nzeta.org##.ad\n! Inline comment\nzeta.org##.promo\n",
        ),
        createMockElement(
          { "data-entry-id": "alpha.com::clean", "data-search": "alpha clean", "data-tags": "ux" },
          [],
          "! Title: Alpha\nalpha.com##.banner\n",
        ),
      ];
      const checkboxes = [
        createMockElement({ "data-entry-id": "zeta.org::minimal" }),
        createMockElement({ "data-entry-id": "alpha.com::clean" }),
      ];
      const tagButtons = [createMockElement({ "data-tag": "", "aria-pressed": "true" }, ["tag-filter", "is-active"])];

      const windowListeners = new Map<string, Listener[]>();
      const replaceStateCalls: string[] = [];
      const copiedTexts: string[] = [];

      const location = {
        protocol: "https:",
        pathname: "/ublock-ux-filters/",
        search: options.search ?? "",
        hash: "",
        get href() {
          return `https://filters.example.test${this.pathname}${this.search}${this.hash}`;
        },
      };

      const mockWindow = {
        location,
        history: {
          replaceState(_state: unknown, _title: string, url: string) {
            replaceStateCalls.push(url);
            const parsed = new URL(url, "https://filters.example.test");
            location.pathname = parsed.pathname;
            location.search = parsed.search;
            location.hash = parsed.hash;
          },
        },
        addEventListener(type: string, listener: Listener) {
          const list = windowListeners.get(type) ?? [];
          list.push(listener);
          windowListeners.set(type, list);
        },
        dispatchPopstate() {
          for (const listener of windowListeners.get("popstate") ?? []) {
            listener();
          }
        },
        setTimeout,
      };

      const mockDocument = {
        documentElement: { dataset: options.baseUrl ? { baseUrl: options.baseUrl } : {} },
        getElementById(id: string) {
          if (id === "catalog-search") return searchInput;
          if (id === "catalog-count") return countNode;
          if (id === "custom-selected-count") return selectedCountNode;
          if (id === "custom-copy-rules") return copyRulesButton;
          if (id === "custom-subscribe-link") return subscribeLink;
          if (id === "custom-copy-url") return copyUrlButton;
          if (id === "custom-clear") return clearButton;
          if (id === "copy-status") return statusNode;
          return null;
        },
        querySelectorAll(selector: string) {
          if (selector === ".variant-card") return cards;
          if (selector === ".tag-filter") return tagButtons;
          if (selector === ".custom-select-checkbox") return checkboxes;
          return [];
        },
      };

      const mockNavigator = {
        clipboard: {
          async writeText(text: string) {
            copiedTexts.push(text);
          },
        },
      };

      const runApp = new Function("window", "document", "navigator", "URL", "URLSearchParams", renderAppJs());
      runApp(mockWindow, mockDocument, mockNavigator, URL, URLSearchParams);

      return {
        checkboxes,
        selectedCountNode,
        copyRulesButton,
        subscribeLink,
        copyUrlButton,
        clearButton,
        statusNode,
        location,
        replaceStateCalls,
        copiedTexts,
        mockWindow,
      };
    }

    // 1. Initial empty selection disables actions and restores from ?include=
    const emptyHarness = createCustomHarness();
    expect(emptyHarness.selectedCountNode.textContent).toBe("0 selected");
    expect(emptyHarness.copyRulesButton.disabled).toBe(true);
    expect(emptyHarness.copyUrlButton.disabled).toBe(true);
    expect(emptyHarness.clearButton.disabled).toBe(true);
    expect(emptyHarness.subscribeLink.getAttribute("aria-disabled")).toBe("true");

    const preselected = createCustomHarness({
      search: "?include=zeta.org::minimal,alpha.com::clean",
    });
    expect(preselected.checkboxes[0]!.checked).toBe(true);
    expect(preselected.checkboxes[1]!.checked).toBe(true);
    expect(preselected.selectedCountNode.textContent).toBe("2 selected");
    expect(preselected.copyRulesButton.disabled).toBe(false);
    expect(preselected.subscribeLink.getAttribute("aria-disabled")).toBeNull();
    expect(preselected.subscribeLink.getAttribute("href")).toBe(
      `abp:subscribe?location=${encodeURIComponent(
        "https://filters.example.test/ublock-ux-filters/custom.txt?include=alpha.com::clean,zeta.org::minimal",
      )}&title=${encodeURIComponent("uBlock UX filters: custom")}`,
    );

    // 2. Selecting checkboxes updates sorted ?include=, subscribe link (with baseUrl), and clipboard actions
    const interactive = createCustomHarness({ baseUrl: "https://cdn.example.org/ublock/" });
    interactive.checkboxes[0]!.checked = true;
    interactive.checkboxes[0]!.dispatch("change");
    expect(interactive.selectedCountNode.textContent).toBe("1 selected");
    expect(interactive.replaceStateCalls.at(-1)).toBe("/ublock-ux-filters/?include=zeta.org%3A%3Aminimal");

    interactive.checkboxes[1]!.checked = true;
    interactive.checkboxes[1]!.dispatch("change");
    expect(interactive.selectedCountNode.textContent).toBe("2 selected");
    expect(interactive.replaceStateCalls.at(-1)).toBe(
      "/ublock-ux-filters/?include=alpha.com%3A%3Aclean%2Czeta.org%3A%3Aminimal",
    );
    expect(interactive.subscribeLink.getAttribute("href")).toBe(
      `abp:subscribe?location=${encodeURIComponent(
        "https://cdn.example.org/ublock/custom.txt?include=alpha.com::clean,zeta.org::minimal",
      )}&title=${encodeURIComponent("uBlock UX filters: custom")}`,
    );

    interactive.copyUrlButton.dispatch("click");
    await Promise.resolve();
    expect(interactive.copiedTexts.at(-1)).toBe(
      "https://cdn.example.org/ublock/custom.txt?include=alpha.com::clean,zeta.org::minimal",
    );
    expect(interactive.statusNode.textContent).toBe("Copied custom list URL");

    interactive.copyRulesButton.dispatch("click");
    await Promise.resolve();
    expect(interactive.copiedTexts.at(-1)).toBe(
      [
        "! Title: ublock-ux-filters (custom)",
        "alpha.com##.banner",
        "zeta.org##.ad",
        "! Inline comment",
        "zeta.org##.promo",
        "",
      ].join("\n"),
    );
    expect(interactive.statusNode.textContent).toBe("Copied rules for 2 filters");

    // 3. Clear selection and popstate restore
    interactive.clearButton.dispatch("click");
    expect(interactive.selectedCountNode.textContent).toBe("0 selected");
    expect(interactive.checkboxes.map((box) => box.checked)).toEqual([false, false]);
    expect(interactive.replaceStateCalls.at(-1)).toBe("/ublock-ux-filters/");
    expect(interactive.copyRulesButton.disabled).toBe(true);

    interactive.location.search = "?include=alpha.com::clean";
    interactive.mockWindow.dispatchPopstate();
    expect(interactive.checkboxes.map((box) => box.checked)).toEqual([false, true]);
    expect(interactive.selectedCountNode.textContent).toBe("1 selected");
  });

  test("createLocalWebHandler serves built catalog files, custom lists, 404s, and blocks path traversal", async () => {
    const rootDir = await makeTempWorkspace();
    await writeFixture(rootDir, { includeAssets: true });
    await runCli(["build", "--dist", "dist", "--out", "dist-web"], rootDir);

    const outDir = join(rootDir, "dist-web");
    const handler = createLocalWebHandler(outDir);

    const indexRes = await handler(new Request("http://localhost:8787/"));
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await indexRes.text()).toContain("<!DOCTYPE html>");

    const cssRes = await handler(new Request("http://localhost:8787/styles.css"));
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await cssRes.text()).toContain(":root");

    const setRes = await handler(new Request("http://localhost:8787/sets/all-defaults.txt"));
    expect(setRes.status).toBe(200);
    expect(setRes.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await setRes.text()).toContain("example.com##.banner");

    const customRes = await handler(new Request("http://localhost:8787/custom.txt?include=example.com::clean"));
    expect(customRes.status).toBe(200);
    expect(customRes.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await customRes.text()).toContain("! Includes: example.com::clean");

    const missingRes = await handler(new Request("http://localhost:8787/does-not-exist.txt"));
    expect(missingRes.status).toBe(404);

    const encodedTraversalRes = await handler(new Request("http://localhost:8787/%2e%2e/dist/manifest.json"));
    expect([400, 404]).toContain(encodedTraversalRes.status);

    const directTraversalRes = await handler(new Request("http://localhost:8787/../dist/manifest.json"));
    expect([400, 404]).toContain(directTraversalRes.status);
  });
});
