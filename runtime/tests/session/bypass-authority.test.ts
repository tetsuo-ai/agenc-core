import { describe, expect, test } from "vitest";

import { resolveStartupSandboxBypass } from "../../src/bin/bypass-approvals.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { createEmptyToolPermissionContext, type PermissionMode } from "../../src/permissions/types.js";
import { getPermissionsSection } from "../../src/prompts/permissions-prompt.js";
import type { SandboxExecutionStatus } from "../../src/sandbox/execution-broker.js";
import {
  executionAuthorityForPermissionContext,
  permissionContextUsesBypassAuthority,
  type SessionExecutionAuthority,
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionExecutionAuthorityFromAgenCConfig,
} from "../../src/session/configuration.js";
import { sandboxModeRequiresPlatformIsolation } from "../../src/tools/runtimes/sandboxing.js";

const CONFIGURED: SessionExecutionAuthority = Object.freeze({
  approvalPolicy: Object.freeze({ value: "on_request" as const }),
  sandboxPolicy: Object.freeze({ value: "workspace_write" as const }),
  fileSystemSandboxPolicy: Object.freeze({
    allowWrite: Object.freeze(["/workspace"]),
    denyWrite: Object.freeze([]),
    allowRead: Object.freeze([]),
    denyRead: Object.freeze([]),
  }),
  networkSandboxPolicy: Object.freeze({
    allowlist: Object.freeze([]),
    denylist: Object.freeze([]),
    allowManagedDomainsOnly: false,
  }),
  windowsSandboxLevel: "none",
  sandboxAllowGpu: false,
});

describe("permissionContextUsesBypassAuthority", () => {
  test("is true for live bypass and for plan that stashed bypass", () => {
    expect(
      permissionContextUsesBypassAuthority({ mode: "bypassPermissions" }),
    ).toBe(true);
    expect(
      permissionContextUsesBypassAuthority({
        mode: "plan",
        prePlanMode: "bypassPermissions",
      }),
    ).toBe(true);
  });

  test("is false for plan without a bypass stash and for ordinary modes", () => {
    expect(
      permissionContextUsesBypassAuthority({
        mode: "plan",
        prePlanMode: "acceptEdits",
      }),
    ).toBe(false);
    expect(permissionContextUsesBypassAuthority({ mode: "plan" })).toBe(false);
    expect(permissionContextUsesBypassAuthority({ mode: "default" })).toBe(
      false,
    );
    expect(
      permissionContextUsesBypassAuthority({
        mode: "acceptEdits",
        prePlanMode: "bypassPermissions",
      }),
    ).toBe(false);
  });
});

describe("executionAuthorityForPermissionContext plan+bypass stash", () => {
  test("suppresses approvals while planning after a bypass stash without widening the sandbox", () => {
    const projected = executionAuthorityForPermissionContext(CONFIGURED, {
      mode: "plan",
      prePlanMode: "bypassPermissions",
    });

    expect(projected.approvalPolicy.value).toBe("never");
    expect(projected.sandboxPolicy.value).toBe("workspace_write");
    expect(projected.fileSystemSandboxPolicy.allowWrite).toEqual(["/workspace"]);
  });

  test("keeps on-request approvals when plan stashed a non-bypass mode", () => {
    const projected = executionAuthorityForPermissionContext(CONFIGURED, {
      mode: "plan",
      prePlanMode: "acceptEdits",
    });

    expect(projected.approvalPolicy.value).toBe("on_request");
    expect(projected.sandboxPolicy.value).toBe("workspace_write");
  });
});


test("persistent sandbox opt-out survives permission authority projection", () => {
  const authority = executionAuthorityForPermissionContext({ ...CONFIGURED, sandboxPersistentSession: false }, {
    mode: "default",
  });
  expect(authority.sandboxPersistentSession).toBe(false);
  expect(sandboxExecutionBrokerAuthorityFromSessionAuthority(authority, "/workspace").persistentSession).toBe(false);
});

test("default and explicit persistent sessions omit the broker opt-out flag", () => {
  const omitted = sandboxExecutionBrokerAuthorityFromSessionAuthority(
    CONFIGURED,
    "/workspace",
  );
  expect(omitted).not.toHaveProperty("persistentSession");

  const enabled = sandboxExecutionBrokerAuthorityFromSessionAuthority(
    { ...CONFIGURED, sandboxPersistentSession: true },
    "/workspace",
  );
  expect(enabled).not.toHaveProperty("persistentSession");
});

// The permission text must state the network the commands really get. Each case
// takes the startup path of a real run (flag resolution with a host probe, the
// configured baseline, the mode projection); whether the network is blocked comes
// from the sandbox broker's own authority, since only a mode that runs commands
// under the platform sandbox can block it.
describe("the permission text states the network the sandbox leaves to commands", () => {
  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly platform: NodeJS.Platform;
    readonly host: SandboxExecutionStatus["kind"];
    readonly flags: { readonly bypassApprovals?: true; readonly dangerouslyBypassApprovalsAndSandbox?: true };
    readonly mode: PermissionMode;
    readonly config?: AgenCConfig;
    readonly network: "enabled" | "restricted";
  }> = [
    { name: "macOS Seatbelt, --bypass-approvals", platform: "darwin", host: "ready", flags: { bypassApprovals: true }, mode: "bypassPermissions", network: "restricted" },
    { name: "Linux bubblewrap or Landlock, --bypass-approvals", platform: "linux", host: "ready", flags: { bypassApprovals: true }, mode: "bypassPermissions", network: "restricted" },
    { name: "Linux with no sandbox, --bypass-approvals", platform: "linux", host: "unavailable", flags: { bypassApprovals: true }, mode: "bypassPermissions", network: "enabled" },
    { name: "Windows, --bypass-approvals", platform: "win32", host: "unavailable", flags: { bypassApprovals: true }, mode: "bypassPermissions", network: "enabled" },
    { name: "--dangerously-bypass-approvals-and-sandbox, as Terminal-Bench runs", platform: "linux", host: "ready", flags: { dangerouslyBypassApprovalsAndSandbox: true }, mode: "bypassPermissions", network: "enabled" },
    { name: "asks first in the macOS sandbox", platform: "darwin", host: "ready", flags: {}, mode: "default", network: "restricted" },
    { name: "asks first on Windows after the no-sandbox card", platform: "win32", host: "unavailable", flags: {}, mode: "default", config: { sandbox_mode: "danger-full-access" }, network: "enabled" },
    { name: "danger-full-access with network_access off", platform: "linux", host: "ready", flags: {}, mode: "acceptEdits", config: { sandbox_mode: "danger-full-access", sandbox: { network_access: false } }, network: "enabled" },
    { name: "workspace-write with network_access on", platform: "darwin", host: "ready", flags: {}, mode: "default", config: { sandbox: { network_access: true } }, network: "enabled" },
  ];

  test.each(CASES)("$name", ({ platform, host, flags, mode, config, network }) => {
    const probe = (): SandboxExecutionStatus => ({ kind: host, mode: "workspace_write", platform });
    const startup = resolveStartupSandboxBypass(flags, { cwd: "/workspace", env: {}, platform, probe });
    const authority = executionAuthorityForPermissionContext(
      sessionExecutionAuthorityFromAgenCConfig({ config: config ?? {}, workspaceRoot: "/workspace" }),
      { mode },
      startup.dangerouslyBypassApprovalsAndSandbox,
    );
    const broker = sandboxExecutionBrokerAuthorityFromSessionAuthority(authority, "/workspace");
    expect(broker.permissionProfile).toBeDefined();
    expect(sandboxModeRequiresPlatformIsolation(broker.mode) && broker.permissionProfile?.network !== "enabled")
      .toBe(network === "restricted");

    const ctx = createEmptyToolPermissionContext({ mode });
    const prompt = { sandboxPolicy: authority.sandboxPolicy.value, networkSandboxPolicy: authority.networkSandboxPolicy };
    for (const options of [{}, { light: true }, { compact: true }]) {
      expect(getPermissionsSection(ctx, prompt, options)).toContain(`Network access is ${network}.`);
    }
    expect(getPermissionsSection(ctx, prompt, { light: true, lightPrint: true })).toContain(`; network ${network}.`);
  });
});
