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
