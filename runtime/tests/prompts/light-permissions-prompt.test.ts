import { describe, expect, test } from "vitest";

import {
  LIGHT_APPROVAL_BYPASS_ESCALATION,
  LIGHT_APPROVAL_ON_REQUEST,
  ROUTINE_NO_APPROVER_NOTE,
  getPermissionsSection,
} from "../../src/prompts/permissions-prompt.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
} from "../../src/permissions/types.js";
import type { SandboxPolicy } from "../../src/session/turn-context.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";

const MODES = [
  ["plan", "unless-trusted"],
  ["default", "on-request"],
  ["acceptEdits", "on-failure"],
  ["bypassPermissions", "never"],
] as const;
const SANDBOXES: readonly [SandboxPolicy, string][] = [
  ["workspace_write", "workspace-write"],
  ["read_only", "read-only"],
  ["danger_full_access", "danger-full-access"],
  ["external_sandbox", "external-sandbox"],
];

function section(mode: PermissionMode, sandboxPolicy: SandboxPolicy, network: boolean, light: boolean): string | null {
  return getPermissionsSection(
    createEmptyToolPermissionContext({ mode }),
    { sandboxPolicy, networkSandboxPolicy: { enabled: network } },
    { light },
  );
}

describe("Light permission section", () => {
  test.each(MODES)("%s states the same mode, sandbox, network and approval policy in fewer words", (mode, approval) => {
    for (const [sandboxPolicy, sandboxName] of SANDBOXES) {
      for (const network of [false, true]) {
        const light = section(mode, sandboxPolicy, network, true)!;
        const canonical = section(mode, sandboxPolicy, network, false)!;
        expect(light.startsWith(`Permission mode: ${mode}. Sandbox ${sandboxName}: `)).toBe(true);
        expect(light).toContain(`Network access is ${network ? "enabled" : "restricted"}.`);
        expect(light).toContain(`Approval policy ${approval}: `);
        expect(canonical).toContain(`\`sandbox_mode\` is \`${sandboxName}\``);
        expect(light.length).toBeLessThan(canonical.length);
      }
    }
  });

  test("workspace-write keeps where commands may write", () => {
    expect(section("acceptEdits", "workspace_write", false, true)).toBe([
      "Permission mode: acceptEdits. Sandbox workspace-write: commands may read files and edit files in cwd and writable_roots; editing files elsewhere requires approval. Network access is restricted.",
      "Approval policy on-failure: commands run in the sandbox; a command that fails there is escalated for user approval to run again without it.",
    ].join("\n"));
  });

  test("on-request keeps how, when and how narrowly to escalate", () => {
    for (const fact of [
      "only when the user approves it or an existing rule allows it",
      "|, &&, ||, ; and subshells",
      "redirection, substitution, environment assignments or wildcards never match a rule",
      "sandbox_permissions \"require_escalated\"",
      "justification as a short question for the user",
      "Do not message the user first.",
      "tests writing to /var",
      "open, xdg-open, osascript",
      "DNS, registry or dependency downloads",
      "rm or git reset that the user did not ask for",
      "Do not work around approvals with other tools.",
      "prefix_rule",
      "[\"npm\", \"run\", \"dev\"]",
      "[\"python3\"]",
      "never for rm or other destructive commands",
      "never for a heredoc or herestring",
    ]) {
      expect(LIGHT_APPROVAL_ON_REQUEST).toContain(fact);
    }
    const light = section("default", "workspace_write", false, true)!;
    const canonical = section("default", "workspace_write", false, false)!;
    expect(light.length).toBeLessThan(canonical.length / 2.5);
  });

  test("bypass keeps the autonomy limits and points at Light's action rules", () => {
    const light = section("bypassPermissions", "danger_full_access", true, true)!;
    expect(light).toContain("do not provide sandbox_permissions; such commands are rejected");
    expect(light).toContain("Tool calls are pre-approved");
    expect(light).toContain("destructive, irreversible, shared-system or externally visible actions need the user's explicit request");
    expect(light).toContain("ask one question with AskUserQuestion");
    expect(light).not.toContain("Executing actions with care");
    expect(section("default", "workspace_write", false, true)).not.toContain("pre-approved");
  });

  // The orchestrator grants a bypass session's require_escalated request
  // without asking. Saying it is rejected made a model give up on opening a
  // page in the browser and start the browser's binary inside the sandbox.
  test("bypass in a workspace-write sandbox says a request to leave it is granted, and for what", () => {
    const light = section("bypassPermissions", "workspace_write", false, true)!;
    expect(light).toContain(LIGHT_APPROVAL_BYPASS_ESCALATION);
    expect(light).toContain("Approval policy never: bypass mode grants a request to leave the sandbox without asking.");
    expect(light).toContain("only for GUI apps (open, xdg-open, osascript) or blocked network");
    expect(light).toContain("sandbox_permissions \"require_escalated\" and a one-line justification");
    expect(light).toContain("Keep file changes inside the workspace");
    expect(light).not.toContain("such commands are rejected");
    expect(light).toContain("Tool calls are pre-approved");
  });

  test.each(["read_only", "danger_full_access", "external_sandbox"] as const)("bypass in a %s sandbox keeps the never text", (sandboxPolicy) => {
    const light = section("bypassPermissions", sandboxPolicy, true, true)!;
    expect(light).toContain("do not provide sandbox_permissions; such commands are rejected");
    expect(light).not.toContain(LIGHT_APPROVAL_BYPASS_ESCALATION);
  });

  test("a bypass worktree child keeps the never text", () => {
    const light = getPermissionsSection(
      createEmptyToolPermissionContext({ mode: "bypassPermissions" }),
      { sandboxPolicy: "workspace_write", networkSandboxPolicy: { enabled: false } },
      { light: true, worktreeConfined: true },
    )!;
    expect(light).toContain("do not provide sandbox_permissions; such commands are rejected");
    expect(light).not.toContain(LIGHT_APPROVAL_BYPASS_ESCALATION);
  });

  test.each(["acceptEdits", "bypassPermissions"] as const)("a %s routine with nobody attached keeps the canonical routine note", (mode) => {
    const context = createEmptyToolPermissionContext({
      mode,
      unattendedPolicy: { allowlist: [], denylist: [], readOnly: false, noApprover: true, workspaceRoots: ["/workspace"] },
    });
    const light = getPermissionsSection(context, { sandboxPolicy: "workspace_write", networkSandboxPolicy: { enabled: false } }, { light: true })!;
    expect(light.endsWith(`\n${ROUTINE_NO_APPROVER_NOTE}`)).toBe(true);
    expect(light).not.toContain("Tool calls are pre-approved");
    // A routine never leaves its sandbox, whatever its mode.
    expect(light).not.toContain(LIGHT_APPROVAL_BYPASS_ESCALATION);
  });

  test("unattended and unsupported modes are unchanged", () => {
    const authority = { sandboxPolicy: "workspace_write" as const, networkSandboxPolicy: { enabled: false } };
    const unattended = createEmptyToolPermissionContext({ mode: "unattended", unattendedPolicy: { allowlist: ["FileRead"], denylist: [] } });
    expect(getPermissionsSection(unattended, authority, { light: true })).toBe(getPermissionsSection(unattended, authority));
    for (const mode of ["auto", "dontAsk", "bubble"] as const) {
      expect(getPermissionsSection(createEmptyToolPermissionContext({ mode }), authority, { light: true })).toBeNull();
    }
  });

  test("Standard sessions keep the canonical texts", () => {
    for (const [mode] of MODES) {
      expect(section(mode, "workspace_write", false, false)).toBe(
        getPermissionsSection(createEmptyToolPermissionContext({ mode }), { sandboxPolicy: "workspace_write", networkSandboxPolicy: { enabled: false } }),
      );
      expect(section(mode, "workspace_write", false, false)).toContain(`# Permission Mode: ${mode}`);
    }
  });

  test("deferred per-request instructions follow the session's Light mode", async () => {
    for (const lightMode of [true, false]) {
      const { session } = mkSession({ services: { runtimeOptions: { ...resolveAgentRuntimeOptions({}), lightMode } } });
      await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(), mode: "default" });
      const context = { ...mkCtx({ permissionMode: "default", baseInstructions: "STABLE_BASE" }), permissionInstructionsDeferred: true };
      const state = buildInitialTurnState(context, { role: "user", content: "Continue." }, { modelInstructions: "STABLE_BASE" });

      const request = buildSamplingRequestContract(state, session, context);

      const expected = getPermissionsSection(
        session.permissionModeRegistry.current(),
        { sandboxPolicy: context.sandboxPolicy.value, networkSandboxPolicy: context.networkSandboxPolicy },
        { light: lightMode },
      );
      expect(request.baseInstructions).toBe(`STABLE_BASE\n\n${expected}`);
      expect(request.baseInstructions.includes("# Escalation Requests")).toBe(!lightMode);
      expect(request.baseInstructions.includes("Permission mode: default.")).toBe(lightMode);
    }
  });
});
