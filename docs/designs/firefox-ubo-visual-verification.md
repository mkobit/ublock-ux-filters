# Firefox and uBlock Origin visual verification and capture

*   **Author:** Mike Kobit
*   **Status:** Proposed
*   **Date:** 2026-11-24

--------------------------------------------------------------------------------

## Overview

`ublock-ux-filters` compiles plain-text uBlock Origin (uBO) filter lists that change the visual appearance and layout of third-party websites such as eBay, Hacker News, and Algolia HN Search.
Today, the build validates filter syntax and domain scoping, but it does not run the compiled filters in a real browser.
Authors and reviewers must manually load filters into their personal browser profile to check visual changes, hover states, and regressions.

This design adds an isolated Firefox and uBlock Origin browser automation subsystem in a dedicated workspace package (`packages/preview`).
One shared browser-provisioning core supports three workflows:

1.  **Local interactive preview:** Opens a visible, isolated Firefox window with a locally built filter preloaded so an author can inspect hover states, scrolling, and live CSS changes without touching their personal Firefox profile.
2.  **Automated CI and local capture:** Launches headless Firefox with a pinned official uBO XPI, proves uBO loaded and injected rules via a local loopback canary page, captures up to 3-way visual comparison screenshots (`raw unfiltered` vs. `base branch` vs. `PR branch`, or 2-way `raw` vs. `PR` for new variants), and writes a structured JSON report and static HTML side-by-side gallery.
3.  **On-demand README demos:** Captures scripted stills or animated WebP demos for per-package READMEs, kept local and separate from PR CI checks.

## The problem

Filter lists in this repository modify live third-party websites through uBO cosmetic and `:style()` rules.
Static syntax validation catches malformed selectors, but it cannot verify that rules actually match live DOM structures, apply readable colors, or avoid breaking interactive layouts.

Adding real-browser verification introduces four concrete failure modes that naive screenshot harnesses miss:

*   **Silent unfiltered captures:** Loading a signed uBO XPI into a fresh Firefox profile does not guarantee that uBO has finished initializing or compiling custom rules before the first page navigates.
    On first boot, uBO also downloads ~15 MB of default external filter lists, which adds network latency and flakiness.
    Without an explicit readiness gate and disabled default lists, "filtered" screenshots can silently render without the custom filter applied.
*   **Datacenter bot blocking on live sites:** GitHub Actions runners use cloud IP ranges that third-party sites such as `ebay.com` frequently block with CAPTCHAs, interstitials, or HTTP 403/503 responses.
    Retrying from the same cloud IP does not clear IP blocks, so gating PR merges on live third-party page loads turns external bot defenses into false merge blockers.
*   **Host profile interference and environment drift:** Launching Firefox without `--no-remote -profile <tmpDir>` can open tabs in the developer's running host Firefox profile.
    Host OS dark-mode preferences (`prefers-color-scheme: dark`) can also make dark-mode filters appear active even when uBO failed to inject rules.
*   **Build output contamination and CI security:** `bun run build` validates that `dist/` contains only compiled filter files from `manifest.json`.
    Mixing screenshots into `dist/` breaks build verification, and running third-party website JavaScript in a CI job with elevated tokens risks credential exposure.

This design solves these problems by separating deterministic uBO verification (a local loopback canary check) from best-effort live-site capture, isolating each package's CI capture configuration in `filters/<host>/filter.toml`, writing all visual artifacts to `.artifacts/visual/`, and running CI capture in a separate read-only job.

## Goals

*   Keep `packages/builder` fast and browser-free by placing all browser provisioning and capture code in a separate workspace package (`packages/preview`) that consumes `dist/manifest.json` and `dist/raw/<host>/<variant>.txt`.
*   Pin official Mozilla Firefox, `geckodriver`, and the signed official uBlock Origin XPI in one tracked manifest with SHA-256 verification and local/CI caching.
*   Run every browser session in an isolated temporary profile (`--no-remote -profile <tmpDir>`) with a sanitized child environment (stripping `GITHUB_TOKEN`, `GH_TOKEN`, and cloud credentials), pinned viewport, DPR, locale (`en-US`), timezone, light color scheme (`ui.systemUsesDarkTheme = 0`), and signal-safe cleanup (`--keep-profile` for local debugging).
*   Prove uBO initialized and applied custom rules before any live navigation using a deterministic local loopback canary page (`http://127.0.0.1:<port>/canary`).
*   Declare optional `[preview]` target URLs and per-host CI enablement flags in `filters/<host>/filter.toml`, validated by `@ubdf/schema` against `allowed_domains`, so bot-blocking domains can stay local-only without blocking other packages.
*   Provide a local headed interactive preview command (`bun run preview --host <host> [--variant <variant>]`) with no WebDriver timeouts so authors can manually inspect live pages.
*   Provide a headless capture command (`bun run capture`) that produces 3-way comparisons (`raw`, `base`, `PR`, or 2-way `raw` vs. `PR` for new variants), bounded retries, typed error records (carrying final URL, HTTP status, retry count, phase timings, and failure screenshot path), a JSON run report, and a static HTML side-by-side gallery under `.artifacts/visual/`.
*   Run visual capture in GitHub Actions as a separate `visual-capture` job (`needs: checks`, `permissions: contents: read`, short artifact retention, `$GITHUB_STEP_SUMMARY` table) targeting only affected variants.
*   Support on-demand local README demo capture (static PNG or animated WebP) via `bun run demo`, keeping heavy media encoders out of PR CI.
*   Stage implementation across six incremental, non-P0 Beads issues (P2/P3) so each unit delivers testable value independently.

## Non-goals

*   Checking third-party website HTML fixtures into git or maintaining a permanent MITM fixture archive.
*   Automated baseline pixel-diff or SSIM threshold gates in CI.
*   Bypassing CAPTCHAs, WAFs, or anti-bot challenges.
*   Multi-browser matrices (Chromium, MV3 uBlock Origin Lite, Safari).
*   Authenticated or logged-in site flows.
*   Auto-committing generated README demo media from CI.
*   Cross-variant `includes` composition in v0 (the harness loads `dist/raw/<host>/<variant>.txt` directly).

## Open questions

None. Resolved architectural decisions:

*   **Per-run `policies.json` isolation:** Generate `distribution/policies.json` per run and insert it into a per-session hardlinked or reflinked copy of the cached Firefox installation inside `<tmpDir>/firefox-bin/`.
*   **CI merge-gate policy:** Both `UBO_LOAD_ERROR` (loopback canary failure) and live-site errors (`BOT_CHALLENGE`, `HTTP_ERROR`, `NAVIGATION_TIMEOUT`) on `ci = true` hosts fail the `visual-capture` job after retries. Hosts that block CI runners set `ci = false` in `filter.toml` so CI records `SKIPPED_BY_CONFIG` and does not fail.

## Critical user journeys (CUJs)

### CUJ 1: Author previews a filter change interactively

*   **Given**: The author edited a `.ubo` file under `filters/news.ycombinator.com/` and has Mise and Bun installed.
*   **When**: The author runs `mise exec -- bun run preview --host news.ycombinator.com`.
*   **Then**: The CLI builds the filter, verifies the cached Firefox and uBO XPI hashes, creates a temporary profile with the compiled variant preloaded and default uBO lists disabled, opens a visible isolated Firefox window to the declared `[preview]` URLs without touching the host Firefox profile, and removes the temporary profile when the author closes the browser or sends `SIGINT`.

### CUJ 2: Reviewer inspects 3-way visual changes on a pull request

*   **Given**: A pull request modifies `filters/news.ycombinator.com/github-dark.ubo` and CI runs the workflow.
*   **When**: The fast `checks` job passes and triggers the `visual-capture` job (`permissions: contents: read`).
*   **Then**: The job detects the affected host and variant by diffing against the PR base SHA, compiles both the base ref and PR ref, passes the loopback canary check in headless Firefox, captures `raw`, `base`, and `PR` screenshots for CI-enabled URLs, uploads `.artifacts/visual/` (PNGs, JSON report, and static HTML side-by-side gallery) as a short-retention artifact, and writes a Markdown status table (including any typed error diagnostics) to `$GITHUB_STEP_SUMMARY`.

### CUJ 3: Author adds a brand-new filter variant

*   **Given**: A pull request adds a new variant that does not exist on the base branch.
*   **When**: The capture command runs against the PR and base refs.
*   **Then**: The harness detects that the variant is absent from the base build, captures 2-way panels (`raw` and `PR`) instead of failing on a missing base file, and labels the gallery entry as a new variant.

### CUJ 4: Bot-blocking host is isolated from CI failures

*   **Given**: `filters/ebay.com/filter.toml` declares `[preview]` URLs with CI live capture disabled (`ci = false`) because `ebay.com` blocks cloud runner IPs.
*   **When**: The author runs `bun run preview --host ebay.com` locally, and later opens a PR touching `filters/ebay.com/`.
*   **Then**: Local preview and local capture use the declared eBay URLs normally, while the CI `visual-capture` job skips live eBay navigation, records `SKIPPED_BY_CONFIG` in the report and job summary, and does not block the PR.

### CUJ 5: Author records a README demo locally

*   **Given**: The author wants a visual demo for `filters/news.ycombinator.com/README.md`.
*   **When**: The author runs `mise exec -- bun run demo --host news.ycombinator.com` locally.
*   **Then**: The command executes scripted interactions (such as scrolling or hovering) in isolated Firefox, saves a static PNG or animated WebP under the target documentation asset path, and validates that the output stays within the configured file-size limit without adding media encoders to PR CI.

## Technical plan (architecture)

### Package boundaries and workspace layout

All browser provisioning, WebDriver control, and capture logic lives in a new workspace package, `packages/preview` (`@ubdf/preview`).
`packages/builder` stays browser-free and continues to own linting, compiling `.ubo` files into `dist/raw/<host>/<variant>.txt`, and writing `dist/manifest.json`.
`packages/schema` (`@ubdf/schema`) adds optional `[preview]` metadata to `HostMeta` so each `filters/<host>/filter.toml` declares its own live test URLs and CI enablement flags.
All visual outputs (screenshots, JSON reports, and static HTML galleries) write to `.artifacts/visual/` rather than `dist/` so `bun run build` output validation remains strict.

### Preview configuration schema (`packages/schema`)

`HostMeta` in `packages/schema/src/index.ts` gains an optional `preview` table in `filters/<host>/filter.toml`:

```toml
[preview]
ci = true

[[preview.targets]]
url = "https://news.ycombinator.com/"
label = "hn-frontpage"
ci = true
wait_for = ".athing" # optional CSS selector
```

Schema validation rules:

*   Each `preview.targets[].url` must parse as an `https:` URL whose hostname matches `allowed_domains` for that host.
*   Each `preview.targets[].label` must be a unique slug within the host so screenshot filenames are deterministic.
*   `preview.ci` (default `true`) controls whether CI capture runs for the host; individual `targets[].ci` entries can override it (for example, to skip a specific bot-blocking URL while keeping others enabled).
*   `packages/preview` reads `filter.toml` and `dist/manifest.json` directly and loads `dist/raw/<host>/<variant>.txt` without duplicating builder compilation logic.

### Pinned browser toolchain and cache

`packages/preview` tracks one JSON manifest of pinned official binaries and their SHA-256 checksums:

*   Firefox `153.7.0esr` (`linux-x86_64/en-US/firefox-153.7.0esr.tar.xz`, sha256 `7d2eb92ca3a7b2a83de092eb9b94c853980214de2fbfdccb2ac39d61c593c5a5`)
*   `geckodriver` `v0.37.1` (`geckodriver-v0.37.1-linux64.tar.gz`, sha256 `e815130ea95983e162ae91843b48d3a3ce911735635fce83a647afde21e09f7e`)
*   uBlock Origin `1.77.0` (`uBlock0_1.77.0.firefox.signed.xpi`, sha256 `894ea48dedd26a637ab98ba627ae70b7ed94798eabfd4b089f5e5e73524a24eb`)

The installer downloads missing archives into `~/.cache/ublock-ux-filters/browser/` (overridable via `UBOUF_CACHE_DIR`), verifies each archive's SHA-256 before extraction, and keeps the extracted Firefox directory read-only.
GitHub Actions caches `~/.cache/ublock-ux-filters/browser/` keyed by the manifest hash.

### Per-session isolation and uBO provisioning

Every browser launch (`raw`, `base`, `PR`, `preview`, or `demo`) runs in a fresh temporary workspace under `<tmpDir>`:

```text
~/.cache/ublock-ux-filters/browser/firefox-153.7.0esr/   (read-only cache)
        │
        │  hardlink / reflink tree (copy fallback across filesystems)
        ▼
<tmpDir>/firefox-bin/
  ├── firefox
  └── distribution/
        └── policies.json        (generated per run: uBO XPI + adminSettings)

<tmpDir>/profile/
  └── user.js                    (viewport, DPR, en-US, UTC, ui.systemUsesDarkTheme=0)
```

Key isolation guarantees:

*   **Per-run `policies.json`:** Firefox reads `distribution/policies.json` next to the `firefox` executable. Cloning the cached Firefox directory via hardlinks or copy-on-write reflinks into `<tmpDir>/firefox-bin/` lets each run generate its own `distribution/policies.json` without mutating the shared cache or blocking concurrent sessions.
*   **Zero-click uBO setup:** `policies.json` installs the cached signed uBO XPI and sets `3rdparty.Extensions["uBlock0@raymondhill.net"].adminSettings` with `autoUpdate: false`, empty `selectedFilterLists` (disabling the ~15 MB default external downloads), and the target compiled ruleset injected via `userFilters` (or omitted for the `raw` pass).
*   **Environment and profile isolation:** Child processes (`firefox` and `geckodriver`) receive a sanitized environment that strips `GITHUB_TOKEN`, `GH_TOKEN`, and cloud credential variables. Firefox always launches with `--no-remote -profile <tmpDir>/profile`.
*   **Deterministic rendering:** `user.js` pins `ui.systemUsesDarkTheme = 0` (light OS baseline so dark-mode filters cannot pass by inheriting host dark mode), `intl.accept_languages = "en-US"`, fixed viewport (`1440x900`), and DPR (`1`).
*   **Cleanup:** `SIGINT` and `SIGTERM` handlers terminate child processes and delete `<tmpDir>` unless `--keep-profile` is passed for local debugging.

### Loopback canary gate

Before navigating to any live third-party URL in `capture`, the session starts an ephemeral HTTP server on `127.0.0.1:<port>` serving `/canary`:

1.  The active uBO ruleset for the run includes a deterministic canary cosmetic rule (`127.0.0.1##.ubouf-canary:style(background-color: rgb(255, 0, 128) !important)`).
2.  Headless Firefox navigates to `http://127.0.0.1:<port>/canary` and polls `getComputedStyle(document.querySelector(".ubouf-canary")).backgroundColor` with a short timeout.
3.  If the computed style does not change, the run aborts immediately with a typed `UBO_LOAD_ERROR` rather than capturing silent unfiltered screenshots.

### Three workflow entrypoints

```text
                  ┌──────────────────────────────────────┐
                  │  packages/preview core               │
                  │  - Binary/XPI cache + SHA-256        │
                  │  - <tmpDir> profile + policies.json  │
                  │  - Sanitized env + cleanup           │
                  └──────┬───────────┬────────────┬──────┘
                         │           │            │
         ┌───────────────▼─┐   ┌─────▼──────────┐ ┌▼─────────────────┐
         │ bun run preview │   │ bun run capture│ │ bun run demo     │
         │ (headed, local) │   │ (headless, CI) │ │ (local WebP/PNG) │
         └─────────────────┘   └─────┬──────────┘ └──────────────────┘
                                     │
                                     ▼
                           .artifacts/visual/
                             ├── report.json
                             ├── index.html
                             └── <host>/<variant>/<target>/
                                   ├── raw.png
                                   ├── base.png (omitted if new variant)
                                   └── pr.png
```

1.  **Interactive preview (`bun run preview --host <host> [--variant <variant>]`):** Compiles the current workspace, provisions a visible Firefox session with the target filter, opens the declared `[preview.targets]` tabs, and waits without WebDriver timeouts until the user closes Firefox or sends `SIGINT`.
2.  **Automated capture (`bun run capture`):**
    *   Accepts `--host` / `--variant` filters or `--base-ref <sha>` for PR diff mode.
    *   In PR diff mode, diffs modified files under `filters/` against `<base-ref>` to select only affected `<host>::<variant>` pairs, compiles both `<base-ref>` (into a temporary build dir) and the working tree, and marks variants absent from `<base-ref>` as 2-way (`raw` + `pr`) instead of 3-way (`raw` + `base` + `pr`).
    *   Skips targets with `ci = false` when `--ci` is set, recording `SKIPPED_BY_CONFIG`.
    *   Runs each pass (`raw`, `base`, `pr`) in its own isolated session through `geckodriver`, passes the loopback canary check (on `base` and `pr`), navigates to each live URL with bounded retries, and saves full-viewport PNGs.
    *   Classifies failures into typed error records (`UBO_LOAD_ERROR`, `BOT_CHALLENGE`, `HTTP_ERROR`, `NAVIGATION_TIMEOUT`, `SELECTOR_TIMEOUT`) containing `finalUrl`, `httpStatus`, `retryCount`, `phaseTimingsMs`, and `failureScreenshotPath`.
    *   Writes `.artifacts/visual/report.json` and a self-contained `.artifacts/visual/index.html` side-by-side comparison gallery.
3.  **On-demand README demos (`bun run demo --host <host> [--variant <variant>]`):** Runs scripted scroll/hover steps locally and saves static PNGs or animated WebP under `filters/<host>/assets/`, checking a configured max file-size budget without adding `ffmpeg` or `sharp` to PR CI.

### CI workflow integration (`.github/workflows/ci.yml`)

A new `visual-capture` job runs after `checks` (`needs: checks`, `permissions: contents: read`, `if: github.event_name == 'pull_request'`):

1.  Checks out with `fetch-depth: 0` (or fetches `github.event.pull_request.base.sha`) and `persist-credentials: false`.
2.  Restores `~/.cache/ublock-ux-filters/browser/` via `actions/cache`.
3.  Runs `bun run capture --ci --base-ref ${{ github.event.pull_request.base.sha }}`.
4.  Uploads `.artifacts/visual/` via `actions/upload-artifact` with short retention (7 days), even if capture fails so failure screenshots remain inspectable.
5.  Writes a Markdown table of captured variants, panel counts, timings, and typed error diagnostics to `$GITHUB_STEP_SUMMARY`.
6.  Fails the job if `UBO_LOAD_ERROR` occurs or if any `ci = true` target returns a live-site error after retries.

## Alternatives considered

### Alternative A: Playwright or Puppeteer

*   **Pros:** Single npm dependency with built-in browser download, auto-waiting selectors, and screenshot APIs.
*   **Cons:** Playwright ships a patched Firefox build that does not load standard signed XPIs or honor Firefox `distribution/policies.json` enterprise policies the same way as official Mozilla Firefox.
*   **Reason for rejection:** Rejected because testing uBlock Origin filters requires official Mozilla Firefox and the signed uBO XPI.

### Alternative B: Checked-in HTML fixtures with a local HTTP server

*   **Pros:** Removes external network flakiness and datacenter bot blocks in CI.
*   **Cons:** Static HTML snapshots drift from live third-party websites and bloat the git repository. In the earlier `ubouf-org` spike, serving `hn.algolia.com` over local HTTP also failed with `nssFailure2` when Firefox upgraded the hostname to HTTPS.
*   **Reason for rejection:** Rejected by author: live preview URLs with per-host CI flags and a deterministic loopback canary avoid fixture drift and local HTTPS certificate management.

### Alternative C: Automated baseline pixel-diff or SSIM gates in CI

*   **Pros:** Automatically flags visual changes without human inspection of every screenshot.
*   **Cons:** Live third-party sites change content every minute (news titles, prices, timestamps), and cross-OS font rendering causes false failures.
*   **Reason for rejection:** Rejected because pixel-diff gates produce high false-positive rates on live websites; side-by-side 3-way HTML galleries keep human reviewers in control.

### Alternative D: Direct CSS injection without uBlock Origin

*   **Pros:** Avoids installing an extension or provisioning `policies.json`.
*   **Cons:** Skips uBO's filter parser, domain scoping, cosmetic selector matching, and `:style()` injection behavior, so tests would not catch uBO-specific failures.
*   **Reason for rejection:** Rejected because the harness must verify real uBO filter execution.

### Alternative E: Automating the uBlock Origin dashboard UI

*   **Pros:** Uses the same steps a human user follows in the extension popup and dashboard.
*   **Cons:** Fragile across uBO releases when DOM structure or element IDs change, and adds extra navigation steps on every run.
*   **Reason for rejection:** Rejected because declarative `distribution/policies.json` (`adminSettings`) is version-stable and headless-safe.

### Alternative F: Bundling image stitching or `ffmpeg` into PR CI

*   **Pros:** Produces single combined comparison images or animated WebP previews directly in CI artifacts.
*   **Cons:** Adds heavy native dependencies (`ffmpeg`, `sharp`) and OS-specific install failures to every PR run.
*   **Reason for rejection:** Rejected because plain PNG files rendered side-by-side in a static HTML gallery need zero image-processing dependencies in CI, while animated WebP demo capture stays local and opt-in.

## Detailed implementation plan

Work is partitioned into six incremental phases matching the six Beads units.
Each phase leaves the repository buildable and passing its verification checkpoint.

### Phase 1: Schema preview targets and host manifests

#### 1. `packages/schema/src/index.ts` (Modify)

*   **Type / Scope:** Schema types and runtime validator (`@ubdf/schema`).
*   **Rationale and proposed changes:**
    Add optional `preview` metadata to `HostMeta`:
    ```ts
    export interface PreviewTargetMeta {
      url: string;
      label: string;
      ci?: boolean;
      wait_for?: string;
    }

    export interface PreviewMeta {
      ci?: boolean;
      targets: PreviewTargetMeta[];
    }
    ```
    Validate `[preview]` with these rules:
    *   `preview.ci` (if present) must be a boolean (defaults to `true` at runtime).
    *   `preview.targets` must be a non-empty array of tables.
    *   Each `target.url` must parse with `new URL()`, use `protocol === "https:"`, and have a `hostname` matching at least one entry in `allowed_domains`.
        Matching rule per `allowed_domains` entry `pattern`:
        *   If `pattern` ends with `.*` (wildcard TLD, such as `ebay.*`), match `hostname === prefix + "." + tld` or `hostname.endsWith("." + prefix + "." + tld)` where `tld` is a single label or public suffix.
        *   Otherwise, match `hostname === pattern` or `hostname.endsWith("." + pattern)`.
    *   Each `target.label` must match `slug` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) and be unique within the host.
    *   Each `target.ci` (if present) must be a boolean.
    *   Each `target.wait_for` (if present) must be a non-empty string.

#### 2. `packages/schema/src/index.test.ts` (Modify)

*   **Type / Scope:** Unit tests.
*   **Rationale and proposed changes:** Add tests covering: valid `[preview]` with multiple targets, omitted `[preview]`, empty `targets = []` rejection, non-`https:` URL rejection, URL outside `allowed_domains` rejection, subdomain and wildcard TLD (`ebay.*`) matches, duplicate `label` rejection, and non-boolean `ci` rejection.

#### 3. `filters/news.ycombinator.com/filter.toml` and `filters/ebay.com/filter.toml` (Modify)

*   **Type / Scope:** Host filter manifests.
*   **Rationale and proposed changes:**
    Add `[preview]` blocks:
    *   `filters/news.ycombinator.com/filter.toml`:
        ```toml
        [preview]
        ci = true

        [[preview.targets]]
        url = "https://news.ycombinator.com/"
        label = "hn-frontpage"
        ci = true
        wait_for = ".athing"

        [[preview.targets]]
        url = "https://hn.algolia.com/"
        label = "hn-algolia"
        ci = true
        wait_for = "input[type='search']"
        ```
    *   `filters/ebay.com/filter.toml`:
        ```toml
        [preview]
        ci = false

        [[preview.targets]]
        url = "https://www.ebay.com/sch/i.html?_nkw=keyboard"
        label = "ebay-search"
        ci = false
        ```

*   **Phase 1 checkpoint:** Run `mise exec -- bun run typecheck`, `mise exec -- bun run lint`, `mise exec -- bun run build`, and `mise exec -- bun test`.

---

### Phase 2: Pinned browser toolchain, isolated session, and loopback canary

#### 4. `.gitignore` (Modify)

*   **Type / Scope:** Repository ignore rules.
*   **Rationale and proposed changes:** Add `.artifacts/` so captured PNGs, `report.json`, and `index.html` under `.artifacts/visual/` are ignored by Git and not flagged as untracked files.

#### 5. `packages/preview/package.json` (Create) and `bun.lock` (Modify)

*   **Type / Scope:** Workspace package manifest (`@ubdf/preview`) and lockfile.
*   **Rationale and proposed changes:** Create `packages/preview/package.json` with `"name": "@ubdf/preview"`, `"private": true`, `"type": "module"`, and `"dependencies": { "@ubdf/schema": "workspace:*" }`. Run `bun install` to update `bun.lock` so `bun install --frozen-lockfile` passes in CI.

#### 6. `packages/preview/browser-manifest.json` (Create)

*   **Type / Scope:** Pinned toolchain manifest.
*   **Rationale and proposed changes:**
    Define the pinned artifact URLs and SHA-256 checksums:
    ```json
    {
      "firefox": {
        "version": "153.7.0esr",
        "url": "https://ftp.mozilla.org/pub/firefox/releases/153.7.0esr/linux-x86_64/en-US/firefox-153.7.0esr.tar.xz",
        "sha256": "7d2eb92ca3a7b2a83de092eb9b94c853980214de2fbfdccb2ac39d61c593c5a5"
      },
      "geckodriver": {
        "version": "0.37.1",
        "url": "https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz",
        "sha256": "e815130ea95983e162ae91843b48d3a3ce911735635fce83a647afde21e09f7e"
      },
      "ublockOrigin": {
        "version": "1.77.0",
        "url": "https://github.com/gorhill/uBlock/releases/download/1.77.0/uBlock0_1.77.0.firefox.signed.xpi",
        "sha256": "894ea48dedd26a637ab98ba627ae70b7ed94798eabfd4b089f5e5e73524a24eb"
      }
    }
    ```

#### 7. `packages/preview/src/toolchain.ts` (Create)

*   **Type / Scope:** TypeScript module (binary and XPI cache).
*   **Rationale and proposed changes:**
    *   Resolve cache root from `UBOUF_CACHE_DIR` or `~/.cache/ublock-ux-filters/browser/`.
    *   Download missing archives into `<cacheRoot>/downloads/`, verify SHA-256 with `Bun.CryptoHasher("sha256")` before extraction, extract `firefox` and `geckodriver` into versioned directories, and set extracted files read-only (`0o555` / `0o444`).
    *   Export `ensureToolchain(): Promise<{ firefoxDir: string; geckodriverBin: string; uboXpiPath: string }>`.

#### 8. `packages/preview/src/session.ts` (Create)

*   **Type / Scope:** TypeScript module (isolated Firefox and uBO launcher).
*   **Rationale and proposed changes:**
    *   Clone `firefoxDir` into `<tmpDir>/firefox-bin/` using recursive hardlinks (`fs.link`) with `fs.cp` fallback when `EXDEV` occurs across filesystems.
    *   Create `<tmpDir>/profile/user.js` setting `user_pref("ui.systemUsesDarkTheme", 0);`, `user_pref("intl.accept_languages", "en-US");`, and `user_pref("layout.css.devPixelsPerPx", "1.0");`.
    *   When `mode !== "raw"`, write `<tmpDir>/firefox-bin/distribution/policies.json`:
        ```json
        {
          "policies": {
            "Extensions": { "Install": ["<uboXpiPath>"] },
            "3rdparty": {
              "Extensions": {
                "uBlock0@raymondhill.net": {
                  "adminSettings": {
                    "userSettings": { "autoUpdate": false },
                    "selectedFilterLists": [],
                    "userFilters": "<canaryRule + compiledFilterText>"
                  }
                }
              }
            }
          }
        }
        ```
        For `raw` passes, omit `distribution/policies.json` so neither uBO nor the canary rule is installed.
    *   Build a filtered child environment using an explicit allowlist: `PATH`, `HOME`, `TMPDIR`, `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, plus `TZ: "UTC"` and `LANG: "en-US.UTF-8"`.
    *   Launch `<tmpDir>/firefox-bin/firefox` with `--no-remote -profile <tmpDir>/profile`.
    *   Register `SIGINT` and `SIGTERM` cleanup handlers to kill child processes and remove `<tmpDir>`, keeping `<tmpDir>` only when `--keep-profile` is set.

#### 9. `packages/preview/src/canary.ts` (Create)

*   **Type / Scope:** TypeScript module (loopback canary server and gate).
*   **Rationale and proposed changes:**
    *   Export `CANARY_RULE = "127.0.0.1##.ubouf-canary:style(background-color: rgb(255, 0, 128) !important)"`.
    *   Start `Bun.serve` on `127.0.0.1`, port `0`, serving `GET /canary` with `<div class="ubouf-canary" style="width:16px;height:16px;background-color:rgb(0,0,0)"></div>`.
    *   Poll `getComputedStyle(document.querySelector(".ubouf-canary")).backgroundColor` every `500 ms` up to `10000 ms`.
    *   If the value does not equal `"rgb(255, 0, 128)"`, throw a typed `UBO_LOAD_ERROR`.

#### 10. `packages/preview/src/webdriver.ts` (Create)

*   **Type / Scope:** TypeScript module (minimal W3C WebDriver client for `geckodriver`).
*   **Rationale and proposed changes:**
    *   Spawn `geckodriver` on an ephemeral port with the filtered child environment and isolated `firefox-bin`/`profile`.
    *   Set viewport via W3C `Set Window Rect` to `{ width: 1440, height: 900 }` (adjusting outer size by `window.outerWidth - window.innerWidth` and `window.outerHeight - window.innerHeight` if needed).
    *   Configure constants: `NAVIGATION_TIMEOUT_MS = 30000`, `WAIT_FOR_TIMEOUT_MS = 10000`, `MAX_RETRIES = 2`, `RETRY_BACKOFF_MS = [1000, 3000]`.
    *   Extract `httpStatus` via `Execute Script` reading `performance.getEntriesByType("navigation")[0]?.responseStatus ?? null`.
    *   Classify failures into `CaptureError`:
        ```ts
        export type ErrorKind =
          | "UBO_LOAD_ERROR"
          | "BOT_CHALLENGE"
          | "HTTP_ERROR"
          | "NAVIGATION_TIMEOUT"
          | "SELECTOR_TIMEOUT";

        export interface CaptureError {
          kind: ErrorKind;
          message: string;
          finalUrl: string;
          httpStatus: number | null;
          retryCount: number;
          phaseTimingsMs: { canaryMs?: number; navigateMs: number; waitMs?: number };
          failureScreenshotPath?: string;
        }
        ```
        Classification rules: `httpStatus === 403 || httpStatus === 429 || httpStatus === 503` or page title/body matching `/captcha|verify you are human|access denied|attention required/i` -> `BOT_CHALLENGE`; other `httpStatus >= 400` -> `HTTP_ERROR`; navigation timeout -> `NAVIGATION_TIMEOUT`; `wait_for` timeout -> `SELECTOR_TIMEOUT`.
    *   Close the WebDriver session and stop `geckodriver` in a `finally` block.

#### 11. Unit tests and canary smoke test (Create)

*   **Type / Scope:** Offline unit tests and real-browser smoke test.
*   **Rationale and proposed changes:**
    Create exact test files (run by `bun test` in `checks`):
    *   `packages/preview/src/toolchain.test.ts`: valid SHA-256 cache hit, SHA-256 mismatch rejection, `UBOUF_CACHE_DIR` override.
    *   `packages/preview/src/session.test.ts`: `policies.json` generation for `filtered` vs omitted for `raw`, `user.js` preferences, env allowlist stripping `GITHUB_TOKEN`/`GH_TOKEN`/`AWS_SECRET_ACCESS_KEY`, hardlink clone and `EXDEV` copy fallback, `--keep-profile` cleanup behavior.
    *   `packages/preview/src/webdriver.test.ts`: `BOT_CHALLENGE` (403/429/503 and CAPTCHA text), `HTTP_ERROR` (404/500), `NAVIGATION_TIMEOUT`, and `SELECTOR_TIMEOUT` classification.
    Create `packages/preview/src/canary.browser.ts` (excluded from `*.test.ts` so `checks` stays offline and does not launch a browser): launches pinned Firefox + `geckodriver` + uBO XPI via `session.ts` and `webdriver.ts`, runs `canary.ts`, and asserts `rgb(255, 0, 128)` applies.

*   **Phase 2 checkpoint:** Run `mise exec -- bun run typecheck`, `mise exec -- bun test`, and `mise exec -- bun packages/preview/src/canary.browser.ts`.

---

### Phase 3: Local interactive preview CLI

#### 12. `packages/preview/src/cli.ts` (Create) and `package.json` (Modify)

*   **Type / Scope:** CLI entrypoint (`preview` subcommand) and root script.
*   **Rationale and proposed changes:**
    *   Add `"preview": "bun packages/preview/src/cli.ts preview"` to root `package.json`.
    *   `preview` flags: `--host <host>` (required), `--variant <variant>` (optional; defaults to `filter.toml` `default_variant` or sole variant), `--keep-profile` (optional).
    *   Run `bun packages/builder/src/index.ts build` before launching so `dist/raw/<host>/<variant>.txt` is current.
    *   Launch visible Firefox via `session.ts` with all `[preview.targets]` URLs as startup arguments, with no WebDriver timeouts, waiting until Firefox exits or `SIGINT` arrives.

*   **Phase 3 checkpoint:** Run `mise exec -- bun run typecheck` and manually verify `mise exec -- bun run preview --host news.ycombinator.com`.

---

### Phase 4: Headless 3-way capture, diff selection, and HTML gallery

#### 13. `packages/preview/src/diff-select.ts` (Create) and `packages/preview/src/diff-select.test.ts` (Create)

*   **Type / Scope:** TypeScript module and unit tests.
*   **Rationale and proposed changes:**
    *   Inspect `git diff --name-only <base-ref>...HEAD -- filters/` and apply deterministic mapping rules:
        *   Changed `filters/<host>/<variant-file>.ubo` -> select `<host>::<variant>` matching `variant.file`.
        *   Changed `filters/<host>/filter.toml` -> select all variants of `<host>`.
        *   Other files (such as `README.md` or `assets/`) -> select nothing.
    *   Compile `<base-ref>` with `git worktree add --detach <tmpWorktree> <base-ref>`, run `bun packages/builder/src/index.ts build --out <tmpDist>` inside `<tmpWorktree>`, and clean up with `git worktree remove --force <tmpWorktree>`.
    *   Mark a variant absent from `<tmpDist>/manifest.json` as 2-way (`raw` + `pr`) instead of 3-way (`raw` + `base` + `pr`).
    *   Add unit tests in `diff-select.test.ts` covering `.ubo` changes, `filter.toml` changes, `README.md` ignore, and 2-way fallback for new variants.

#### 14. `packages/preview/src/report.ts` (Create) and `packages/preview/src/report.test.ts` (Create)

*   **Type / Scope:** TypeScript module and unit tests.
*   **Rationale and proposed changes:**
    *   Write `.artifacts/visual/report.json` matching:
        ```ts
        export interface TargetResult {
          host: string;
          variant: string;
          label: string;
          url: string;
          status: "captured" | "skipped_by_config" | "error";
          panels: { raw?: string; base?: string; pr?: string };
          error?: CaptureError;
        }

        export interface VisualReport {
          generatedAt: string;
          baseRef?: string;
          results: TargetResult[];
        }
        ```
    *   Write self-contained `.artifacts/visual/index.html` rendering side-by-side panels (`raw`, `base`, `pr` or `raw`, `pr` labeled `New variant`) and any `CaptureError` details.
    *   Format a Markdown table for `$GITHUB_STEP_SUMMARY` with columns: `Host`, `Variant`, `Target`, `Status`, `Panels`, `Details`.
    *   Add unit tests in `report.test.ts` covering `report.json` serialization, 2-way vs 3-way HTML rendering, `SKIPPED_BY_CONFIG`, and `$GITHUB_STEP_SUMMARY` Markdown formatting.

#### 15. `packages/preview/src/cli.ts` and `package.json` (Modify)

*   **Type / Scope:** `capture` subcommand and root script.
*   **Rationale and proposed changes:**
    *   Add `"capture": "bun packages/preview/src/cli.ts capture"` to root `package.json`.
    *   `capture` flags: `--host <host>` (optional), `--variant <variant>` (optional), `--base-ref <sha>` (optional), `--ci` (optional), `--keep-profile` (optional).
    *   If neither `--host` nor `--base-ref` is passed, capture all hosts with `[preview]` configured.
    *   Always run `bun packages/builder/src/index.ts build` before capturing.
    *   When `--ci` is set, skip targets where `preview.ci === false` or `target.ci === false` (recording `skipped_by_config`), and exit non-zero if any `UBO_LOAD_ERROR` or `error` occurs.

*   **Phase 4 checkpoint:** Run `mise exec -- bun run typecheck`, `mise exec -- bun test`, and `mise exec -- bun run capture --host news.ycombinator.com`; confirm `.artifacts/visual/report.json`, `index.html`, and PNGs are written.

---

### Phase 5: On-demand README demo capture and documentation

#### 16. `packages/preview/src/demo.ts`, `packages/preview/src/cli.ts`, and `package.json` (Create / Modify)

*   **Type / Scope:** Local demo recorder, `demo` subcommand, and root script.
*   **Rationale and proposed changes:**
    *   Add `"demo": "bun packages/preview/src/cli.ts demo"` to root `package.json`.
    *   `demo` flags: `--host <host>` (required), `--variant <variant>` (optional), `--label <target-label>` (optional; defaults to first target), `--format png|webp` (default `png`), `--scroll-y <px>` (default `0`), `--hover <selector>` (optional), `--max-bytes <n>` (default `2097152` / 2 MiB).
    *   Capture still PNG or sequential WebDriver frames encoded to animated WebP via local `ffmpeg` (failing with an actionable install message if `ffmpeg` is missing when `--format webp` is requested).
    *   Save output to `filters/<host>/assets/<variant>-<label>.<ext>` and fail if output exceeds `--max-bytes`.

#### 17. `README.md` (Modify)

*   **Type / Scope:** Repository documentation.
*   **Rationale and proposed changes:** Add `packages/preview` to the workspace package list and document `preview`, `capture`, `demo`, `[preview]` in `filter.toml`, and `.artifacts/visual/`.

*   **Phase 5 checkpoint:** Run `mise exec -- bun run typecheck`, `mise exec -- bun test`, and `mise exec -- bun run demo --host news.ycombinator.com --format png`.

---

### Phase 6: GitHub Actions `visual-capture` workflow

#### 18. `.github/workflows/ci.yml` (Modify)

*   **Type / Scope:** GitHub Actions workflow.
*   **Rationale and proposed changes:**
    Add a `visual-capture` job after `checks`:
    *   `needs: checks`
    *   `if: github.event_name == 'pull_request'`
    *   `runs-on: ubuntu-latest`
    *   `permissions: contents: read`
    *   Steps:
        1.  `actions/checkout@v4.4.0` with `fetch-depth: 0` and `persist-credentials: false`.
        2.  `jdx/mise-action@v3.6.3`.
        3.  `bun install --frozen-lockfile`.
        4.  `actions/cache@v4` on `~/.cache/ublock-ux-filters/browser` with key `browser-${{ runner.os }}-${{ hashFiles('packages/preview/browser-manifest.json') }}`.
        5.  Run `bun run capture --ci --base-ref ${{ github.event.pull_request.base.sha }}`.
        6.  `actions/upload-artifact@v4` (`if: always()`, `retention-days: 7`, uploading `.artifacts/visual/`).
        7.  Append the Markdown summary generated by `report.ts` to `$GITHUB_STEP_SUMMARY` (`if: always()`).

*   **Phase 6 checkpoint:** Validate `.github/workflows/ci.yml` syntax and run `mise exec -- bun run typecheck`, `mise exec -- bun run lint`, `mise exec -- bun run build`, and `mise exec -- bun test`.

---

### Verification plan

*   **Compilation and typecheck:** Run `mise exec -- bun run typecheck`; confirm it passes with strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
*   **Lint and build:** Run `mise exec -- bun run lint` and `mise exec -- bun run build`; confirm `dist/` contains no `.artifacts/visual/` files.
*   **Unit tests:** Run `mise exec -- bun test`; confirm all `@ubdf/schema`, `@ubdf/builder`, and `@ubdf/preview` unit tests pass offline.
*   **Browser canary smoke check:** Run `mise exec -- bun packages/preview/src/canary.browser.ts`; confirm pinned Firefox, `geckodriver`, and uBO XPI launch in an isolated profile and pass the loopback `/canary` style check.
*   **End-to-end local commands:** Run `bun run preview --host news.ycombinator.com`, `bun run capture --host news.ycombinator.com`, and `bun run demo --host news.ycombinator.com`; confirm visible preview opens, `.artifacts/visual/` report/gallery/PNGs are created, and demo output stays within `--max-bytes`.
*   **CI workflow:** On a PR touching a filter variant, confirm `checks` triggers `visual-capture`, uploads `.artifacts/visual/`, and writes the `$GITHUB_STEP_SUMMARY` table.

--------------------------------------------------------------------------------

*Drafted with EGM*
