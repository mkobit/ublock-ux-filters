import {
  LinterRuleSeverity,
  LinterRuleType,
  createVisitorsForAnyCosmeticRule,
  defineRule,
  lint,
} from "@adguard/aglint/linter";
import type { LinterConfig } from "@adguard/aglint/linter";
import { matchesAllowedDomain } from "@ubdf/schema";
import type { FilterParserAdapter } from "./compiler.ts";

interface DomainNode {
  value: string;
  exception: boolean;
}

interface CosmeticRuleNode {
  domains?: {
    children?: DomainNode[];
  };
}

function createDomainScopeRule(allowedDomains: readonly string[]) {
  return defineRule({
    meta: {
      type: LinterRuleType.Problem,
      docs: {
        name: "domain-scope",
        description: "Requires cosmetic rules to target at least one positive domain matching allowed_domains",
        recommended: true,
      },
    },
    create: (context) => createVisitorsForAnyCosmeticRule((node: CosmeticRuleNode) => {
      const positiveDomains = (node.domains?.children ?? []).filter((domain) => !domain.exception);
      if (positiveDomains.length === 0) {
        context.report({
          message: "Cosmetic rule must specify at least one positive domain matching allowed_domains",
          node,
        });
        return;
      }
      for (const domain of positiveDomains) {
        if (!allowedDomains.some((pattern) => matchesAllowedDomain(domain.value, pattern))) {
          context.report({
            message: `Domain "${domain.value}" is outside allowed_domains (${allowedDomains.join(", ")})`,
            node: domain,
          });
        }
      }
    }),
  });
}

const baseRules: LinterConfig["rules"] = {
  "no-invalid-modifiers": "error",
  "no-unsupported-css-pseudo-class": "error",
};

export const aglintAdapter: FilterParserAdapter = {
  async lint(filePath, content, options) {
    const allowedDomains = options?.allowedDomains;
    const config: LinterConfig = {
      rules: allowedDomains === undefined
        ? baseRules
        : { ...baseRules, "domain-scope": "error" },
      platforms: ["ubo_any"],
      allowInlineConfig: false,
    };
    const result = await lint({
      fileProps: { filePath, content, cwd: process.cwd() },
      config,
      loadRule: async (name) => {
        if (name === "domain-scope" && allowedDomains !== undefined) {
          return createDomainScopeRule(allowedDomains);
        }
        return (await import(`@adguard/aglint/rules/${name}`)).default;
      },
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
