import { describe, expect, test } from "bun:test";
import { matchesAllowedDomain, parseFilterSetMeta, parseHostMeta, splitFilterToken } from "./index.ts";

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

  test("Preserves valid preview metadata with multiple targets and wildcard TLDs", () => {
    const result = parseHostMeta({
      ...host,
      allowed_domains: ["ebay.*", "example.org"],
      preview: {
        ci: false,
        targets: [
          {
            url: "https://www.ebay.com/sch/i.html?_nkw=keyboard",
            label: "ebay-search",
            ci: false,
            wait_for: ".srp-results",
          },
          {
            url: "https://www.ebay.co.uk/",
            label: "ebay-uk",
          },
          {
            url: "https://sub.example.org/items",
            label: "example-sub",
            ci: true,
          },
        ],
      },
    }, "ebay.com");

    expect(result.preview).toEqual({
      ci: false,
      targets: [
        {
          url: "https://www.ebay.com/sch/i.html?_nkw=keyboard",
          label: "ebay-search",
          ci: false,
          wait_for: ".srp-results",
        },
        {
          url: "https://www.ebay.co.uk/",
          label: "ebay-uk",
        },
        {
          url: "https://sub.example.org/items",
          label: "example-sub",
          ci: true,
        },
      ],
    });
  });

  test("Omits preview when not configured", () => {
    const result = parseHostMeta(host, "ebay.com");
    expect(result).not.toHaveProperty("preview");
  });

  test.each([
    ["Empty preview targets", { targets: [] }, /preview\.targets/],
    ["Non-https preview URL", { targets: [{ url: "http://www.ebay.com/", label: "home" }] }, /url/],
    ["Malformed preview URL", { targets: [{ url: "not-a-url", label: "home" }] }, /url/],
    ["Preview URL outside allowed_domains", { targets: [{ url: "https://notebay.com/", label: "home" }] }, /url/],
    ["Preview URL exceeding wildcard TLD suffix", { targets: [{ url: "https://ebay.com.evil.com/", label: "home" }] }, /url/],
    [
      "Duplicate preview target labels",
      {
        targets: [
          { url: "https://www.ebay.com/", label: "home" },
          { url: "https://www.ebay.de/", label: "home" },
        ],
      },
      /label/,
    ],
    ["Invalid preview target label slug", { targets: [{ url: "https://www.ebay.com/", label: "Bad_Label" }] }, /label/],
    ["Non-boolean preview.ci", { ci: "yes", targets: [{ url: "https://www.ebay.com/", label: "home" }] }, /preview\.ci/],
    ["Non-boolean target.ci", { targets: [{ url: "https://www.ebay.com/", label: "home", ci: 1 }] }, /ci/],
    ["Empty wait_for selector", { targets: [{ url: "https://www.ebay.com/", label: "home", wait_for: "   " }] }, /wait_for/],
  ] as const)("Rejects preview: %s", (_, preview, field) => {
    expect(() => parseHostMeta({ ...host, preview }, "ebay.com")).toThrow(field);
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

describe("matchesAllowedDomain", () => {
  test.each([
    ["ebay.com", "ebay.com", true],
    ["www.ebay.com", "ebay.com", true],
    ["www.ebay.co.uk", "ebay.*", true],
    ["ebay.*", "ebay.*", true],
    ["www.ebay.*", "ebay.*", true],
    ["ebay.*", "ebay.com", false],
    ["ebay.*", "www.ebay.*", false],
    ["notebay.*", "ebay.*", false],
    ["ebay.*", ".*", false],
  ] as const)("matchesAllowedDomain(%s, %s) -> %s", (hostname, pattern, expected) => {
    expect(matchesAllowedDomain(hostname, pattern)).toBe(expected);
  });
});
