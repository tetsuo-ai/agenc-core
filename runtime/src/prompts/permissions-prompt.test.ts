/**
 * Tests for the permissions/sandbox prompt-injection port.
 *
 * Two layers:
 *   1. Each constant matches the upstream codex `.md` file byte-for-byte.
 *   2. `getPermissionsSection` selects the right pair, substitutes the
 *      `{{network_access}}` placeholder, and composes the section in
 *      codex's order (sandbox-then-approval).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const CODEX_PROMPTS_DIR =
  "/home/tetsuo/git/codex/codex-rs/core/src/context/prompts/permissions";

function readCodexFile(rel: string): string {
  return readFileSync(join(CODEX_PROMPTS_DIR, rel), "utf8");
}

function ctxForMode(mode: PermissionMode): ToolPermissionContext {
  return createEmptyToolPermissionContext({ mode });
}

describe("approval-policy constants are byte-for-byte identical to upstream", () => {
  test("never.md", () => {
    expect(APPROVAL_POLICY_NEVER).toBe(readCodexFile("approval_policy/never.md"));
  });

  test("unless_trusted.md (note the leading space)", () => {
    expect(APPROVAL_POLICY_UNLESS_TRUSTED).toBe(
      readCodexFile("approval_policy/unless_trusted.md"),
    );
  });

  test("on_failure.md", () => {
    expect(APPROVAL_POLICY_ON_FAILURE).toBe(
      readCodexFile("approval_policy/on_failure.md"),
    );
  });

  test("on_request.md", () => {
    expect(APPROVAL_POLICY_ON_REQUEST).toBe(
      readCodexFile("approval_policy/on_request.md"),
    );
  });

  test("on_request_rule_request_permission.md", () => {
    expect(APPROVAL_POLICY_ON_REQUEST_RULE_REQUEST_PERMISSION).toBe(
      readCodexFile("approval_policy/on_request_rule_request_permission.md"),
    );
  });
});

describe("sandbox-mode constants are byte-for-byte identical to upstream", () => {
  test("danger_full_access.md", () => {
    expect(SANDBOX_MODE_DANGER_FULL_ACCESS).toBe(
      readCodexFile("sandbox_mode/danger_full_access.md"),
    );
  });

  test("workspace_write.md", () => {
    expect(SANDBOX_MODE_WORKSPACE_WRITE).toBe(
      readCodexFile("sandbox_mode/workspace_write.md"),
    );
  });

  test("read_only.md", () => {
    expect(SANDBOX_MODE_READ_ONLY).toBe(
      readCodexFile("sandbox_mode/read_only.md"),
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
    // Sandbox first (codex order). Trailing newline of the .md is stripped.
    expect(out).toContain(
      "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted.",
    );
    // Then approval (verbatim, leading space preserved).
    expect(out).toContain(
      " Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `unless-trusted`",
    );
    // Placeholder is fully substituted.
    expect(out).not.toContain("{{network_access}}");
    // Sandbox precedes approval (codex composition order).
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

  test("modes without a codex analog return null (auto, dontAsk, bubble)", () => {
    expect(getPermissionsSection(ctxForMode("auto"))).toBeNull();
    expect(getPermissionsSection(ctxForMode("dontAsk"))).toBeNull();
    expect(getPermissionsSection(ctxForMode("bubble"))).toBeNull();
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
