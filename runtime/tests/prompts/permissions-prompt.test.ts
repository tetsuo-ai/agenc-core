/**
 * Tests for AgenC permissions/sandbox prompt injection.
 *
 * Two layers:
 *   1. Each constant keeps the expected markdown payload stable.
 *   2. `getPermissionsSection` selects the right pair, substitutes the
 *      `{{network_access}}` placeholder, and composes the section in
 *      AgenC order (sandbox-then-approval).
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import {
  APPROVAL_POLICY_BYPASS_ESCALATION,
  APPROVAL_POLICY_NEVER,
  APPROVAL_POLICY_ON_FAILURE,
  APPROVAL_POLICY_ON_REQUEST,
  APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION,
  APPROVAL_POLICY_UNLESS_TRUSTED,
  SANDBOX_MODE_DANGER_FULL_ACCESS,
  SANDBOX_MODE_EXTERNAL,
  SANDBOX_MODE_READ_ONLY,
  SANDBOX_MODE_WORKSPACE_WRITE,
  getPermissionsSection,
} from "./permissions-prompt.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";

function ctxForMode(mode: PermissionMode): ToolPermissionContext {
  return createEmptyToolPermissionContext({ mode });
}

const WORKSPACE_AUTHORITY = {
  sandboxPolicy: "workspace_write" as const,
  networkSandboxPolicy: { enabled: false },
};

function permissionsSection(
  mode: PermissionMode,
  authority = WORKSPACE_AUTHORITY,
): string | null {
  return getPermissionsSection(ctxForMode(mode), authority);
}

function unattendedCtx(
  allowlist: readonly string[],
  denylist: readonly string[],
): ToolPermissionContext {
  return createEmptyToolPermissionContext({
    mode: "unattended",
    unattendedPolicy: { allowlist, denylist },
  });
}

describe("approval-policy constants", () => {
  test("never.md", () => {
    expect(APPROVAL_POLICY_NEVER).toBe(
      "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.\n",
    );
  });

  test("unless_trusted.md (note the leading space)", () => {
    expect(APPROVAL_POLICY_UNLESS_TRUSTED.startsWith(" ")).toBe(true);
    expect(APPROVAL_POLICY_UNLESS_TRUSTED).toContain(
      "`approval_policy` is `unless-trusted`",
    );
  });

  test("on_failure.md", () => {
    expect(APPROVAL_POLICY_ON_FAILURE).toContain(
      "`approval_policy` is `on-failure`",
    );
    expect(APPROVAL_POLICY_ON_FAILURE.endsWith("\n")).toBe(true);
  });

  test("on_request.md", () => {
    expect(APPROVAL_POLICY_ON_REQUEST).toContain("# Escalation Requests");
    expect(APPROVAL_POLICY_ON_REQUEST).toContain("## prefix_rule guidance");
  });

  test("on_request_rule_request_permission.md", () => {
    expect(APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION).toContain(
      "# Permission Requests",
    );
    expect(APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION).toContain(
      '`sandbox_permissions: "with_additional_permissions"`',
    );
  });
});

describe("sandbox-mode constants", () => {
  test("danger_full_access.md", () => {
    expect(SANDBOX_MODE_DANGER_FULL_ACCESS).toBe(
      "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is {{network_access}}.\n",
    );
  });

  test("workspace_write.md", () => {
    expect(SANDBOX_MODE_WORKSPACE_WRITE).toBe(
      "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is {{network_access}}.\n",
    );
  });

  test("read_only.md", () => {
    expect(SANDBOX_MODE_READ_ONLY).toBe(
      "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is {{network_access}}.\n",
    );
  });

  test("external_sandbox.md", () => {
    expect(SANDBOX_MODE_EXTERNAL).toContain(
      "`sandbox_mode` is `external-sandbox`",
    );
  });
});

describe("getPermissionsSection", () => {
  test("returns null when ctx is null", () => {
    expect(getPermissionsSection(null, WORKSPACE_AUTHORITY)).toBeNull();
  });

  test("plan mode → unless_trusted approval + read_only sandbox (restricted network)", () => {
    const out = getPermissionsSection(ctxForMode("plan"), {
      sandboxPolicy: "read_only",
      networkSandboxPolicy: { enabled: false },
    });
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: plan");
    // Sandbox first. Trailing newline of the .md is stripped.
    expect(out).toContain(
      "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted.",
    );
    // Then approval (verbatim, leading space preserved).
    expect(out).toContain(
      " Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `unless-trusted`",
    );
    // Placeholder is fully substituted.
    expect(out).not.toContain("{{network_access}}");
    // Sandbox precedes approval.
    const sandboxIdx = out!.indexOf("`sandbox_mode` is `read-only`");
    const approvalIdx = out!.indexOf("`approval_policy` is `unless-trusted`");
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBeGreaterThan(sandboxIdx);
  });

  test("default mode → on_request approval + workspace_write sandbox", () => {
    const out = permissionsSection("default");
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: default");
    expect(out).toContain("`sandbox_mode` is `workspace-write`");
    expect(out).toContain("Network access is restricted.");
    // on_request.md heading.
    expect(out).toContain("# Escalation Requests");
    expect(out).not.toContain("{{network_access}}");
  });

  test("acceptEdits mode → on_failure approval + workspace_write sandbox", () => {
    const out = permissionsSection("acceptEdits");
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: acceptEdits");
    expect(out).toContain("`sandbox_mode` is `workspace-write`");
    expect(out).toContain("`approval_policy` is `on-failure`");
    expect(out).toContain("Network access is restricted.");
  });

  test("ordinary bypass keeps the effective workspace sandbox", () => {
    const out = permissionsSection("bypassPermissions");
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: bypassPermissions");
    expect(out).toContain("`sandbox_mode` is `workspace-write`");
    expect(out).toContain("Network access is restricted.");
    expect(out).toContain("Approval policy is currently never");
  });

  // The orchestrator grants a bypass session's require_escalated request
  // without asking. Saying it is rejected made a model give up on opening a
  // page in the browser and start the browser's binary inside the sandbox.
  test("bypass in a workspace-write sandbox says a request to leave it is granted, and for what", () => {
    const out = permissionsSection("bypassPermissions")!;
    expect(out).toContain(APPROVAL_POLICY_BYPASS_ESCALATION.replace(/\n+$/, ""));
    expect(out).not.toContain(APPROVAL_POLICY_NEVER.replace(/\n+$/, ""));
    expect(out).toContain("granted without asking");
    expect(out).toContain("only for a GUI app (open, xdg-open, osascript)");
    expect(out).toContain("network access the sandbox blocks");
    expect(out).toContain("`sandbox_permissions` with the value `\"require_escalated\"`");
    expect(out).toContain("Keep file changes inside the workspace");
    expect(out).toContain("such as starting an app's binary directly");
    // An escalated command skips the shell write guards: the text must not
    // invite escalating writes.
    expect(out).not.toMatch(/write the sandbox forbids/u);
    expect(out).toContain("tool calls are pre-approved");
  });

  test("a bypass worktree child keeps the never text: its escalation stays in the worktree", () => {
    const out = getPermissionsSection(ctxForMode("bypassPermissions"), WORKSPACE_AUTHORITY, { escalationConfined: true })!;
    expect(out).toContain(APPROVAL_POLICY_NEVER.replace(/\n+$/, ""));
    expect(out).not.toContain(APPROVAL_POLICY_BYPASS_ESCALATION.replace(/\n+$/, ""));
  });

  test.each(["read_only", "external_sandbox"] as const)("bypass in a %s sandbox keeps the never text", (sandboxPolicy) => {
    const out = getPermissionsSection(ctxForMode("bypassPermissions"), {
      sandboxPolicy,
      networkSandboxPolicy: { enabled: false },
    })!;
    expect(out).toContain(APPROVAL_POLICY_NEVER.replace(/\n+$/, ""));
    expect(out).not.toContain(APPROVAL_POLICY_BYPASS_ESCALATION.replace(/\n+$/, ""));
  });

  test("combined dangerous authority reports the effective unrestricted sandbox", () => {
    const out = getPermissionsSection(ctxForMode("bypassPermissions"), {
      sandboxPolicy: "danger_full_access",
      networkSandboxPolicy: { enabled: true },
    });
    expect(out).toContain("`sandbox_mode` is `danger-full-access`");
    expect(out).toContain("Network access is enabled.");
    // No sandbox to leave: the never text stays as it was.
    expect(out).toContain(APPROVAL_POLICY_NEVER.replace(/\n+$/, ""));
    expect(out).not.toContain(APPROVAL_POLICY_BYPASS_ESCALATION.replace(/\n+$/, ""));
  });


  test("bypassPermissions mode → appends the autonomy note that waives tool prompts but not care", () => {
    const out = permissionsSection("bypassPermissions");
    expect(out).not.toBeNull();
    expect(out).toContain("tool calls are pre-approved");
    expect(out).toContain(
      "do not pause for confirmation of local, reversible work",
    );
    // The note must not contradict the static "Executing actions with care"
    // section or push the model past the end of a task.
    expect(out).toContain("The rules in 'Executing actions with care' still apply");
    expect(out).toContain("still need the user's explicit request");
    expect(out).toContain("stop and report");
    expect(out).not.toContain("do not stop to wait for the user");
    expect(out).not.toContain("drive the task to completion");
    // Only bypass gets the autonomy note — other modes must not.
    expect(permissionsSection("default")).not.toContain(
      "tool calls are pre-approved",
    );
  });

  test("unsupported permission modes return null (auto, dontAsk, bubble)", () => {
    expect(permissionsSection("auto")).toBeNull();
    expect(permissionsSection("dontAsk")).toBeNull();
    expect(permissionsSection("bubble")).toBeNull();
  });

  test("unattended mode describes allow, deny, and pause behavior", () => {
    const out = getPermissionsSection(
      unattendedCtx(["FileRead", "Grep"], ["system.bash"]),
      WORKSPACE_AUTHORITY,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: unattended");
    expect(out).toContain("Unattended allowlist: FileRead, Grep");
    expect(out).toContain("Unattended denylist: system.bash");
    expect(out).toContain("Any other tool pauses the agent");
  });

  test("unattended mode uses the default policy when context has no policy", () => {
    const out = permissionsSection("unattended");
    expect(out).not.toBeNull();
    expect(out).toContain("Unattended allowlist: (none)");
    expect(out).toContain("Unattended denylist: (none)");
  });

  test("routine read-only policy describes refusals and bounded diagnostics, not interactive approval", () => {
    const context = createEmptyToolPermissionContext({ mode: "unattended",
      unattendedPolicy: { allowlist: [], denylist: [], readOnly: true },
    });
    const out = getPermissionsSection(context, WORKSPACE_AUTHORITY)!;
    expect(out).toContain("Calls that need approval are refused, not paused");
    expect(out).toContain("one bounded native command per call");
    expect(out).toContain("pmset -g batt");
    expect(out).toContain("Never request bypass permissions");
    expect(out).not.toContain("Any other tool pauses the agent");
  });

  test.each(["acceptEdits", "bypassPermissions"] as const)(
    "a %s routine keeps its mode's text and learns that nobody can approve anything",
    (mode) => {
      const context = createEmptyToolPermissionContext({ mode,
        unattendedPolicy: { allowlist: [], denylist: [], readOnly: false, noApprover: true, workspaceRoots: ["/workspace"] },
      });
      const out = getPermissionsSection(context, WORKSPACE_AUTHORITY)!;
      expect(out).toContain(`# Permission Mode: ${permissionsSection(mode)!.split("\n")[0]!.replace("# Permission Mode: ", "")}`);
      expect(out).toContain("nobody attached");
      expect(out).toContain("refused, not paused");
      expect(out).toContain("only inside the routine's workspace");
      expect(out).not.toContain("ask one question with AskUserQuestion");
      expect(permissionsSection(mode)).not.toContain("nobody attached");
      // A routine never leaves its sandbox, whatever its mode.
      expect(out).not.toContain(APPROVAL_POLICY_BYPASS_ESCALATION.replace(/\n+$/, ""));
    },
  );

  test("composition uses a blank line between heading, sandbox, and approval", () => {
    const out = permissionsSection("default");
    expect(out).not.toBeNull();
    // Three blocks joined with "\n\n" → two blank lines total.
    const blanks = out!.match(/\n\n/g);
    expect(blanks).not.toBeNull();
    // Heading-to-sandbox blank + sandbox-to-approval blank, plus any
    // internal blanks in the on_request.md content. We assert the
    // structural ones explicitly:
    expect(out).toMatch(/^# Permission Mode: default\n\nFilesystem sandboxing/);
  });
});
