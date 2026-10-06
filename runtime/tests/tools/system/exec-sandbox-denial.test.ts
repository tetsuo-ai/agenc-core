import { describe, expect, test } from "vitest";

import {
  bypassGrantsSandboxEscalation,
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
  SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE,
  SANDBOX_BIND_DENIED_NO_ESCALATION,
  worktreeWriteDenialNotice,
} from "../../../src/tools/system/exec-sandbox-denial.js";

// The body the live incident produced 21 times (session conv-mtjdmlfc,
// 2026-09-02). Nothing in it says the sandbox is responsible, so the model
// kept retrying with a longer timeout for 412 seconds.
const NODE_BIND_DENIED =
  "\n> start\n> node server.js\n\nnode:events:505\n      throw er;\n" +
  "Error: listen EPERM: operation not permitted 0.0.0.0:8080\n" +
  "    at Server.listen (node:net:2558:7)\n\n" +
  "[exec exit_code=1 wall_time=0.2630s tokens=212]";

const denial = (overrides: Partial<Parameters<typeof execSandboxDenialNotice>[0]> = {}) =>
  execSandboxDenialNotice({
    output: NODE_BIND_DENIED,
    exitCode: 1,
    sandboxApplied: true,
    escalationAvailable: false,
    ...overrides,
  });

describe("execSandboxDenialNotice", () => {
  test("names the sandbox and forbids the retry when nobody can approve", () => {
    const result = denial();
    expect(result?.kind).toBe("network_bind");
    expect(result?.notice).toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
    expect(result?.notice).toContain("Do not run this command again");
    // It must not send the model to ask a human who is not there.
    expect(result?.notice).not.toContain("require_escalated");
  });

  test("asks for exactly one escalated retry when a human can still approve", () => {
    const result = denial({ escalationAvailable: true });
    expect(result?.notice).toBe(SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE);
    expect(result?.notice).toContain("require_escalated");
    expect(result?.notice).toContain("once more");
  });

  test("recognizes the phrasings other runtimes use", () => {
    for (const output of [
      "listen tcp 0.0.0.0:8080: bind: permission denied",
      "OSError: [Errno 1] Operation not permitted: bind",
      "thread 'main' panicked: Os { code: 1, kind: PermissionDenied, message: \"Operation not permitted\" } binding 0.0.0.0:3000",
    ]) {
      expect(denial({ output })?.kind).toBe("network_bind");
    }
  });

  test("stays silent when the sandbox did not cause it", () => {
    // Nothing was sandboxed: the same errno then means the OS refused for its
    // own reasons (a privileged port, an address in use), and blaming the
    // sandbox would send the model down the wrong path.
    expect(denial({ sandboxApplied: false })).toBeNull();
    // The command succeeded.
    expect(denial({ exitCode: 0 })).toBeNull();
    // A permission error that has nothing to do with a socket.
    expect(denial({ output: "chmod: /etc/hosts: EPERM: operation not permitted" })).toBeNull();
    // A port conflict is the user's to fix, not the sandbox's.
    expect(denial({ output: "Error: listen EADDRINUSE: address already in use 0.0.0.0:8080" })).toBeNull();
  });

  test("the notice is constant, so a repeated denial keeps one failure signature", () => {
    // The repeated-failure guard compares failure signatures; a notice
    // carrying a timing or a port would defeat the guard that catches a model
    // which retries anyway.
    const first = denial({ output: NODE_BIND_DENIED })?.notice;
    const second = denial({
      output: NODE_BIND_DENIED.replace("0.2630", "9.9999").replace("8080", "3000"),
    })?.notice;
    expect(first).toBe(second);
  });
});

describe("sandboxEscalationAvailable", () => {
  test("only the never policy states that nobody is present to approve", () => {
    expect(sandboxEscalationAvailable("never")).toBe(false);
    for (const policy of ["on_request", "on_failure", "untrusted", "granular"]) {
      expect(sandboxEscalationAvailable(policy)).toBe(true);
    }
  });

  const sessionIn = (
    mode: string,
    services: Record<string, unknown> = {},
  ) => ({
    permissionModeRegistry: { current: () => ({ mode }) },
    services: { runtimeOptions: { routineRun: false }, ...services },
  });
  const workspaceWrite = (session: unknown) => ({ sandboxMode: "workspace_write", session });

  // Bypass runs under the never policy, but the orchestrator grants its
  // escalation request without asking, and the prompt says so for a
  // workspace-write sandbox, so a denial there is not a dead end.
  test("a bypass session in a workspace-write sandbox can still leave it", () => {
    expect(sandboxEscalationAvailable("never", workspaceWrite(sessionIn("bypassPermissions")))).toBe(true);
    expect(bypassGrantsSandboxEscalation(sessionIn("bypassPermissions"))).toBe(true);
    expect(denial({
      escalationAvailable: sandboxEscalationAvailable("never", workspaceWrite(sessionIn("bypassPermissions"))),
    })?.notice).toBe(SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE);
  });

  test("the never verdict stays wherever the prompt does not offer escalation", () => {
    const bypass = sessionIn("bypassPermissions");
    // Other sandboxes: the prompt keeps the never text there.
    for (const sandboxMode of ["read_only", "danger_full_access", undefined]) {
      expect(sandboxEscalationAvailable("never", { sandboxMode, session: bypass })).toBe(false);
    }
    // A routine never leaves its sandbox.
    expect(sandboxEscalationAvailable("never", workspaceWrite(
      sessionIn("bypassPermissions", { runtimeOptions: { routineRun: true } }),
    ))).toBe(false);
    // A worktree child's escalated command stays in its worktree.
    expect(sandboxEscalationAvailable("never", workspaceWrite(
      sessionIn("bypassPermissions", { sandboxExecutionBroker: { worktreeConfinement: { worktree: "/w", checkout: "/c" } } }),
    ))).toBe(false);
    // A read-only delegation child refuses require_escalated outright.
    expect(sandboxEscalationAvailable("never", workspaceWrite(
      sessionIn("bypassPermissions", { readOnlyDelegation: { deniedRules: [] } }),
    ))).toBe(false);
    // A Light print run's prompt tells the model not to escalate.
    expect(sandboxEscalationAvailable("never", workspaceWrite(
      sessionIn("bypassPermissions", { runtimeOptions: { lightMode: true, nonInteractive: true } }),
    ))).toBe(false);
    // Other modes, and no session at all.
    for (const mode of ["default", "acceptEdits", "plan"]) {
      expect(sandboxEscalationAvailable("never", workspaceWrite(sessionIn(mode)))).toBe(false);
    }
    expect(sandboxEscalationAvailable("never", workspaceWrite(undefined))).toBe(false);
    expect(sandboxEscalationAvailable("never")).toBe(false);
    expect(bypassGrantsSandboxEscalation(null)).toBe(false);
  });
});

// A worktree child's commands write inside its worktree only, escalated or
// not. The model's next move after a refused write is an escalated retry.
describe("worktreeWriteDenialNotice", () => {
  const worktree = "/repo/.agenc-worktrees/m5-run";

  test("names the worktree and says an escalated retry fails the same way", () => {
    for (const output of [
      "sh: ../../src/a.js: Operation not permitted",
      "touch: cannot touch '/repo/src/a.js': Read-only file system",
      "Error: EPERM: operation not permitted, open '/repo/src/a.js'",
    ]) {
      const notice = worktreeWriteDenialNotice({ output, exitCode: 1, worktree });
      expect(notice, output).toContain(`This agent works in its own git worktree (${worktree})`);
      expect(notice, output).toContain("with or without sandbox_permissions");
    }
  });

  test("says nothing for a success or for another failure", () => {
    expect(worktreeWriteDenialNotice({ output: "Operation not permitted", exitCode: 0, worktree })).toBeNull();
    expect(worktreeWriteDenialNotice({ output: "npm error Missing script: test", exitCode: 1, worktree })).toBeNull();
  });
});
