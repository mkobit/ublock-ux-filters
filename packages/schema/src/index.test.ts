import { describe, expect, test } from "bun:test";
import { parseFilterSetMeta, parseHostMeta, splitFilterToken } from "./index.ts";

const variant = {
  file: "dark-mode-github-dark.ubo",
  description: "Dark theme for eBay",
  tags: ["dark-mode"],
};
const host = {
  host: "ebay.com",
  display_name: "eBay",
  allowed_domains: ["ebay.*"],
  default_variant: "dark-mode-github-dark",
  variants: { "dark-mode-github-dark": variant },
};
const set = { name: "dark-mode", description: "Dark themes" };

describe("Host descriptors", () => {
  test("Preserves wildcard domains, a default, and variant metadata", () => {
    expect(parseHostMeta({
      ...host,
      variants: {
        "dark-mode-github-dark": {
          ...variant,
          includes: ["news.ycombinator.com::base"],
        },
      },
      aliases: {
        "old-dark": "dark-mode-github-dark",
        "ebay.com::old-theme": "ebay.com::dark-mode-github-dark",
      },
    }, "ebay.com")).toEqual({
      host: "ebay.com",
      display_name: "eBay",
      allowed_domains: ["ebay.*"],
      default_variant: "dark-mode-github-dark",
      variants: {
        "dark-mode-github-dark": {
          file: "dark-mode-github-dark.ubo",
          description: "Dark theme for eBay",
          tags: ["dark-mode"],
          includes: ["news.ycombinator.com::base"],
        },
      },
      aliases: {
        "old-dark": "dark-mode-github-dark",
        "ebay.com::old-theme": "ebay.com::dark-mode-github-dark",
      },
    });
  });

  test("Accepts a subdomain without a default or aliases", () => {
    const result = parseHostMeta({
      host: "news.ycombinator.com",
      display_name: "Hacker News",
      allowed_domains: ["news.ycombinator.com"],
      variants: { "dark-mode-github-dark": variant },
    }, "news.ycombinator.com");

    expect(result.host).toBe("news.ycombinator.com");
    expect(result).not.toHaveProperty("default_variant");
    expect(result).not.toHaveProperty("aliases");
  });

  test.each([
    ["The directory differs from the host", { ...host, host: "example.org" }, /host/i],
    ["The display name has the wrong type", { ...host, display_name: 123 }, /display_name/],
    ["Domains are not an array", { ...host, allowed_domains: "ebay.*" }, /allowed_domains/],
    ["There are no variants", { ...host, variants: {} }, /variants/],
    ["The default variant does not exist", { ...host, default_variant: "missing" }, /default_variant/],
    ["The default variant is inherited", { ...host, default_variant: "constructor" }, /default_variant/],
    ["An alias has a malformed target", { ...host, aliases: { old: "ebay.com::" } }, /aliases/],
  ] as const)("%s", (_, raw, field) => {
    expect(() => parseHostMeta(raw, "ebay.com")).toThrow(field);
  });

  test.each([
    ["../other.ubo", "Path outside the host directory"],
    ["styles/../other.ubo", "Path with a parent segment"],
    ["/other.ubo", "Absolute path"],
    ["C:\\other.ubo", "Windows absolute path"],
    ["theme.txt", "Incorrect file extension"],
  ] as const)("Rejects %s (%s)", (file) => {
    expect(() => parseHostMeta({
      ...host,
      variants: { "dark-mode-github-dark": { ...variant, file } },
    }, "ebay.com")).toThrow(/file/);
  });

  test("Rejects an include without a variant", () => {
    expect(() => parseHostMeta({
      ...host,
      variants: { "dark-mode-github-dark": { ...variant, includes: ["ebay.com"] } },
    }, "ebay.com")).toThrow(/includes/);
  });
});

describe("Set descriptors", () => {
  test("Accepts all-defaults without additional selectors", () => {
    const result = parseFilterSetMeta({
      name: "all-defaults",
      description: "Default variants",
      mode: "all-defaults",
    }, "all-defaults");

    expect(result).toEqual({
      name: "all-defaults",
      description: "Default variants",
      mode: "all-defaults",
    });
  });

  test("Preserves a tag and exclusions", () => {
    expect(parseFilterSetMeta({
      ...set,
      mode: "tag",
      tag: "dark-mode",
      exclude: ["ebay.com", "news.ycombinator.com::base"],
    }, "dark-mode")).toEqual({
      name: "dark-mode",
      description: "Dark themes",
      mode: "tag",
      tag: "dark-mode",
      exclude: ["ebay.com", "news.ycombinator.com::base"],
    });
  });

  test("Preserves host and variant selections in explicit mode", () => {
    expect(parseFilterSetMeta({
      ...set,
      mode: "explicit",
      include: ["ebay.com", "news.ycombinator.com::base"],
    }, "dark-mode")).toEqual({
      name: "dark-mode",
      description: "Dark themes",
      mode: "explicit",
      include: ["ebay.com", "news.ycombinator.com::base"],
    });
  });

  test.each([
    ["The filename differs from the set name", { ...set, name: "other", mode: "tag", tag: "dark-mode" }, /name/],
    ["The mode is unknown", { ...set, mode: "unknown" }, /mode/],
    ["Tag mode has no tag", { ...set, mode: "tag" }, /tag/],
    ["An inclusion has a malformed variant", { ...set, mode: "explicit", include: ["ebay.com::"] }, /include/],
    ["An exclusion has the wrong type", { ...set, mode: "all-defaults", exclude: "ebay.com" }, /exclude/],
  ] as const)("%s", (_, raw, field) => {
    expect(() => parseFilterSetMeta(raw, "dark-mode")).toThrow(field);
  });
});

describe("Filter tokens", () => {
  test.each([
    ["ebay.com", { host: "ebay.com" }],
    ["news.ycombinator.com::base", { host: "news.ycombinator.com", variant: "base" }],
    ["ebay.com::", null],
    ["::base", null],
    ["ebay.com::base::old", null],
    ["ebay.com/path", null],
  ] as const)("Parses %s", (token, expected) => {
    expect(splitFilterToken(token)).toEqual(expected);
  });
});
