/**
 * A sandbox notice that tells the model to retry with sandbox_permissions must
 * be actionable: the next request presents that field (Light and deferred
 * standard sessions otherwise send a lean exec_command without it), the notice
 * offers only a retry the session can grant, in that session's words, and the
 * mode's system text allows what the notice asks for.
 *
 * Live failure (round4 job oa, gpt-6-luna, bypassPermissions, default sandbox):
 * asked to commit on a new branch, the model got "retry once with
 * sandbox_permissions=require_escalated ... choose approve once" while its
 * exec_command schema had only cmd/workdir/timeoutMs and its system text said
 * to leave the sandbox only for GUI apps or blocked network. It retried the
 * same command without the field, then gave up.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildToolRegistry, type ToolRegistry } from "../../../src/tool-registry.js";
import {
  buildFilteredRegistry,
  TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
} from "../../../src/agents/run-agent.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../../src/unified-exec/types.js";
import {
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
  sandboxEscalationGrant,
  SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING,
} from "../../../src/tools/system/exec-sandbox-denial.js";
import {
  LIGHT_APPROVAL_BYPASS_ESCALATION,
  LIGHT_APPROVAL_NEVER,
  ROUTINE_NO_APPROVER_NOTE,
} from "../../../src/prompts/permissions-prompt.js";
import { getSessionPermissionInstructions } from "../../../src/session/permission-instructions.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
} from "../../../src/permissions/types.js";
import type { SandboxPolicy } from "../../../src/session/turn-context.js";
import { mkCtx } from "../../fixtures.js";

const GIT_DENIED =
  "fatal: cannot lock ref 'refs/heads/chore/comet-docs': unable to create directory for .git/refs/heads/chore/comet-docs";
const CONFIG_DENIED = "error: could not lock config file .git/config: Read-only file system";
const BIND_DENIED = "Error: listen EPERM: operation not permitted 0.0.0.0:8080";
const DNS_FAILED = "npm error getaddrinfo EAI_AGAIN registry.npmjs.org";

function execOutput(output: string, exitCode: number): ExecCommandToolOutput {
  return {
    output,
    stdout: "",
    stderr: output,
    exitCode,
    exit_code: exitCode,
    durationMs: 12,
    wall_time_seconds: 0.012,
    timedOut: false,
    truncated: false,
    original_token_count: 3,
  };
}

function mockManager(output: ExecCommandToolOutput): UnifiedExecProcessManagerLike {
  return {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => output),
    writeStdin: vi.fn(async () => output),
    closeAll: vi.fn(async () => {}),
  };
}

const fieldsOf = (registry: ToolRegistry, name = "exec_command"): string[] =>
  Object.keys(registry.toLLMTools().find((tool) => tool.function.name === name)!.function.parameters.properties as object).sort();

describe("the next request presents the escalation fields a notice asks for", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-exec-escalation-"));
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  /** A model call's arguments as the dispatcher passes them: a session in `mode` under the OS sandbox. */
  function callArgs(
    raw: Record<string, unknown>,
    options: {
      readonly mode: string;
      readonly approvalPolicy: string;
      readonly sandboxMode?: string;
      readonly toolName?: string;
      readonly services?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    const args: Record<string, unknown> = { ...raw };
    const sandboxMode = options.sandboxMode ?? "workspace_write";
    attachToolRuntimeContext(args, {
      callId: "call-escalation",
      toolName: options.toolName ?? "exec_command",
      runtimeKind: "function",
      classification: "exclusive",
      supportsParallelToolCalls: false,
      source: { type: "model" },
      submittedAtMs: 0,
      approvalPolicy: options.approvalPolicy,
      requestedSandboxMode: sandboxMode,
      sandboxMode,
      approvalResolved: true,
      rawArgs: "{}",
      invocation: {
        session: {
          permissionModeRegistry: { current: () => ({ mode: options.mode, additionalWorkingDirectories: new Map() }) },
          services: { runtimeOptions: { sessionTempRoot: root }, ...options.services },
        },
        payload: { kind: "function", arguments: "{}" },
        turn: { subId: "turn-escalation", cwd: root, agencLinuxSandboxExe: "/bin/true" },
      },
    } as never);
    return args;
  }

  const bypass = { mode: "bypassPermissions", approvalPolicy: "never" } as const;
  const attended = { mode: "default", approvalPolicy: "on_request" } as const;

  test.each([
    ["Light", { lightMode: true }],
    ["standard with the default deferral", { deferRareTools: true }],
  ] as const)("%s: a git refusal in a bypass session loads sandbox_permissions and justification", async (_label, shape) => {
    const registry = buildToolRegistry({
      workspaceRoot: root, requireAdmission: false, unifiedExecManager: mockManager(execOutput(GIT_DENIED, 128)), ...shape,
    });
    expect(fieldsOf(registry)).toEqual(["cmd", "timeoutMs", "workdir"]);
    const exec = registry.tools.find((tool) => tool.name === "exec_command")!;
    const result = await exec.execute(callArgs({ cmd: "git switch -c chore/comet-docs && git commit -m docs" }, bypass));
    expect(fieldsOf(registry)).toEqual(expect.arrayContaining(["cmd", "justification", "sandbox_permissions"]));
    expect(result.content).toContain("runs outside the sandbox without asking");
    expect(result.content).toContain(SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING);
  });

  test("a git refusal hidden by a pipe to tail still explains itself and loads the fields", async () => {
    const registry = buildToolRegistry({
      workspaceRoot: root, lightMode: true, requireAdmission: false,
      unifiedExecManager: mockManager(execOutput("error: could not write config file .git/config: Device or resource busy", 0)),
    });
    const exec = registry.tools.find((tool) => tool.name === "exec_command")!;
    const result = await exec.execute(callArgs({ cmd: "git config user.email dev@comet.example 2>&1 | tail -5" }, bypass));
    expect(fieldsOf(registry)).toContain("sandbox_permissions");
    expect(result.content).toContain(SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING);
  });

  test("an attended session's card retry, a config refusal and a blocked lookup load the fields too", async () => {
    for (const [output, options] of [
      [execOutput(GIT_DENIED, 128), attended],
      [execOutput(CONFIG_DENIED, 255), bypass],
      [execOutput(DNS_FAILED, 1), bypass],
      [execOutput(BIND_DENIED, 1), attended],
    ] as const) {
      const registry = buildToolRegistry({
        workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: mockManager(output),
      });
      const exec = registry.tools.find((tool) => tool.name === "exec_command")!;
      const result = await exec.execute(callArgs({ cmd: "run it" }, options));
      expect(result.content, output.output).toContain('sandbox_permissions="require_escalated"');
      expect(fieldsOf(registry), output.output).toContain("sandbox_permissions");
    }
  });

  test("a notice that offers no retry, a plain failure or an unsandboxed run keeps the lean schema", async () => {
    for (const [output, options] of [
      // A routine never leaves its sandbox: the notice says so and asks for nothing.
      [execOutput(GIT_DENIED, 128), { ...attended, services: { runtimeOptions: { sessionTempRoot: "/tmp", routineRun: true } } }],
      // A never policy outside bypass: nobody can grant the retry.
      [execOutput(GIT_DENIED, 128), { mode: "default", approvalPolicy: "never" }],
      // A print run denies every approval request.
      [execOutput(DNS_FAILED, 1), { ...attended, services: { runtimeOptions: { sessionTempRoot: "/tmp", nonInteractive: true } } }],
      [execOutput("npm ERR! missing script: start", 1), bypass],
      [execOutput(GIT_DENIED, 128), { ...bypass, sandboxMode: "danger_full_access" }],
    ] as const) {
      const registry = buildToolRegistry({
        workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: mockManager(output),
      });
      const exec = registry.tools.find((tool) => tool.name === "exec_command")!;
      const result = await exec.execute(callArgs({ cmd: "run it" }, options));
      expect(result.content).not.toContain('sandbox_permissions="require_escalated"');
      expect(fieldsOf(registry), JSON.stringify(options)).toEqual(["cmd", "timeoutMs", "workdir"]);
    }
  });

  // A refused bind read through write_stdin is retried by relaunching the
  // session's command, so exec_command is the tool that needs the field.
  test("a write_stdin poll that reports a refused bind loads exec_command's fields", async () => {
    const registry = buildToolRegistry({
      workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: mockManager(execOutput(BIND_DENIED, 1)),
    });
    const poll = registry.tools.find((tool) => tool.name === "write_stdin")!;
    const result = await poll.execute(callArgs({ session_id: 7, chars: "" }, { ...bypass, toolName: "write_stdin" }));
    expect(result.content).toContain("runs outside the sandbox without asking");
    expect(fieldsOf(registry)).toContain("sandbox_permissions");
  });

  // A Light child presents its own discoveries: its notice loads the field
  // for that child, and the parent's request stays lean.
  test("a Light child's notice loads the fields in that child only", async () => {
    const parent = buildToolRegistry({
      workspaceRoot: root, lightMode: true, requireAdmission: false, unifiedExecManager: mockManager(execOutput(GIT_DENIED, 128)),
    });
    const child = buildFilteredRegistry(parent, {
      childConversationId: "child",
      lightMode: true,
      unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
    });
    expect(fieldsOf(child)).toEqual(["cmd", "timeoutMs", "workdir"]);
    const exec = child.tools.find((tool) => tool.name === "exec_command")!;
    const result = await exec.execute(callArgs({ cmd: "git switch -c chore/comet-docs" }, bypass));
    expect(fieldsOf(child)).toContain("sandbox_permissions");
    expect(fieldsOf(parent)).toEqual(["cmd", "timeoutMs", "workdir"]);
    expect(result.content).toContain(SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING);
  });
});

// The notice reads how the session grants a retry (sandboxEscalationGrant);
// the prompt reads the permission mode, the sandbox and the session. For
// every combination they must say the same thing.
describe("the mode's system text and the notices agree", () => {
  const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
  const SANDBOXES: readonly SandboxPolicy[] = ["workspace_write", "read_only"];
  const SESSIONS = [
    ["an attended Light session", { runtimeOptions: { lightMode: true } }, false],
    ["an attended standard session", { runtimeOptions: {}, registry: { compactPresentation: true } }, false],
    ["a Light print run", { runtimeOptions: { lightMode: true, nonInteractive: true } }, false],
    ["a scheduled routine", { runtimeOptions: { lightMode: true, routineRun: true } }, true],
    ["a worktree child", { runtimeOptions: { lightMode: true }, sandboxExecutionBroker: { worktreeConfinement: { worktree: "/w", checkout: "/c" } } }, false],
    ["a read-only delegation child", { runtimeOptions: { lightMode: true }, readOnlyDelegation: { deniedRules: [] } }, false],
  ] as const;

  test.each(SESSIONS)("%s", (_label, services, routine) => {
    for (const mode of MODES) {
      for (const sandboxPolicy of SANDBOXES) {
        const permissionContext = createEmptyToolPermissionContext({
          mode,
          ...(routine
            ? { unattendedPolicy: { allowlist: [], denylist: [], readOnly: false, noApprover: true, workspaceRoots: ["/workspace"] } }
            : {}),
        });
        const session = {
          permissionModeRegistry: { current: () => permissionContext },
          services,
        };
        const ctx = { ...mkCtx({ sandboxPolicy: { value: sandboxPolicy } } as never), permissionInstructionsDeferred: true };
        const text = getSessionPermissionInstructions(session as never, ctx, permissionContext);
        // The orchestrator's policy for these modes with the default configuration.
        const policy = mode === "bypassPermissions" ? "never" : "on_request";
        const label = `${mode} ${sandboxPolicy}`;
        // Text that says such requests are rejected, or that nobody can
        // approve, never meets a notice that offers a retry.
        const nobodyGrants = text.includes(LIGHT_APPROVAL_NEVER) || text.includes("No approver") ||
          text.includes(ROUTINE_NO_APPROVER_NOTE);
        if (nobodyGrants) {
          expect(sandboxEscalationAvailable(policy, { sandboxMode: sandboxPolicy, session }), label).toBe(false);
        }
        const grant = sandboxEscalationGrant(policy, { sandboxMode: sandboxPolicy, session });
        const git = execSandboxDenialNotice({
          output: GIT_DENIED, exitCode: 128, sandboxApplied: true, escalation: grant, session,
        })!;

        // The bypass text and a retry granted without a card go together, and
        // that text allows the retry the git notice asks for.
        expect(text.includes(LIGHT_APPROVAL_BYPASS_ESCALATION), label).toBe(grant === "without_asking");
        if (grant === "without_asking") {
          expect(text, label).toContain("refused on a protected path such as .git");
          expect(git.notice, label).toBe(SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING);
        }
        if (nobodyGrants) expect(grant, label).toBe("unavailable");
        // A notice that offers a card retry meets a mode whose text has a
        // person approve escalations.
        if (grant === "with_approval") {
          expect(text, label).toMatch(/approval|approves/u);
          expect(text, label).not.toContain(LIGHT_APPROVAL_NEVER);
        }
        if (grant === "unavailable") {
          expect(git.advisesEscalation, label).toBe(false);
          expect(git.notice, label).not.toContain("require_escalated");
        }
      }
    }
  });
});
