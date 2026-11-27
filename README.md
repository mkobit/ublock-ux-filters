# uBlock UX filters

[![CI](https://github.com/mkobit/ublock-ux-filters/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mkobit/ublock-ux-filters/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/mkobit/ublock-ux-filters)](https://github.com/mkobit/ublock-ux-filters/releases/latest)

This project builds plain-text uBlock Origin lists that change how websites look and behave.
The first filters apply a GitHub Dark theme to eBay, Hacker News, and Hacker News search on Algolia.

- [`all-defaults`](sets/all-defaults.toml) selects the default variant for each site that declares one.
- [`dark-mode`](sets/dark-mode.toml) selects every variant tagged `dark-mode`.

Both lists currently contain the same two site variants.

## Build the lists

From the repository root, use Mise to run the pinned version of Bun.

```sh
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build
```

The compiler reads each site's `filter.toml` and `.ubo` files under [`filters/`](filters/).
It validates the descriptors and filter rules, then writes the subscription lists to `dist/sets/`, individual variants to `dist/raw/`, and metadata to `dist/manifest.json`.
For repeat builds, use `mise exec -- bun run build --incremental` to reuse unchanged output.

## Add and validate a filter variant

Each site lives in its own directory under [`filters/`](filters/), named by its primary host (for example, [`filters/news.ycombinator.com/`](filters/news.ycombinator.com/)).
The walkthrough below uses the Hacker News filter as a reference.

### 1. Create or update the host directory

- **Adding a variant to an existing host**: add a new `.ubo` file and `[variants.<slug>]` table in that host's `filter.toml`.
- **Adding a new host**: create `filters/<host>/filter.toml`, at least one `.ubo` fragment, and `filters/<host>/package.json`.

Root [`package.json`](package.json) declares `"filters/*"` as a Bun workspace.
If you add a new `filters/<host>/package.json`, run `mise exec -- bun install` to update `bun.lock` and commit the updated lockfile.
See [`filters/news.ycombinator.com/package.json`](filters/news.ycombinator.com/package.json) for the expected workspace scripts (`lint`, `build`, `test`).

### 2. Write the `.ubo` fragment and source credit

Add uBlock Origin rules in a `.ubo` file inside the host directory, such as [`filters/news.ycombinator.com/dark-mode-github-dark.ubo`](filters/news.ycombinator.com/dark-mode-github-dark.ubo).
Include header comments at the top of the fragment for title, homepage, and upstream attribution (`! Title:`, `! Homepage:`, `! Forked from:`).
Write rules targeting only the domains you intend to support (for example, `news.ycombinator.com##...` and `hn.algolia.com##...`).

The linter validates every `.ubo` file with `@adguard/aglint` targeting `ubo_any` (`no-invalid-modifiers` and `no-unsupported-css-pseudo-class` are errors, and inline linter config comments are disallowed).

### 3. Configure `filter.toml`

Record upstream source credit at the top of `filter.toml` using `# Source URL:` and `# Source revision:` comments, then declare the host and variant metadata.
See [`filters/news.ycombinator.com/filter.toml`](filters/news.ycombinator.com/filter.toml) and [`filters/ebay.com/filter.toml`](filters/ebay.com/filter.toml) for examples.

Key fields validated by [`packages/schema/src/index.ts`](packages/schema/src/index.ts):

- `host`: hostname that must match the `filters/<host>` directory name.
- `display_name`: human-readable site name.
- `allowed_domains`: nonempty list of domain patterns for the site (such as `["news.ycombinator.com", "hn.algolia.com"]`; wildcard TLD suffixes such as `example.*` are also supported).
- `default_variant` (optional): variant slug in this descriptor selected by `all-defaults`.
- `[variants.<slug>]`: lowercase hyphenated variant identifier with `file` (relative `.ubo` path inside the host directory), `description`, `tags`, and optional `includes` (`"<host>::<variant>"` tokens).
- `[aliases]` (optional): maps retired `<variant>` or `<host>::<variant>` identifiers to current targets.
- `[preview]` (optional): screenshot preview config with `ci` and `[[preview.targets]]` (`url`, `label`, optional `ci`, optional `wait_for`). Every preview `url` must use `https:` and match `allowed_domains`.

### 4. Check set membership (`sets/*.toml`)

Set descriptors under [`sets/`](sets/) control which variants appear in each generated subscription list:

- [`sets/all-defaults.toml`](sets/all-defaults.toml) uses `mode = "all-defaults"` to include every host's `default_variant`.
- [`sets/dark-mode.toml`](sets/dark-mode.toml) uses `mode = "tag"` with `tag = "dark-mode"` to include every variant that lists `"dark-mode"` in `tags`.

If your variant sets `default_variant` or includes `"dark-mode"` in `tags`, it joins those sets automatically.
Sets can also use `mode = "explicit"` or `include` / `exclude` arrays with `<host>` or `<host>::<variant>` tokens.

### 5. Lint, build, and test

From a fresh checkout at the repository root (after `mise exec -- bun install --frozen-lockfile`, or `mise exec -- bun install` when adding a new workspace package):

```sh
mise exec -- bun run lint
mise exec -- bun run build
mise exec -- bun test
mise exec -- bun run typecheck
```

To lint or build a single host during iteration:

```sh
mise exec -- bun packages/builder/src/index.ts lint --host news.ycombinator.com
mise exec -- bun packages/builder/src/index.ts build --host news.ycombinator.com
```

## Subscription publishing

The lists build locally today.
The publishing plan is to attach the generated text files to GitHub Releases.
A latest-release asset URL will let uBlock Origin receive updates from the same subscription URL.
A tagged-release asset URL will let a user select a specific version.
Use an unprefixed UTC CalVer tag such as `2026.11.5` for each published release.
Attach the generated lists to the draft before publishing it.
Public subscription URLs are pending.

## Pull requests

Open a pull request for changes to `main`.
Wait for the required CI checks to pass, then squash merge.

## Project tracking

Run `mise exec -- bd prime` for the Beads workflow and `mise exec -- bd ready` for the current queue.
Issue `ubouf-org` tracks the screenshot regression tests.
See [the preview toolchain refresh guide](docs/preview-toolchain-refresh.md) for updating or rolling back the pinned Firefox, `geckodriver`, and uBlock Origin versions.
