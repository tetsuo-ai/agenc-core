/**
 * `sandbox.autoAllowBashIfSandboxed` for exec_command: a command that will run
 * inside the OS sandbox proceeds without asking, so a headless run with
 * nobody to answer (`agenc -p --light --permission-mode acceptEdits`) can run
 * commands at all. Everything that leaves the sandbox, or that a rule, plan
 * mode or a routine's own policy governs, keeps its old decision.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type ToolEvaluatorContext,
  type ToolLike,
} from "../../src/permissions/evaluator.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { applyUnattendedPermissionPolicyToContext } from "../../src/permissions/unattended-policy.js";
import { buildLiveToolDispatchOptions } from "../../src/phases/execute-tools.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import { createWriteStdinTool } from "../../src/tools/system/write-stdin.js";
import type { SandboxMode } from "../../src/tools/orchestrator.js";
import type { Session } from "../../src/session/session.js";

let workspace = "";
let outside = "";
beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "exec-auto-allow-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "exec-auto-allow-outside-")));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface Setup {
  readonly mode?: PermissionMode;
  /** The dispatch's sandbox mode; null leaves it off the context. */
  readonly sandboxMode?: SandboxMode | null;
  /** `sandbox.autoAllowBashIfSandboxed`; undefined leaves it unset (on). */
  readonly autoAllow?: boolean;
  readonly autoModeActive?: boolean;
  readonly permissions?: Partial<ToolPermissionContext>;
  readonly routineWithoutApprover?: true;
}

function stubSession(setup: Setup): { session: Session; permissions: ToolPermissionContext } {
  let permissions = createEmptyToolPermissionContext({
    mode: setup.mode ?? "acceptEdits",
    ...setup.permissions,
  });
  if (setup.routineWithoutApprover === true) {
    permissions = applyUnattendedPermissionPolicyToContext(
      permissions,
      { noApprover: true, workspaceRoots: [workspace] } as never,
    );
  }
  const config = setup.autoAllow === undefined
    ? {}
    : { sandbox: { autoAllowBashIfSandboxed: setup.autoAllow } };
  const providerService = { environment: () => ({}) };
  const session = {
    conversationId: "exec-auto-allow",
    providerService,
    sessionConfiguration: { cwd: workspace },
    denialTracking: freshDenialTracking(),
    services: {
      providerService,
      configStore: { current: () => config },
      permissionModeRegistry: { current: () => permissions },
      registry: {},
    },
  } as unknown as Session;
  return { session, permissions };
}

function context(setup: Setup = {}): ToolEvaluatorContext {
  const { session, permissions } = stubSession(setup);
  const sandboxMode = setup.sandboxMode === undefined ? "workspace_write" : setup.sandboxMode;
  return attachContextDefaults({
    session,
    ...(sandboxMode !== null ? { sandboxMode } : {}),
    getAppState: () => ({
      toolPermissionContext: permissions,
      denialTracking: session.denialTracking!,
      autoModeActive: setup.autoModeActive ?? permissions.mode === "auto",
    }),
  } as ToolEvaluatorContext);
}

const exec = () =>
  createExecCommandTool({ cwd: workspace, allowedPaths: [workspace] }) as unknown as ToolLike;

async function decide(input: Record<string, unknown>, setup?: Setup, tool: ToolLike = exec()) {
  return hasPermissionsToUseTool(tool, input, context(setup));
}

describe("exec_command sandbox auto-allow", () => {
  it.each(["default", "acceptEdits", "auto", "dontAsk"] as const)(
    "runs a sandboxed command without asking in %s",
    async (mode) => {
      for (const cmd of ["npm install", "touch build.log", "ls"]) {
        const decision = await decide({ cmd }, { mode });
        expect(decision.behavior, cmd).toBe("allow");
        expect(decision.decisionReason, cmd).toMatchObject({
          type: "other",
          reason: expect.stringContaining("sandbox"),
        });
      }
    },
  );

  it("gets the sandbox mode the orchestrator will use on the live dispatch path", async () => {
    for (const [sandboxMode, expected] of [
      ["workspace_write", "allow"],
      ["danger_full_access", "ask"],
    ] as const) {
      const options = buildLiveToolDispatchOptions(
        { approvalPolicy: { value: "on_request" }, sandboxPolicy: { value: sandboxMode } } as never,
        stubSession({}).session,
      );
      expect(options.permissionContext?.sandboxMode).toBe(options.sandboxMode);
      const decision = await options.canUseTool!(exec(), { cmd: "npm install" }, options.permissionContext!);
      expect(decision.behavior, sandboxMode).toBe(expected);
    }
  });

  it("runs a sandboxed command in the read-only sandbox and in a workdir inside the workspace", async () => {
    expect((await decide({ cmd: "git status" }, { sandboxMode: "read_only" })).behavior).toBe("allow");
    expect((await decide({ cmd: "npm test", workdir: workspace })).behavior).toBe("allow");
  });

  it.each<[string, Record<string, unknown>]>([
    ["require_escalated", { cmd: "npm install", sandbox_permissions: "require_escalated", justification: "network" }],
    ["additional write permissions", {
      cmd: "npm install",
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: { file_system: { write: ["/tmp/x"] } },
    }],
    ["additional network", {
      cmd: "npm install",
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: { network: { enabled: true } },
    }],
    ["a detached service", { cmd: "python3 -m http.server", detach: true }],
    ["a TTY session", { cmd: "python3", tty: true }],
  ])("still asks for a call that would not run inside the sandbox (%s)", async (_label, input) => {
    expect((await decide(input)).behavior).toBe("ask");
  });

  it.each<[string, Setup]>([
    ["danger-full-access", { sandboxMode: "danger_full_access" }],
    ["an external sandbox", { sandboxMode: "external_sandbox" }],
    ["no sandbox mode on the dispatch", { sandboxMode: null }],
    ["autoAllowBashIfSandboxed = false", { autoAllow: false }],
  ])("still asks when the command would not run sandboxed or auto-allow is off: %s", async (_label, setup) => {
    expect((await decide({ cmd: "npm install" }, setup)).behavior).toBe("ask");
  });

  it("still asks for a workdir outside the workspace and for a command the safety floor flags", async () => {
    expect((await decide({ cmd: "ls", workdir: outside })).behavior).toBe("ask");
    expect((await decide({ cmd: "rm -rf build" })).behavior).toBe("ask");
  });

  it("keeps an explicit deny rule denying and an explicit ask rule asking", async () => {
    expect((await decide({ cmd: "npm install" }, {
      permissions: { alwaysDenyRules: { session: ["exec_command"] } },
    })).behavior).toBe("deny");
    for (const rule of ["exec_command", "exec_command(npm install:*)", "system.bash(npm:*)"]) {
      const decision = await decide({ cmd: "npm install" }, {
        permissions: { alwaysAskRules: { session: [rule] } },
      });
      expect(decision.behavior, rule).toBe("ask");
    }
    expect((await decide({ cmd: "npm install" }, {
      permissions: { alwaysDenyRules: { session: ["exec_command(rm:*)"] } },
    })).behavior).toBe("ask");
  });

  it("leaves plan mode unchanged, with and without auto mode", async () => {
    expect((await decide({ cmd: "npm install" }, { mode: "plan" })).behavior).toBe("deny");
    expect((await decide({ cmd: "ls" }, { mode: "plan" })).behavior).toBe("ask");
    // Plan with auto keeps its classifier. The classifier re-runs tool checks
    // with the mode set to acceptEdits; that must not auto-allow here.
    const planWithAuto = await decide({ cmd: "touch build.log" }, { mode: "plan", autoModeActive: true });
    expect(planWithAuto.behavior).not.toBe("allow");
  });

  it("leaves a routine with no approver on its own policy", async () => {
    const decision = await decide({ cmd: "npm install" }, { routineWithoutApprover: true });
    expect(decision.behavior).toBe("deny");
    expect("message" in decision ? decision.message : "").toContain("nobody attached");
  });

  it("does not make write_stdin approval-free", async () => {
    const writeStdin = createWriteStdinTool({ cwd: workspace, allowedPaths: [workspace] }) as unknown as ToolLike;
    expect((await decide({ session_id: 1, chars: "" }, {}, writeStdin)).behavior).toBe("ask");
  });
});
