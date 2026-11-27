# Refresh the Firefox preview toolchain

`packages/preview/browser-manifest.json` pins the Firefox ESR, `geckodriver`, and uBlock Origin XPI versions, download URLs, and SHA-256 checksums used by [`packages/preview/src/toolchain.ts`](../packages/preview/src/toolchain.ts).

## Supported platforms

The preview toolchain supports Linux `x86_64` only.
[`packages/preview/src/toolchain.ts`](../packages/preview/src/toolchain.ts) downloads `.tar.xz` Firefox archives and `linux64` `.tar.gz` `geckodriver` archives, and extracts them with `tar`.
macOS and Windows are not supported.

## Official artifact and checksum sources

Use only official release artifacts and verify every SHA-256 digest before updating [`packages/preview/browser-manifest.json`](../packages/preview/browser-manifest.json).

- **Firefox ESR (`firefox`)**: Download `linux-x86_64/en-US/firefox-<version>.tar.xz` and `SHA256SUMS` (with `SHA256SUMS.asc`) from `https://ftp.mozilla.org/pub/firefox/releases/<version>/`.
- **`geckodriver` (`geckodriver`)**: Download `geckodriver-v<version>-linux64.tar.gz` from `https://github.com/mozilla/geckodriver/releases/tag/v<version>` and compute its SHA-256 digest with `sha256sum`.
- **uBlock Origin (`ublockOrigin`)**: Download `uBlock0_<version>.firefox.signed.xpi` from `https://github.com/gorhill/uBlock/releases/tag/<version>` and compute its SHA-256 digest with `sha256sum`.

## Update pins and cache keys

1. Edit [`packages/preview/browser-manifest.json`](../packages/preview/browser-manifest.json) with the new `version`, `url`, and lowercase `sha256` hex digest for each updated artifact.
2. Bump `version` whenever `url` or `sha256` changes.

`ensureToolchain()` in [`packages/preview/src/toolchain.ts`](../packages/preview/src/toolchain.ts) stores downloads and extracted binaries under `$UBOUF_CACHE_DIR` (or `~/.cache/ublock-ux-filters/browser/` by default) using versioned paths:

- `downloads/firefox-<version>.tar.xz` and `firefox-<version>/`
- `downloads/geckodriver-v<version>-linux64.tar.gz` and `geckodriver-<version>/`
- `downloads/uBlock0_<version>.firefox.signed.xpi` and `ublock-origin-<version>/`

Bumping `version` creates a new cache directory without overwriting older pins.
If CI caches the browser directory with `actions/cache`, key the cache on the hash of `packages/preview/browser-manifest.json` so any manifest edit invalidates the cache.

## Run clean and warm cache canary checks

Run the loopback canary script against a fresh temporary cache directory, then run it a second time against the same directory to verify cache reuse.

```sh
tmp_cache="$(mktemp -d)"

# 1. Clean cache: downloads artifacts, verifies SHA-256, extracts read-only, and runs the canary.
UBOUF_CACHE_DIR="$tmp_cache" mise exec -- bun packages/preview/src/canary.browser.ts

# 2. Warm cache: verifies cached artifacts without downloading and runs the canary.
UBOUF_CACHE_DIR="$tmp_cache" mise exec -- bun packages/preview/src/canary.browser.ts

# 3. Clean up the temporary read-only cache.
chmod -R u+w "$tmp_cache" && rm -rf "$tmp_cache"
```

Both runs must print `Canary passed in ...`.
Also run the repository test and validation suite before committing:

```sh
mise exec -- bun test
mise exec -- bun run typecheck
mise exec -- bun run lint
mise exec -- bun run build
```

## Roll back a failed refresh

1. Restore the previous [`packages/preview/browser-manifest.json`](../packages/preview/browser-manifest.json) with `git checkout <good-ref> -- packages/preview/browser-manifest.json` or `git revert <bad-commit>`.
2. If the failed version was written to your local cache (`~/.cache/ublock-ux-filters/browser/` or `$UBOUF_CACHE_DIR`), make the extracted directory writable and delete the failed versioned files:

```sh
cache_dir="${UBOUF_CACHE_DIR:-$HOME/.cache/ublock-ux-filters/browser}"
chmod -R u+w "$cache_dir"/firefox-<bad-version> "$cache_dir"/geckodriver-<bad-version> "$cache_dir"/ublock-origin-<bad-version> 2>/dev/null || true
rm -rf \
  "$cache_dir"/firefox-<bad-version> \
  "$cache_dir"/geckodriver-<bad-version> \
  "$cache_dir"/ublock-origin-<bad-version> \
  "$cache_dir"/downloads/*<bad-version>*
```

3. Run `mise exec -- bun packages/preview/src/canary.browser.ts` to confirm the previous pins pass.
