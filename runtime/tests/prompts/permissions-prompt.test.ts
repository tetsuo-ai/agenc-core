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
  APPROVAL_POLICY_NEVER,
  APPROVAL_POLICY_ON_FAILURE,
  APPROVAL_POLICY_ON_REQUEST,
  APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION,
  APPROVAL_POLICY_UNLESS_TRUSTED,
  SANDBOX_MODE_DANGER_FULL_ACCESS,
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
});

describe("getPermissionsSection", () => {
  test("returns null when ctx is null", () => {
    expect(getPermissionsSection(null)).toBeNull();
  });

  test("plan mode → unless_trusted approval + read_only sandbox (restricted network)", () => {
    const out = getPermissionsSection(ctxForMode("plan"));
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
    const out = getPermissionsSection(ctxForMode("default"));
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: default");
    expect(out).toContain("`sandbox_mode` is `workspace-write`");
    expect(out).toContain("Network access is restricted.");
    // on_request.md heading.
    expect(out).toContain("# Escalation Requests");
    expect(out).not.toContain("{{network_access}}");
  });

  test("acceptEdits mode → on_failure approval + workspace_write sandbox", () => {
    const out = getPermissionsSection(ctxForMode("acceptEdits"));
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: acceptEdits");
    expect(out).toContain("`sandbox_mode` is `workspace-write`");
    expect(out).toContain("`approval_policy` is `on-failure`");
    expect(out).toContain("Network access is restricted.");
  });

  test("bypassPermissions mode → never approval + danger_full_access sandbox (network enabled)", () => {
    const out = getPermissionsSection(ctxForMode("bypassPermissions"));
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: bypassPermissions");
    expect(out).toContain("`sandbox_mode` is `danger-full-access`");
    expect(out).toContain("Network access is enabled.");
    expect(out).toContain("Approval policy is currently never");
  });

  test("bypassPermissions mode → appends the autonomy note so the agent does not pause for approval", () => {
    const out = getPermissionsSection(ctxForMode("bypassPermissions"));
    expect(out).not.toBeNull();
    expect(out).toContain("pre-authorized every action");
    expect(out).toContain("do not pause to ask for confirmation");
    // Only bypass gets the autonomy note — other modes must not.
    expect(getPermissionsSection(ctxForMode("default"))).not.toContain(
      "pre-authorized every action",
    );
  });

  test("unsupported permission modes return null (auto, dontAsk, bubble)", () => {
    expect(getPermissionsSection(ctxForMode("auto"))).toBeNull();
    expect(getPermissionsSection(ctxForMode("dontAsk"))).toBeNull();
    expect(getPermissionsSection(ctxForMode("bubble"))).toBeNull();
  });

  test("unattended mode describes allow, deny, and pause behavior", () => {
    const out = getPermissionsSection(
      unattendedCtx(["FileRead", "Grep"], ["system.bash"]),
    );
    expect(out).not.toBeNull();
    expect(out).toContain("# Permission Mode: unattended");
    expect(out).toContain("Unattended allowlist: FileRead, Grep");
    expect(out).toContain("Unattended denylist: system.bash");
    expect(out).toContain("Any other tool pauses the agent");
  });

  test("unattended mode uses the default policy when context has no policy", () => {
    const out = getPermissionsSection(ctxForMode("unattended"));
    expect(out).not.toBeNull();
    expect(out).toContain("Unattended allowlist: (none)");
    expect(out).toContain("Unattended denylist: (none)");
  });

  test("composition uses a blank line between heading, sandbox, and approval", () => {
    const out = getPermissionsSection(ctxForMode("default"));
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
