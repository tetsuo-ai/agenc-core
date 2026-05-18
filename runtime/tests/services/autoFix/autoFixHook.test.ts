import { describe, expect, test } from "vitest";
import type { PostToolUseHook } from "../../tools/hooks.js";
import {
  buildAutoFixContext,
  createAutoFixPostToolHook,
  shouldRunAutoFix,
} from "./autoFixHook.js";
import type { AutoFixConfig } from "./autoFixConfig.js";

const CONFIG: AutoFixConfig = {
  enabled: true,
  lint: "lint",
  maxRetries: 1,
  timeout: 30_000,
};

function hookInput(toolName = "Edit"): Parameters<PostToolUseHook>[0] {
  return {
    invocation: {
      callId: "call-1",
      toolName: { name: toolName },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
      session: {},
      turn: { subId: "turn-1" },
      tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    },
    tool: { name: toolName, inputSchema: {}, execute: async () => ({ content: "" }) },
    args: {},
    result: { content: "ok" },
  };
}

describe("shouldRunAutoFix", () => {
  test("returns true for AgenC file mutation tools", () => {
    expect(shouldRunAutoFix("Edit", CONFIG)).toBe(true);
    expect(shouldRunAutoFix("MultiEdit", CONFIG)).toBe(true);
    expect(shouldRunAutoFix("Write", CONFIG)).toBe(true);
  });

  test("returns true for donor-compatible file tool aliases", () => {
    expect(shouldRunAutoFix("file_edit", CONFIG)).toBe(true);
    expect(shouldRunAutoFix("file_write", CONFIG)).toBe(true);
  });

  test("returns false for non-file tools and null config", () => {
    expect(shouldRunAutoFix("Bash", CONFIG)).toBe(false);
    expect(shouldRunAutoFix("Edit", null)).toBe(false);
  });
});

describe("buildAutoFixContext", () => {
  test("formats lint errors as assistant-readable context", () => {
    const context = buildAutoFixContext({
      hasErrors: true,
      lintOutput: "src/foo.ts:10:5 error no-unused-vars",
      lintExitCode: 1,
      errorSummary: "Lint errors (exit code 1):\nsrc/foo.ts:10:5 error no-unused-vars",
    });
    expect(context).toContain("AUTO-FIX");
    expect(context).toContain("no-unused-vars");
    expect(context).toContain("Please fix");
  });

  test("returns null when no errors exist", () => {
    expect(buildAutoFixContext({ hasErrors: false })).toBeNull();
  });
});

describe("createAutoFixPostToolHook", () => {
  test("returns additional context when checks fail", async () => {
    const hook = createAutoFixPostToolHook({
      configSource: () => CONFIG,
      cwd: process.cwd(),
      runCheck: async () => ({
        hasErrors: true,
        lintExitCode: 1,
        lintOutput: "bad lint",
        errorSummary: "Lint errors (exit code 1):\nbad lint",
      }),
    });

    const decision = await hook(hookInput());
    expect(decision.kind).toBe("additionalContext");
    expect(decision.kind === "additionalContext" ? decision.content[0] : "").toContain(
      "bad lint",
    );
  });

  test("enforces maxRetries for the same turn scope", async () => {
    const hook = createAutoFixPostToolHook({
      configSource: () => CONFIG,
      cwd: process.cwd(),
      runCheck: async () => ({
        hasErrors: true,
        errorSummary: "Lint errors (exit code 1):\nstill bad",
      }),
    });

    await hook(hookInput());
    const second = await hook(hookInput());
    expect(second.kind).toBe("additionalContext");
    expect(second.kind === "additionalContext" ? second.content[0] : "").toContain(
      "Maximum retry limit (1) reached",
    );
  });

  test("resets retry count when checks pass", async () => {
    let failing = true;
    const hook = createAutoFixPostToolHook({
      configSource: () => ({ ...CONFIG, maxRetries: 2 }),
      cwd: process.cwd(),
      runCheck: async () =>
        failing
          ? { hasErrors: true, errorSummary: "Lint errors (exit code 1):\nbad" }
          : { hasErrors: false },
    });

    const first = await hook(hookInput());
    expect(first.kind).toBe("additionalContext");
    failing = false;
    const second = await hook(hookInput());
    expect(second.kind).toBe("continue");
    failing = true;
    const third = await hook(hookInput());
    expect(third.kind).toBe("additionalContext");
    expect(third.kind === "additionalContext" ? third.content[0] : "").toContain("bad");
  });

  test("contains check failures and reports them to the error sink", async () => {
    const errors: unknown[] = [];
    const hook = createAutoFixPostToolHook({
      configSource: () => CONFIG,
      cwd: process.cwd(),
      runCheck: async () => {
        throw new Error("lint runner failed");
      },
      onError: (error) => errors.push(error),
    });

    const decision = await hook(hookInput());
    expect(decision.kind).toBe("continue");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("lint runner failed");
  });
});
