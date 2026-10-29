import { describe, expect, test } from "vitest";

import { readHookSpecificOutput } from "./output-parser.js";

describe("PreToolUse deny parsing", () => {
  test.each([
    { hookSpecificOutput: { permissionDecision: "deny" } },
    { decision: "deny", hookSpecificOutput: { permissionDecision: "allow" } },
    { decision: "block", hookSpecificOutput: { permissionDecision: "ask" } },
    { decision: "deny", hookSpecificOutput: null },
    { decision: "block", hookSpecificOutput: [] },
    { permissionDecision: "deny" },
    { decision: "deny" },
    { decision: "block" },
    { hookSpecificOutput: { decision: "deny" } },
    { hookSpecificOutput: { decision: "block" } },
    { decision: { behavior: "deny" } },
    { hookSpecificOutput: { decision: { behavior: "deny" } } },
    {
      hookSpecificOutput: { permissionDecision: "deny" },
      decision: "deny",
      reason: "",
    },
  ])("retains a deny despite invalid fields: %j", (output) => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({ ...output, action: "block", message: "policy" }),
      "PreToolUse",
    );

    expect(parsed.preToolUseDenyReason).toBe("Blocked by PreToolUse hook");
    expect(parsed.invalid).toBeDefined();
  });

  test("retains the reason and the unsupported-root-field warning", () => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "  policy refused  ",
        },
        action: "block",
        message: "policy refused",
      }),
      "PreToolUse",
    );

    expect(parsed.preToolUseDenyReason).toBe("policy refused");
    expect(parsed.invalid).toContain("hook output returned unsupported field action");
    expect(parsed.invalid).toContain("hook output returned unsupported field message");
  });

  test.each([undefined, "", "   ", 42, {}])(
    "uses a fallback when a deny reason is absent or invalid: %j",
    (reason) => {
      const parsed = readHookSpecificOutput(
        JSON.stringify({ decision: "deny", reason }),
        "PreToolUse",
      );
      expect(parsed.preToolUseDenyReason).toBe("Blocked by PreToolUse hook");
    },
  );

  test.each(["deny", "block"])("retains the root %s reason", (decision) => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({ decision, reason: "root policy", extra: true }),
      "PreToolUse",
    );
    expect(parsed.preToolUseDenyReason).toBe("root policy");
    expect(parsed.invalid).toContain("unsupported field extra");
  });

  test("retains a decision object denial message", () => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({ decision: { behavior: "deny", message: "policy" } }),
      "PreToolUse",
    );
    expect(parsed.preToolUseDenyReason).toBe("policy");
  });

  test.each([
    "ordinary hook stdout",
    "deny",
    "{malformed",
    "[]",
    JSON.stringify({ action: "block", message: "no decision" }),
    JSON.stringify({ permissionDecision: "block" }),
    JSON.stringify({ permissionDecision: "allow", extra: true }),
    JSON.stringify({ additionalContext: 'the text says decision: "deny"' }),
  ])("does not infer a deny from other output: %s", (stdout) => {
    expect(readHookSpecificOutput(stdout, "PreToolUse").preToolUseDenyReason)
      .toBeUndefined();
  });

  test("plain stdout is not structured output", () => {
    expect(readHookSpecificOutput("ordinary hook stdout", "PreToolUse"))
      .toEqual({ explicit: false });
  });

  test("deny recovery is confined to PreToolUse", () => {
    const parsed = readHookSpecificOutput(
      JSON.stringify({ decision: "deny", extra: true }),
      "PostToolUse",
    );
    expect(parsed.preToolUseDenyReason).toBeUndefined();
    expect(parsed.invalid).toContain("unsupported field extra");
  });
});
