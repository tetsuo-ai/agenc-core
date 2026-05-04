import { describe, expect, test } from "vitest";
import {
  applyToolApprovalConfigToPermissionContext,
  decideToolApproval,
  permissionRulesFromToolApprovalConfig,
  toolApprovalRulesFromConfig,
} from "./tool-approval.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("toolApprovalRulesFromConfig", () => {
  test("maps config allow/ask/deny arrays to auto/prompt/deny rules", () => {
    const rules = toolApprovalRulesFromConfig({
      allow: ["Read(*)"],
      ask: ["Bash(npm publish *)"],
      deny: ["Bash(rm -rf *)"],
    });

    expect(rules.map((entry) => entry.behavior)).toEqual([
      "deny",
      "prompt",
      "auto",
    ]);
    expect(rules.map((entry) => entry.rule.ruleBehavior)).toEqual([
      "deny",
      "ask",
      "allow",
    ]);
    expect(rules.map((entry) => entry.rule.ruleValue)).toEqual([
      { toolName: "Bash", ruleContent: "rm -rf *" },
      { toolName: "Bash", ruleContent: "npm publish *" },
      { toolName: "Read" },
    ]);
  });

  test("skips empty rule strings and stamps the selected source", () => {
    const rules = permissionRulesFromToolApprovalConfig(
      { allow: ["", "Write"] },
      "cliArg",
    );
    expect(rules).toEqual([
      {
        source: "cliArg",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Write" },
      },
    ]);
  });
});

describe("applyToolApprovalConfigToPermissionContext", () => {
  test("installs rule buckets and additional directories", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["Read"],
        ask: ["Bash(npm publish *)"],
        deny: ["Write"],
        additionalDirectories: ["/tmp/work"],
      },
    );

    expect(ctx.alwaysAllowRules.session).toEqual(["Read"]);
    expect(ctx.alwaysAskRules.session).toEqual(["Bash(npm publish *)"]);
    expect(ctx.alwaysDenyRules.session).toEqual(["Write"]);
    expect(ctx.additionalWorkingDirectories.get("/tmp/work")).toEqual({
      path: "/tmp/work",
      source: "session",
    });
  });
});

describe("decideToolApproval", () => {
  test("returns none when no whole-tool or content rule matches", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { allow: ["Read"] },
    );

    expect(
      decideToolApproval(ctx, { toolName: "Bash", ruleContent: "git status" }),
    ).toEqual({ behavior: "none" });
  });

  test("denies a matching content pattern before a whole-tool auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["Bash"],
        deny: ["Bash(rm -rf *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "Bash",
      ruleContent: "rm -rf build",
    });

    expect(decision.behavior).toBe("deny");
    expect(decision.rule?.ruleValue.ruleContent).toBe("rm -rf *");
  });

  test("prompts for content-specific ask before a whole-tool auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["Bash"],
        ask: ["Bash(npm publish *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "Bash",
      ruleContent: "npm publish package",
    });

    expect(decision.behavior).toBe("prompt");
    expect(decision.rule?.ruleBehavior).toBe("ask");
  });

  test("matches prefix-colon content rules with shared rule semantics", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { allow: ["Bash(git:*)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "git status",
      }).behavior,
    ).toBe("auto");
    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "npm test",
      }).behavior,
    ).toBe("none");
  });

  test("keeps content-specific deny ahead of a broader content auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["Bash(git:*)"],
        deny: ["Bash(git push:*)"],
      },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "git push origin main",
      }).behavior,
    ).toBe("deny");
  });

  test("falls back to whole-tool auto when content rules do not match", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["Bash"],
        ask: ["Bash(npm publish *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "Bash",
      ruleContent: "git status",
    });

    expect(decision.behavior).toBe("auto");
    expect(decision.rule?.ruleValue).toEqual({ toolName: "Bash" });
  });

  test("treats a trailing space-wildcard pattern as optional arguments", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { ask: ["Bash(npm publish *)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "npm publish",
      }).behavior,
    ).toBe("prompt");
  });

  test("keeps escaped wildcard literals from becoming patterns", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { deny: ["Bash(echo \\\\*)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "echo *",
      }).behavior,
    ).toBe("deny");
    expect(
      decideToolApproval(ctx, {
        toolName: "Bash",
        ruleContent: "echo anything",
      }).behavior,
    ).toBe("none");
  });
});
