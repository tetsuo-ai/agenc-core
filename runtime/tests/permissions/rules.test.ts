import { describe, expect, test } from "vitest";
import {
  applyPermissionRulesToPermissionContext,
  clearAllRulesFromSource,
  convertRulesToUpdates,
  escapeRuleContent,
  filterDeniedAgents,
  findMatchingContentRule,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForTool,
  isPermissionUpdateDestination,
  matchContentRule,
  matchRule,
  parseRuleString,
  serializeRuleValue,
  setRulesForSource,
  toolAlwaysAllowedRule,
  unescapeRuleContent,
} from "./rules.js";
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
} from "./permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type PermissionRule,
} from "./types.js";

// ---------------------------------------------------------------------------
// Escape / unescape
// ---------------------------------------------------------------------------

describe("escapeRuleContent / unescapeRuleContent", () => {
  test("escapes parentheses", () => {
    expect(escapeRuleContent("print(1)")).toBe("print\\(1\\)");
  });

  test("escapes backslashes before parens so roundtrip works", () => {
    expect(escapeRuleContent("a\\b")).toBe("a\\\\b");
  });

  test("unescape is inverse of escape (roundtrip)", () => {
    const cases = [
      "plain",
      "print(1)",
      "echo \"hello world\"",
      "a\\b\\c",
      "(nested(group))",
      "trailing\\",
    ];
    for (const c of cases) {
      expect(unescapeRuleContent(escapeRuleContent(c))).toBe(c);
    }
  });
});

// ---------------------------------------------------------------------------
// parseRuleString
// ---------------------------------------------------------------------------

describe("parseRuleString", () => {
  test("parses plain tool name", () => {
    expect(parseRuleString("system.bash")).toEqual({ toolName: "system.bash" });
  });

  test("parses tool with content", () => {
    expect(parseRuleString("system.bash(npm install)")).toEqual({
      toolName: "system.bash",
      ruleContent: "npm install",
    });
  });

  test("collapses system.bash(*) to whole-tool rule", () => {
    expect(parseRuleString("system.bash(*)")).toEqual({ toolName: "system.bash" });
  });

  test("collapses system.bash() to whole-tool rule", () => {
    expect(parseRuleString("system.bash()")).toEqual({ toolName: "system.bash" });
  });

  test("keeps tool names literal", () => {
    expect(parseRuleString("spawn_agent")).toEqual({ toolName: "spawn_agent" });
    expect(parseRuleString("spawn_agent(analysis)")).toEqual({
      toolName: "spawn_agent",
      ruleContent: "analysis",
    });
  });

  test("handles escaped parens in content", () => {
    const parsed = parseRuleString("system.bash(python -c \"print\\(1\\)\")");
    expect(parsed).toEqual({
      toolName: "system.bash",
      ruleContent: 'python -c "print(1)"',
    });
  });

  test("returns null for empty input", () => {
    expect(parseRuleString("")).toBeNull();
  });

  test("returns tool-only when content closes early", () => {
    // "system.bash(foo)extra" — trailing text after close paren; treat as
    // plain tool name (invalid shape).
    const p = parseRuleString("system.bash(foo)extra");
    expect(p).toEqual({ toolName: "system.bash(foo)extra" });
  });
});

// ---------------------------------------------------------------------------
// serializeRuleValue + roundtrip
// ---------------------------------------------------------------------------

describe("serializeRuleValue", () => {
  test("omits parens for whole-tool rule", () => {
    expect(serializeRuleValue({ toolName: "system.bash" })).toBe("system.bash");
  });

  test("includes parens for content", () => {
    expect(
      serializeRuleValue({ toolName: "system.bash", ruleContent: "git commit:*" }),
    ).toBe("system.bash(git commit:*)");
  });

  test("escapes parens in content", () => {
    expect(
      serializeRuleValue({ toolName: "system.bash", ruleContent: "print(1)" }),
    ).toBe("system.bash(print\\(1\\))");
  });

  test("roundtrip preserves input", () => {
    const cases = [
      "system.bash",
      "FileRead",
      "system.bash(git commit:*)",
      "system.bash(python -c \"print\\(1\\)\")",
      "mcp__server1__tool1",
    ];
    for (const c of cases) {
      const parsed = parseRuleString(c);
      expect(parsed).not.toBeNull();
      expect(serializeRuleValue(parsed!)).toBe(c);
    }
  });
});

// ---------------------------------------------------------------------------
// matchRule
// ---------------------------------------------------------------------------

describe("matchRule", () => {
  const allowBash: PermissionRule = {
    source: "cliArg",
    ruleBehavior: "allow",
    ruleValue: { toolName: "system.bash" },
  };

  test("whole-tool rule matches plain tool name", () => {
    expect(matchRule(allowBash, { name: "system.bash" })).toBe(true);
  });

  test("whole-tool rule does not match when content is set", () => {
    const rule: PermissionRule = {
      ...allowBash,
      ruleValue: { toolName: "system.bash", ruleContent: "foo:*" },
    };
    expect(matchRule(rule, { name: "system.bash" })).toBe(false);
  });

  test("mcp server rule matches tools under that server", () => {
    const rule: PermissionRule = {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "mcp__myserver" },
    };
    expect(matchRule(rule, { name: "mcp__myserver__read" })).toBe(true);
  });

  test("mcp wildcard rule matches", () => {
    const rule: PermissionRule = {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "mcp__s__*" },
    };
    expect(matchRule(rule, { name: "mcp__s__tool1" })).toBe(true);
  });

  test("does not match different tool names", () => {
    expect(matchRule(allowBash, { name: "FileRead" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flatten + per-tool lookup
// ---------------------------------------------------------------------------

function buildCtxWithRules(rules: PermissionRule[]) {
  const ctx = createEmptyToolPermissionContext();
  return applyPermissionRulesToPermissionContext(ctx, rules);
}

describe("getAllowRules / getDenyRules / getAskRules", () => {
  test("flattens rules in source priority order", () => {
    const r1: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "FileRead" },
    };
    const r2: PermissionRule = {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash" },
    };
    const ctx = buildCtxWithRules([r2, r1]);
    const flat = getAllowRules(ctx);
    expect(flat[0]?.source).toBe("userSettings");
    expect(flat[1]?.source).toBe("session");
  });

  test("deny and ask buckets are independent", () => {
    const deny: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Write" },
    };
    const ask: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "ask",
      ruleValue: { toolName: "system.bash", ruleContent: "npm publish:*" },
    };
    const ctx = buildCtxWithRules([deny, ask]);
    expect(getDenyRules(ctx).length).toBe(1);
    expect(getAskRules(ctx).length).toBe(1);
    expect(getAllowRules(ctx).length).toBe(0);
  });

  test("toolAlwaysAllowedRule returns first matching allow", () => {
    const allow: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "FileRead" },
    };
    const ctx = buildCtxWithRules([allow]);
    expect(toolAlwaysAllowedRule(ctx, "FileRead")?.source).toBe("userSettings");
    expect(toolAlwaysAllowedRule(ctx, "Write")).toBeNull();
  });

  test("getDenyRuleForTool / getAskRuleForTool look up whole-tool rules", () => {
    const deny: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "system.bash" },
    };
    const ctx = buildCtxWithRules([deny]);
    expect(getDenyRuleForTool(ctx, "system.bash")?.source).toBe("userSettings");
    // Distinct canonical shell tools share one execution-risk family.
    expect(getDenyRuleForTool(ctx, "exec_command")?.source).toBe("userSettings");
    expect(getDenyRuleForTool(ctx, "system.bash")?.source).toBe("userSettings");
    expect(getDenyRuleForTool(ctx, "desktop.bash")).toBeNull();
    expect(getDenyRuleForTool(ctx, "FileRead")).toBeNull();
    expect(getAskRuleForTool(ctx, "system.bash")).toBeNull();
  });

  test("deny exec_command covers the canonical shell risk family", () => {
    const deny: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "exec_command" },
    };
    const ctx = buildCtxWithRules([deny]);
    expect(getDenyRuleForTool(ctx, "system.bash")?.source).toBe("userSettings");
    expect(getDenyRuleForTool(ctx, "exec_command")?.source).toBe("userSettings");
  });

  test("canonical builtin rules match exact dispatch names", () => {
    const denyRead: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "FileRead" },
    };
    const askEdit: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Edit" },
    };
    const allowWrite: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "Write" },
    };
    const denyGrep: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "Grep" },
    };
    const askGlob: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Glob" },
    };
    const ctx = buildCtxWithRules([
      denyRead,
      askEdit,
      allowWrite,
      denyGrep,
      askGlob,
    ]);

    expect(getDenyRuleForTool(ctx, "FileRead")?.source).toBe("userSettings");
    expect(getAskRuleForTool(ctx, "Edit")?.source).toBe("userSettings");
    expect(toolAlwaysAllowedRule(ctx, "Write")?.source).toBe("userSettings");
    expect(getDenyRuleForTool(ctx, "FileRead")?.source).toBe("userSettings");
    expect(getDenyRuleForTool(ctx, "Grep")?.source).toBe("userSettings");
    expect(getAskRuleForTool(ctx, "Glob")?.source).toBe("userSettings");
  });
});

describe("getRuleByContentsForTool", () => {
  test("returns content-qualified rules for a given tool+behavior", () => {
    const a: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash", ruleContent: "git commit:*" },
    };
    const b: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash", ruleContent: "npm install" },
    };
    const ctx = buildCtxWithRules([a, b]);
    const map = getRuleByContentsForTool(ctx, "system.bash", "allow");
    expect(map.size).toBe(2);
    expect(map.get("git commit:*")?.ruleValue.ruleContent).toBe("git commit:*");
  });

  test("skips whole-tool rules", () => {
    const whole: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash" },
    };
    const ctx = buildCtxWithRules([whole]);
    expect(getRuleByContentsForTool(ctx, "system.bash", "allow").size).toBe(0);
  });
});

describe("matchContentRule / findMatchingContentRule", () => {
  test("matches prefix-colon rules against command text and prefixes", () => {
    expect(matchContentRule("git:*", "git status")).toBe(true);
    expect(matchContentRule("git:*", "git")).toBe(true);
    expect(
      matchContentRule("git commit:*", "git commit -m msg", {
        prefix: "git commit",
      }),
    ).toBe(true);
    expect(matchContentRule("git:*", "npm test")).toBe(false);
  });

  test("matches wildcard patterns and escaped literal stars", () => {
    expect(matchContentRule("git * status", "git origin status")).toBe(true);
    expect(matchContentRule("echo \\*", "echo *")).toBe(true);
    expect(matchContentRule("echo \\*", "echo hi")).toBe(false);
  });

  test("returns the first matching rule from a content-rule map", () => {
    const a: PermissionRule = {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash", ruleContent: "git:*" },
    };
    const b: PermissionRule = {
      source: "session",
      ruleBehavior: "allow",
      ruleValue: { toolName: "system.bash", ruleContent: "npm:*" },
    };
    const match = findMatchingContentRule(
      new Map([
        ["git:*", a],
        ["npm:*", b],
      ]),
      "npm test",
    );
    expect(match).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// spawn_agent(agentType) helpers
// ---------------------------------------------------------------------------

describe("agent deny helpers", () => {
  test("getDenyRuleForAgent matches spawn_agent(<type>) by content", () => {
    const deny: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "spawn_agent", ruleContent: "Explore" },
    };
    const ctx = buildCtxWithRules([deny]);
    expect(getDenyRuleForAgent(ctx, "Explore")?.ruleValue.ruleContent).toBe(
      "Explore",
    );
    expect(getDenyRuleForAgent(ctx, "Other")).toBeNull();
  });

  test("filterDeniedAgents drops denied agents in order", () => {
    const deny: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "deny",
      ruleValue: { toolName: "spawn_agent", ruleContent: "Bad" },
    };
    const ctx = buildCtxWithRules([deny]);
    const candidates = [
      { agentType: "Good" },
      { agentType: "Bad" },
      { agentType: "Other" },
    ];
    const out = filterDeniedAgents(ctx, candidates);
    expect(out).toEqual([{ agentType: "Good" }, { agentType: "Other" }]);
  });
});

// ---------------------------------------------------------------------------
// applyPermissionUpdate / setRulesForSource
// ---------------------------------------------------------------------------

describe("applyPermissionUpdate", () => {
  test("setMode updates only the mode", () => {
    const ctx = createEmptyToolPermissionContext();
    const out = applyPermissionUpdate(ctx, {
      type: "setMode",
      destination: "session",
      mode: "acceptEdits",
    });
    expect(out.mode).toBe("acceptEdits");
  });

  test("setMode cannot activate bypassPermissions", () => {
    const ctx = createEmptyToolPermissionContext();
    expect(() =>
      applyPermissionUpdate(ctx, {
        type: "setMode",
        destination: "session",
        mode: "bypassPermissions",
      }),
    ).toThrow(/exact-cwd consent transition/u);
    expect(ctx.mode).toBe("default");
  });

  test("addRules appends to the correct source bucket", () => {
    const ctx = createEmptyToolPermissionContext();
    const out = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "FileRead" }],
    });
    expect(out.alwaysAllowRules.session).toEqual(["FileRead"]);
  });

  test("addRules keeps source buckets canonical when a rule is added twice", () => {
    const duplicated = applyPermissionUpdate(
      applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [{ toolName: "Write" }],
      }),
      {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [{ toolName: "Write" }],
      },
    );

    expect(duplicated.alwaysDenyRules.session).toEqual(["Write"]);
  });

  test("replaceRules replaces the entire bucket", () => {
    const ctx = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "A" }, { toolName: "B" }],
    });
    const replaced = applyPermissionUpdate(ctx, {
      type: "replaceRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "C" }],
    });
    expect(replaced.alwaysAllowRules.session).toEqual(["C"]);
  });

  test("removeRules filters matching rules", () => {
    const ctx = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "A" }, { toolName: "B" }, { toolName: "C" }],
    });
    const removed = applyPermissionUpdate(ctx, {
      type: "removeRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "B" }],
    });
    expect(removed.alwaysAllowRules.session).toEqual(["A", "C"]);
  });

  test("addDirectories stores directories with their source", () => {
    const ctx = createEmptyToolPermissionContext();
    const out = applyPermissionUpdate(ctx, {
      type: "addDirectories",
      destination: "session",
      directories: ["/tmp/a", "/tmp/b"],
    });
    expect(out.additionalWorkingDirectories.size).toBe(2);
    expect(out.additionalWorkingDirectories.get("/tmp/a")?.source).toBe(
      "session",
    );
  });

  test("removeDirectories drops matching paths", () => {
    const ctx = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addDirectories",
      destination: "session",
      directories: ["/tmp/a", "/tmp/b"],
    });
    const out = applyPermissionUpdate(ctx, {
      type: "removeDirectories",
      destination: "session",
      directories: ["/tmp/a"],
    });
    expect(out.additionalWorkingDirectories.size).toBe(1);
    expect(out.additionalWorkingDirectories.has("/tmp/a")).toBe(false);
  });

  test("returns a frozen context", () => {
    const ctx = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "FileRead" }],
    });
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("applyPermissionUpdates (multi)", () => {
  test("applies updates in order", () => {
    const out = applyPermissionUpdates(createEmptyToolPermissionContext(), [
      {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [{ toolName: "A" }],
      },
      {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [{ toolName: "B" }],
      },
    ]);
    expect(out.alwaysAllowRules.session).toEqual(["A", "B"]);
  });
});

describe("setRulesForSource", () => {
  test("writes rule strings to a given source regardless of destination-eligibility", () => {
    const ctx = createEmptyToolPermissionContext();
    const out = setRulesForSource(ctx, "policySettings", "allow", [
      "FileRead",
      "system.bash(git:*)",
    ]);
    expect(out.alwaysAllowRules.policySettings).toEqual([
      "FileRead",
      "system.bash(git:*)",
    ]);
  });

  test("does not touch other sources", () => {
    let ctx = setRulesForSource(
      createEmptyToolPermissionContext(),
      "userSettings",
      "allow",
      ["A"],
    );
    ctx = setRulesForSource(ctx, "session", "allow", ["B"]);
    expect(ctx.alwaysAllowRules.userSettings).toEqual(["A"]);
    expect(ctx.alwaysAllowRules.session).toEqual(["B"]);
  });
});

// ---------------------------------------------------------------------------
// clearAllRulesFromSource
// ---------------------------------------------------------------------------

describe("clearAllRulesFromSource", () => {
  test("clears allow, deny and ask buckets for a given source", () => {
    let ctx = createEmptyToolPermissionContext();
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "A" }],
    });
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [{ toolName: "B" }],
    });
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      behavior: "ask",
      rules: [{ toolName: "C" }],
    });
    const cleared = clearAllRulesFromSource(ctx, "session");
    expect(cleared.alwaysAllowRules.session).toEqual([]);
    expect(cleared.alwaysDenyRules.session).toEqual([]);
    expect(cleared.alwaysAskRules.session).toEqual([]);
  });

  test("does not drop rules from other sources", () => {
    const otherRule: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "FileRead" },
    };
    let ctx = buildCtxWithRules([otherRule]);
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "system.bash" }],
    });
    const cleared = clearAllRulesFromSource(ctx, "session");
    expect(cleared.alwaysAllowRules.userSettings).toEqual(["FileRead"]);
    expect(cleared.alwaysAllowRules.session).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// convertRulesToUpdates
// ---------------------------------------------------------------------------

describe("convertRulesToUpdates", () => {
  test("groups by source and behavior", () => {
    const rules: PermissionRule[] = [
      {
        source: "userSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "A" },
      },
      {
        source: "userSettings",
        ruleBehavior: "deny",
        ruleValue: { toolName: "B" },
      },
      {
        source: "session",
        ruleBehavior: "allow",
        ruleValue: { toolName: "C" },
      },
    ];
    const updates = convertRulesToUpdates(rules, "addRules");
    expect(updates.length).toBe(3);
    for (const u of updates) {
      expect(u.type).toBe("addRules");
    }
  });

  test("filters out rules whose source is not a destination", () => {
    const rules: PermissionRule[] = [
      {
        source: "command",
        ruleBehavior: "allow",
        ruleValue: { toolName: "A" },
      },
      {
        source: "session",
        ruleBehavior: "allow",
        ruleValue: { toolName: "B" },
      },
    ];
    const updates = convertRulesToUpdates(rules, "addRules");
    expect(updates.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Destination helpers
// ---------------------------------------------------------------------------

describe("isPermissionUpdateDestination", () => {
  test("recognizes valid destinations", () => {
    for (const s of [
      "userSettings",
      "projectSettings",
      "localSettings",
      "session",
      "cliArg",
    ] as const) {
      expect(isPermissionUpdateDestination(s)).toBe(true);
    }
  });

  test("rejects non-destination sources", () => {
    for (const s of ["flagSettings", "policySettings", "command"] as const) {
      expect(isPermissionUpdateDestination(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// applyPermissionRulesToPermissionContext installs ALL source types
// ---------------------------------------------------------------------------

describe("applyPermissionRulesToPermissionContext", () => {
  test("installs rules from editable sources", () => {
    const rules: PermissionRule[] = [
      {
        source: "userSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "FileRead" },
      },
    ];
    const ctx = applyPermissionRulesToPermissionContext(
      createEmptyToolPermissionContext(),
      rules,
    );
    expect(ctx.alwaysAllowRules.userSettings).toEqual(["FileRead"]);
  });

  test("installs rules from policySettings (non-destination source)", () => {
    const rules: PermissionRule[] = [
      {
        source: "policySettings",
        ruleBehavior: "deny",
        ruleValue: { toolName: "system.bash", ruleContent: "rm -rf:*" },
      },
    ];
    const ctx = applyPermissionRulesToPermissionContext(
      createEmptyToolPermissionContext(),
      rules,
    );
    expect(ctx.alwaysDenyRules.policySettings).toEqual(["system.bash(rm -rf:*)"]);
  });

  test("is additive across calls", () => {
    const first: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "A" },
    };
    const second: PermissionRule = {
      source: "userSettings",
      ruleBehavior: "allow",
      ruleValue: { toolName: "B" },
    };
    let ctx = applyPermissionRulesToPermissionContext(
      createEmptyToolPermissionContext(),
      [first],
    );
    ctx = applyPermissionRulesToPermissionContext(ctx, [second]);
    expect(ctx.alwaysAllowRules.userSettings).toEqual(["A", "B"]);
  });
});
