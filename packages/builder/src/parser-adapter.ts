import { LinterRuleSeverity, lint } from "@adguard/aglint/linter";
import type { LinterConfig } from "@adguard/aglint/linter";
import type { FilterParserAdapter } from "./compiler.ts";

const config: LinterConfig = {
  rules: {
    "no-invalid-modifiers": "error",
    "no-unsupported-css-pseudo-class": "error",
  },
  platforms: ["ubo_any"],
  allowInlineConfig: false,
};

export const aglintAdapter: FilterParserAdapter = {
  async lint(filePath, content) {
    const result = await lint({
      fileProps: { filePath, content, cwd: process.cwd() },
      config,
      loadRule: async (name) => (await import(`@adguard/aglint/rules/${name}`)).default,
    });
    const rules = content.split("\n").map((line) => line.trim()).filter((line) =>
      line !== "" && !line.startsWith("!") && !/^\[Adblock.*\]$/i.test(line));
    return {
      filePath,
      ruleCount: rules.length,
      errors: result.problems.filter((problem) => problem.fatal || problem.severity === LinterRuleSeverity.Error)
        .map((problem) => ({
          line: problem.position.start.line,
          rule: problem.ruleId ?? "syntax",
          message: problem.message,
        })),
    };
  },
};
