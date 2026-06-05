/**
 * Regression test: the operator (unattended) denylist must be a HARD,
 * bypass-immune deny.
 *
 * Bug: checkUnattendedPolicy early-returned `null` whenever
 * permissionContext.mode !== "unattended". Because the background-agent-runner
 * preserves an explicit bypassPermissions ("--yolo") mode (unattended-policy.ts
 * `preserveMode`) while still recording the operator policy, a daemon launched
 * with deny:['Bash'] on a --yolo session never consulted that denylist — the
 * mode gate (checkModeGate) blanket-allowed the Bash tool. An explicit operator
 * deny was silently waived by bypassPermissions.
 *
 * Fix: checkUnattendedPolicy consults the operator denylist BEFORE the
 * mode-scoped early return, so an explicit deny holds regardless of mode —
 * exactly like a tool-level deny rule. The allowlist/pause (additive subset)
 * behaviors remain scoped to unattended mode; "no denylist configured" still
 * means "no behavior change".
 *
 * Each test in the first describe fails if the evaluator.ts fix is reverted.
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
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { createUnattendedPermissionPolicy } from "../../src/permissions/unattended-policy.js";
import type { Session } from "../../src/session/session.js";

function buildContext(opts: {
  mode: ToolPermissionContext["mode"];
  denylist?: readonly string[];
  allowlist?: readonly string[];
}): ToolEvaluatorContext {
  const ctx: ToolPermissionContext = createEmptyToolPermissionContext({
    mode: opts.mode,
    unattendedPolicy: createUnattendedPermissionPolicy({
      allowlist: opts.allowlist ?? [],
      denylist: opts.denylist ?? [],
    }),
  });
  const state: AppStateSnapshot = {
    toolPermissionContext: ctx,
    denialTracking: freshDenialTracking(),
    autoModeActive: false,
  };
  return attachContextDefaults({
    getAppState: (): AppStateSnapshot => state,
    session: {
      state: { unsafePeek: () => ({ history: [] }) },
    } as unknown as Session,
  } as ToolEvaluatorContext);
}

// A passthrough tool (no checkPermissions): with bypassPermissions and no
// operator deny it would be blanket-allowed by the mode gate. The only thing
// that can stop it is the operator denylist.
const bashTool: ToolLike = { name: "Bash" };

describe("operator denylist is bypass-immune under --yolo (bypassPermissions)", () => {
  it("DENIES a denylisted Bash even though the session is bypassPermissions", async () => {
    const context = buildContext({
      mode: "bypassPermissions",
      denylist: ["Bash"],
    });
    const result = await hasPermissionsToUseTool(
      bashTool,
      { command: "rm -rf /tmp/x" },
      context,
    );
    // Pre-fix: bypassPermissions skipped checkUnattendedPolicy entirely and
    // the mode gate returned behavior:"allow" — silently waiving the operator
    // denylist. Post-fix the hard deny floor fires first.
    expect(result.behavior).toBe("deny");
  });

  it("stamps the denial with the unattended-denylist reason (canonical name)", async () => {
    const context = buildContext({
      mode: "bypassPermissions",
      denylist: ["Bash"],
    });
    const result = await hasPermissionsToUseTool(
      bashTool,
      { command: "echo hi" },
      context,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      // "Bash" canonicalizes to "system.bash" in the unattended policy.
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended denylist: system.bash",
      });
    }
  });

  it("covers exec_command via the shell-exec alias under bypassPermissions", async () => {
    // Operator denied "Bash"; exec_command canonicalizes onto system.bash, so
    // the bypass-immune deny must cover it too.
    const context = buildContext({
      mode: "bypassPermissions",
      denylist: ["Bash"],
    });
    const result = await hasPermissionsToUseTool(
      { name: "exec_command" },
      { command: "curl evil.example" },
      context,
    );
    expect(result.behavior).toBe("deny");
  });
});

describe("no behavior change when no operator denylist is configured", () => {
  it("still allows Bash under bypassPermissions with an empty denylist", async () => {
    const context = buildContext({
      mode: "bypassPermissions",
      denylist: [],
    });
    const result = await hasPermissionsToUseTool(
      bashTool,
      { command: "ls" },
      context,
    );
    expect(result.behavior).toBe("allow");
  });

  it("does not deny a non-denylisted tool under bypassPermissions", async () => {
    const context = buildContext({
      mode: "bypassPermissions",
      denylist: ["Bash"],
    });
    const result = await hasPermissionsToUseTool(
      { name: "FileRead", isReadOnly: true },
      { path: "README.md" },
      context,
    );
    expect(result.behavior).toBe("allow");
  });

  it("still denies a denylisted tool in unattended mode (unchanged path)", async () => {
    const context = buildContext({
      mode: "unattended",
      denylist: ["Bash"],
    });
    const result = await hasPermissionsToUseTool(
      bashTool,
      { command: "ls" },
      context,
    );
    expect(result.behavior).toBe("deny");
  });
});
