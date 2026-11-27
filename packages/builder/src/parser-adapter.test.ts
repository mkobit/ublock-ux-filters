import { expect, test } from "bun:test";
import { aglintAdapter } from "./parser-adapter.ts";

test("Accepts a uBlock Origin cosmetic rule and counts active rules", async () => {
  const report = await aglintAdapter.lint("fixture.ubo", [
    "! Theme rules",
    "",
    "example.com##html:style(color: black !important;)",
  ].join("\n"));
  expect(report.ruleCount).toBe(1);
  expect(report.errors).toEqual([]);
});

test("Reports the location of malformed rules", async () => {
  const report = await aglintAdapter.lint("fixture.ubo", "! Theme rules\nexample.com##");
  expect(report.errors).toEqual([
    expect.objectContaining({ line: 2, rule: "syntax" }),
  ]);
});

test("Rejects malformed CSS within a cosmetic rule", async () => {
  const report = await aglintAdapter.lint("fixture.ubo", "example.com##div:style(}");
  expect(report.errors).toEqual([expect.objectContaining({ rule: "syntax" })]);
});

test("Rejects a network modifier unsupported by uBlock Origin", async () => {
  const report = await aglintAdapter.lint("fixture.ubo", "||example.com^$app=chrome");
  expect(report.errors).toEqual([expect.objectContaining({ rule: "no-invalid-modifiers" })]);
});

test.each([
  ["global element hiding", "##.ad", ["ebay.com"]],
  ["negated-only element hiding", "~reddit.com##.ad", ["ebay.com"]],
  ["off-domain element hiding", "github.com##.ad", ["ebay.com"]],
  ["mixed on-domain and off-domain", "ebay.com,github.com##.ad", ["ebay.com"]],
  ["wildcard TLD rule against concrete allowed_domains", "ebay.*##.ad", ["ebay.com"]],
  ["global CSS injection", "##div:style(color: black;)", ["ebay.com"]],
  ["off-domain scriptlet injection", "github.com##+js(set-constant, foo, bar)", ["ebay.com"]],
  ["off-domain HTML filtering", "github.com$$div", ["ebay.com"]],
  ["off-domain JS injection", "github.com#%#//scriptlet()", ["ebay.com"]],
  ["off-domain cosmetic exception", "github.com#@#.ad", ["ebay.com"]],
] as const)("Rejects %s under domain-scope", async (_, rule, allowedDomains) => {
  const report = await aglintAdapter.lint("fixture.ubo", `! comment\n${rule}`, { allowedDomains });
  expect(report.errors).toEqual([
    expect.objectContaining({ line: 2, rule: "domain-scope" }),
  ]);
});

test.each([
  ["exact domain", "ebay.com##.ad", ["ebay.com"]],
  ["subdomain", "www.ebay.com##.ad", ["ebay.com"]],
  ["wildcard TLD matching concrete domain", "www.ebay.co.uk##.ad", ["ebay.*"]],
  ["wildcard TLD matching wildcard TLD", "ebay.*##.ad", ["ebay.*"]],
  ["subdomain wildcard TLD matching wildcard TLD", "www.ebay.*##.ad", ["ebay.*"]],
  ["positive domain with negated exclusion", "ebay.com,~reddit.com##.ad", ["ebay.com"]],
  ["cosmetic exception on allowed domain", "ebay.com#@#.ad", ["ebay.com"]],
  ["CSS injection on allowed domain", "ebay.com##div:style(color: black;)", ["ebay.com"]],
  ["scriptlet injection on allowed domain", "ebay.com##+js(set-constant, foo, bar)", ["ebay.com"]],
  ["network rule on any domain", "||github.com^$third-party", ["ebay.com"]],
  ["comments and empty lines", "! comment\n\n! another comment", ["ebay.com"]],
] as const)("Accepts %s under domain-scope", async (_, rule, allowedDomains) => {
  const report = await aglintAdapter.lint("fixture.ubo", rule, { allowedDomains });
  expect(report.errors).toEqual([]);
});
