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
      allow: ["FileRead(*)"],
      ask: ["system.bash(npm publish *)"],
      deny: ["system.bash(rm -rf *)"],
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
      { toolName: "system.bash", ruleContent: "rm -rf *" },
      { toolName: "system.bash", ruleContent: "npm publish *" },
      { toolName: "FileRead" },
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
        allow: ["FileRead"],
        ask: ["system.bash(npm publish *)"],
        deny: ["Write"],
        additionalDirectories: ["/tmp/work"],
      },
    );

    expect(ctx.alwaysAllowRules.session).toEqual(["FileRead"]);
    expect(ctx.alwaysAskRules.session).toEqual(["system.bash(npm publish *)"]);
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
      { allow: ["FileRead"] },
    );

    expect(
      decideToolApproval(ctx, { toolName: "system.bash", ruleContent: "git status" }),
    ).toEqual({ behavior: "none" });
  });

  test("denies a matching content pattern before a whole-tool auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["system.bash"],
        deny: ["system.bash(rm -rf *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "system.bash",
      ruleContent: "rm -rf build",
    });

    expect(decision.behavior).toBe("deny");
    expect(decision.rule?.ruleValue.ruleContent).toBe("rm -rf *");
  });

  test("prompts for content-specific ask before a whole-tool auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["system.bash"],
        ask: ["system.bash(npm publish *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "system.bash",
      ruleContent: "npm publish package",
    });

    expect(decision.behavior).toBe("prompt");
    expect(decision.rule?.ruleBehavior).toBe("ask");
  });

  test("matches prefix-colon content rules with shared rule semantics", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { allow: ["system.bash(git:*)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "git status",
      }).behavior,
    ).toBe("auto");
    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "npm test",
      }).behavior,
    ).toBe("none");
  });

  test("keeps content-specific deny ahead of a broader content auto rule", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["system.bash(git:*)"],
        deny: ["system.bash(git push:*)"],
      },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "git push origin main",
      }).behavior,
    ).toBe("deny");
  });

  test("falls back to whole-tool auto when content rules do not match", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      {
        allow: ["system.bash"],
        ask: ["system.bash(npm publish *)"],
      },
    );

    const decision = decideToolApproval(ctx, {
      toolName: "system.bash",
      ruleContent: "git status",
    });

    expect(decision.behavior).toBe("auto");
    expect(decision.rule?.ruleValue).toEqual({ toolName: "system.bash" });
  });

  test("treats a trailing space-wildcard pattern as optional arguments", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { ask: ["system.bash(npm publish *)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "npm publish",
      }).behavior,
    ).toBe("prompt");
  });

  test("keeps escaped wildcard literals from becoming patterns", () => {
    const ctx = applyToolApprovalConfigToPermissionContext(
      createEmptyToolPermissionContext(),
      { deny: ["system.bash(echo \\\\*)"] },
    );

    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "echo *",
      }).behavior,
    ).toBe("deny");
    expect(
      decideToolApproval(ctx, {
        toolName: "system.bash",
        ruleContent: "echo anything",
      }).behavior,
    ).toBe("none");
  });
});
