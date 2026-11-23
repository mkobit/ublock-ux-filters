# uBlock UX filters

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

## Subscription publishing

The lists build locally today.
The publishing plan is to attach the generated text files to GitHub Releases.
A latest-release asset URL will let uBlock Origin receive updates from the same subscription URL.
A tagged-release asset URL will let a user select a specific version.
Public subscription URLs are pending.

## Project tracking

Run `mise exec -- bd prime` for the Beads workflow and `mise exec -- bd ready` for the current queue.
Issue `ubouf-org` tracks the screenshot regression tests.
