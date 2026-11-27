---
name: filter-authoring
description: Workflow for adding or updating uBlock Origin filter hosts and variants in this repository. Use when creating a .ubo fragment, editing filter.toml, adding a host workspace package, updating set membership, or validating filter builds.
---

# Filter authoring

Follow [the authoring guide](../../../README.md#add-and-validate-a-filter-variant) in `README.md` for repository layout, schema rules, and set modes.
Use this checklist when adding or updating a filter host or variant.

## 1. Source attribution

- Record `# Source URL:` and `# Source revision:` comments at the top of `filters/<host>/filter.toml` when adapting an upstream filter.
- Include `! Title:`, `! Homepage:`, and `! Forked from:` header comments at the top of each `.ubo` fragment.
- Target only intended domains in filter rules, and omit inline `@adguard/aglint` configuration comments.

## 2. Descriptors

- Match `host` in `filters/<host>/filter.toml` to the `filters/<host>` directory name.
- Set `display_name`, `allowed_domains`, and `[variants.<slug>]` with a relative `.ubo` `file`, `description`, `tags`, and optional `includes` (`"<host>::<variant>"`).
- Keep any `[preview]` target URLs on `https:` within `allowed_domains`.

## 3. Workspace metadata

- When adding a new host directory, create `filters/<host>/package.json` with `lint`, `build`, and `test` scripts matching existing host packages.
- Run `mise exec -- bun install` after adding a new workspace package so `bun.lock` includes it.

## 4. Set selection

- Set `default_variant` in `filter.toml` to include the variant in `sets/all-defaults.toml`.
- Add `"dark-mode"` to `tags` to include the variant in `sets/dark-mode.toml`, or update explicit selectors in `sets/*.toml`.

## 5. Validation

Iterate on a single host:

```sh
mise exec -- bun packages/builder/src/index.ts lint --host <host>
mise exec -- bun packages/builder/src/index.ts build --host <host>
```

Run all repository checks before finishing:

```sh
mise exec -- bun run lint
mise exec -- bun run build
mise exec -- bun test
mise exec -- bun run typecheck
```

## 6. Evidence

- Report the exact files changed and the commands run with their observed results.
- Verify that expected variants appear in `dist/manifest.json` and `dist/sets/*.txt` after building; do not commit `dist/`.
