/**
 * Regression test (ihunt) for the unattended-allowlist auto-allow leak.
 *
 * Bug: in unattended mode, a tool on the unattended allowlist whose own
 * checkPermissions() returns behavior:"ask" with decisionReason.type:"other"
 * (the exact shape Bash's `bash_parse_unavailable` ask carries when it
 * encounters shell constructs the runtime cannot verify — bash.ts:189-195)
 * was auto-ALLOWED. checkRuleBasedPermissions only surfaces the narrowed ask
 * set (requiresUserInteraction / content ask rule / safetyCheck) as
 * `ruleBased`, so a type:"other" ask reached checkUnattendedPolicy as
 * ruleBased===null and fell through to unattendedAllowDecision — defeating
 * the bash layer's explicit "Never silently allow" safeguard.
 *
 * Fix: checkUnattendedPolicy re-resolves the tool-level permission result for
 * allowlisted tools and pauses on ANY ask, including type:"other".
 *
 * Each test fails if the evaluator.ts fix is reverted.
 */

import { describe, expect, it } from "vitest";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
  type ToolLike,
} from "../../src/permissions/evaluator.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import {
  createEmptyToolPermissionContext,
  type PermissionResult,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { createUnattendedPermissionPolicy } from "../../src/permissions/unattended-policy.js";
import type { Session } from "../../src/session/session.js";

function buildUnattendedContext(allowlist: readonly string[]): {
  context: ToolEvaluatorContext;
} {
  const ctx: ToolPermissionContext = createEmptyToolPermissionContext({
    mode: "unattended",
    unattendedPolicy: createUnattendedPermissionPolicy({
      allowlist,
      denylist: [],
    }),
  });
  const state: AppStateSnapshot = {
    toolPermissionContext: ctx,
    denialTracking: freshDenialTracking(),
    autoModeActive: false,
  };
  const context = attachContextDefaults({
    getAppState: (): AppStateSnapshot => state,
    session: {
      state: { unsafePeek: () => ({ history: [] }) },
    } as unknown as Session,
  } as ToolEvaluatorContext);
  return { context };
}

/**
 * Faithfully mirrors the ask emitted by bashToolHasPermission for an
 * unverifiable shell construct: behavior:"ask", decisionReason.type:"other",
 * reason:"bash_parse_unavailable" (src/permissions/bash.ts:189-195).
 */
function makeBashParseUnavailableTool(name: string): ToolLike {
  return {
    name,
    checkPermissions: (): PermissionResult => ({
      behavior: "ask" as const,
      message:
        "Bash command contains shell constructs this runtime cannot verify; confirm intent.",
      decisionReason: { type: "other" as const, reason: "bash_parse_unavailable" },
    }),
  };
}

describe("unattended allowlist — bash_parse_unavailable ask must pause", () => {
  it("pauses an allowlisted Bash whose checkPermissions asks with type:other", async () => {
    const { context } = buildUnattendedContext(["Bash"]);
    const result = await hasPermissionsToUseTool(
      makeBashParseUnavailableTool("Bash"),
      { command: "echo $(date)" },
      context,
    );
    // Pre-fix this returned behavior:"allow" with reason
    // "unattended allowlist: Bash" — silently executing the command.
    expect(result.behavior).toBe("ask");
  });

  it("pauses an allowlisted system.bash with a type:other ask (canonical alias)", async () => {
    const { context } = buildUnattendedContext(["system.bash"]);
    const result = await hasPermissionsToUseTool(
      makeBashParseUnavailableTool("system.bash"),
      { command: "echo `whoami`" },
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("does not leak the type:other ask through as an unattended allow", async () => {
    const { context } = buildUnattendedContext(["Bash"]);
    const result = await hasPermissionsToUseTool(
      makeBashParseUnavailableTool("Bash"),
      { command: "echo $(date)" },
      context,
    );
    expect(result.behavior).not.toBe("allow");
    if (result.behavior === "allow") {
      // Belt-and-suspenders: the old leak stamped this exact reason
      // ("Bash" canonicalizes to "system.bash" in the unattended policy).
      expect(result.decisionReason).not.toMatchObject({
        type: "other",
        reason: "unattended allowlist: system.bash",
      });
    }
  });

  it("still auto-allows an allowlisted tool whose checkPermissions allows", async () => {
    const { context } = buildUnattendedContext(["Bash"]);
    const tool: ToolLike = {
      name: "Bash",
      checkPermissions: (): PermissionResult => ({
        behavior: "allow" as const,
        updatedInput: { command: "ls" },
      }),
    };
    const result = await hasPermissionsToUseTool(
      tool,
      { command: "ls" },
      context,
    );
    // The fix must not over-pause: a clean tool-level allow on an
    // allowlisted tool still runs unattended.
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      // "Bash" canonicalizes to "system.bash" via the unattended alias map.
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended allowlist: system.bash",
      });
    }
  });

  it("still auto-allows an allowlisted read-only tool with no checkPermissions", async () => {
    const { context } = buildUnattendedContext(["FileRead"]);
    const result = await hasPermissionsToUseTool(
      { name: "FileRead", isReadOnly: true },
      { path: "README.md" },
      context,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended allowlist: FileRead",
      });
    }
  });
});
