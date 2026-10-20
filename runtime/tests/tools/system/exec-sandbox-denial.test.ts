import { describe, expect, test } from "vitest";
import { PYTHON_SERVER_BIND_DENIED, PYTHON_SERVER_SOCKET_DENIED } from "../../helpers/python-server-denial.js";

import {
  bypassGrantsSandboxEscalation,
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
  sandboxEscalationGrant,
  SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE,
  SANDBOX_BIND_DENIED_NO_ESCALATION,
  SANDBOX_BIND_DENIED_WITHOUT_ASKING,
  SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE,
  SANDBOX_GIT_WRITE_DENIED_NO_ESCALATION,
  SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING,
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
  test.each([
    "fatal: cannot lock ref 'refs/heads/chore/comet-docs': unable to create directory for .git/refs/heads/chore/comet-docs",
    "fatal: Unable to create '/workspace/.git/index.lock': Read-only file system",
    "error: insufficient permission for adding an object to repository database .git/objects",
    "fatal: cannot update the ref 'HEAD': unable to append to '.git/logs/HEAD': Permission denied",
    // What stays protected when the rest of .git is writable: config, worktrees, modules.
    "error: could not lock config file .git/config: Read-only file system",
    "error: could not lock config file .git/config: Permission denied",
    "error: could not lock config file .git/config: Operation not permitted",
    "error: could not write config file .git/config: Device or resource busy",
    "error: could not write config file .git/config: Device or resource busy\nfatal: could not set 'remote.origin.url' to 'https://example.com/r.git'",
    "Preparing worktree (new branch 'wtb')\nfatal: could not create directory of '.git/worktrees/wt2': Read-only file system",
    "Cloning into '/workspace/sub'...\n/workspace/.git/modules/sub: Read-only file system\nfatal: clone of 'https://example.com/x.git' into submodule path '/workspace/sub' failed",
  ])("explains a protected git write and offers one retry the session can grant: %s", output => {
    const result = denial({ output, exitCode: 128, escalation: "with_approval" });
    expect(result?.kind).toBe("git_write");
    expect(result?.advisesEscalation).toBe(true);
    expect(result?.notice).toBe(SANDBOX_GIT_WRITE_DENIED_ESCALATION_AVAILABLE);
    expect(result?.notice).toContain('sandbox_permissions="require_escalated"');
    expect(result?.notice).toContain("If the user asked for this git operation");
    expect(result?.notice).toContain("justification");
    expect(result?.notice).toContain("once");
    expect(result?.notice).toContain("only this command");
    expect(result?.notice).toContain("Do not write .git files directly");
    expect(result?.notice.split("\n")).toHaveLength(1);
    expect(denial({ output, sandboxApplied: false })).toBeNull();
    const unavailable = denial({ output, exitCode: 128 });
    expect(unavailable?.notice).toBe(SANDBOX_GIT_WRITE_DENIED_NO_ESCALATION);
    expect(unavailable?.notice).toContain("Escalation is unavailable");
    expect(unavailable?.notice).not.toContain("require_escalated");
    expect(unavailable?.advisesEscalation).toBe(false);
    const bypass = denial({ output, exitCode: 128, escalation: "without_asking" });
    expect(bypass?.notice).toBe(SANDBOX_GIT_WRITE_DENIED_WITHOUT_ASKING);
    expect(bypass?.advisesEscalation).toBe(true);
  });

  // DeepSeek on an ld+gt build piped the refused `git config` into another
  // command: the shell exited 0 and the refusal went unexplained.
  test("explains a git refusal that a pipe or a later command hid from the exit status", () => {
    const output = "error: could not write config file .git/config: Device or resource busy\nglobal-exit=4";
    for (const command of [
      "git config user.email dev@comet.example 2>&1 | tail -5",
      "cd /workspace && git config --local user.email dev@comet.example; echo global-exit=$?",
      "/usr/bin/git config user.email dev@comet.example || true",
    ]) {
      const result = denial({ output, exitCode: 0, command, escalation: "without_asking" });
      expect(result?.kind, command).toBe("git_write");
      expect(result?.advisesEscalation, command).toBe(true);
    }
    // Without a git command the same text is somebody else's output, such as a printed log.
    for (const command of [undefined, "cat ci.log", "mygit config user.email x", "echo git"]) {
      expect(denial({ output, exitCode: 0, command, escalation: "without_asking" }), String(command)).toBeNull();
    }
  });

  test("does not recommend git escalation for running hooks, other programs' writes, existing locks or invalid refs", () => {
    for (const output of [
      "bash: .git/hooks/pre-commit: Read-only file system",
      "cp: cannot create regular file '.git/hooks/pre-commit': Read-only file system",
      "tee: .git/config: Read-only file system",
      "error: cannot run .git/hooks/pre-commit: Permission denied",
      "error: could not lock config file /home/user/.gitconfig: Read-only file system",
      "fatal: Unable to create '/workspace/.git/index.lock': File exists.",
      "error: could not lock config file .git/config: File exists",
      "fatal: cannot lock ref 'refs/heads/chore': 'refs/heads/chore/docs' exists; cannot create 'refs/heads/chore'",
      "fatal: invalid reference: chore/comet-docs",
      "fatal: Unable to create '/workspace/index.lock': Permission denied",
    ]) expect(denial({ output, exitCode: 128, escalation: "with_approval" }), output).toBeNull();
  });

  // gpt-6-luna in a bypass session (round4 job oa smoke-git-agenc-light-1): the
  // notice asked it to request approval and "choose approve once", which no
  // bypass session shows; the retry runs without asking.
  test("each grant gets its own wording: bypass without a card, a card, or nothing to ask", () => {
    const output = "fatal: cannot lock ref 'refs/heads/chore/comet-docs': unable to create directory for .git/refs/heads/chore/comet-docs";
    const bypass = denial({ output, exitCode: 128, escalation: "without_asking" })!.notice;
    expect(bypass).toContain('sandbox_permissions="require_escalated"');
    expect(bypass).toContain("one-line justification");
    expect(bypass).toContain("runs outside the sandbox without asking");
    for (const cardWord of ["asking approval", "approve", "prefix_rule"]) expect(bypass).not.toContain(cardWord);
    const card = denial({ output, exitCode: 128, escalation: "with_approval" })!.notice;
    expect(card).toContain("asking approval for only this command");
    expect(card).toContain("omit prefix_rule");
    expect(card).not.toContain("choose approve once");
    expect(card).not.toContain("without asking");

    const bindBypass = denial({ escalation: "without_asking" })!;
    expect(bindBypass.notice).toBe(SANDBOX_BIND_DENIED_WITHOUT_ASKING);
    expect(bindBypass.advisesEscalation).toBe(true);
    expect(bindBypass.notice).toContain("runs outside the sandbox without asking");
    expect(bindBypass.notice).not.toContain("asking to start");
    expect(bindBypass.notice).not.toContain("approved launch");
    expect(bindBypass.notice.length).toBeLessThan(850);
    expect(denial({ escalation: "with_approval" })!.notice).toBe(SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE);
    const none = denial({ escalation: "unavailable" })!;
    expect(none.notice).toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
    expect(none.advisesEscalation).toBe(false);
    for (const notice of [bypass, card, bindBypass.notice]) expect(notice).not.toContain("\u2014");
  });

  test("keeps delegated agents confined even when their session can approve commands", () => {
    const output = "fatal: Unable to create '/workspace/.git/index.lock': Read-only file system";
    for (const services of [
      { sandboxExecutionBroker: { worktreeConfinement: { worktree: "/workspace" } } },
      { readOnlyDelegation: {} },
    ]) {
      for (const escalation of ["with_approval", "without_asking"] as const) {
        const result = denial({ output, exitCode: 128, escalation, session: { services } });
        expect(result?.notice).toContain("Escalation is unavailable");
        expect(result?.notice).not.toContain("require_escalated");
        expect(result?.advisesEscalation).toBe(false);
      }
    }
    expect(denial({ output, exitCode: 0, escalationAvailable: true })).toBeNull();
  });
  test("delivers binding guidance only after a refusal, including a running test with failed listen", () => {
    for (const escalationAvailable of [false, true]) {
      const notice = denial({ exitCode: null, escalationAvailable })?.notice;
      expect(notice).toContain("sandbox.network.allowLocalBinding");
      expect(notice).toContain("true");
      expect(notice).toContain("on Linux, start and test the server in the same command");
      expect(notice?.split("\n")).toHaveLength(1);
      expect(notice!.length).toBeLessThan(850);
      expect(notice).not.toContain("—");
      expect(notice).toContain("private loopback, unreachable from the host browser");
    }
  });
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
    expect(result?.notice).toContain("once");
    expect(result?.notice).toContain("plain-language justification");
    expect(result?.notice).toContain("detach=true on that approved launch");
    expect(result?.notice).toContain("same sandbox_permissions");
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

  test.each([PYTHON_SERVER_SOCKET_DENIED, PYTHON_SERVER_BIND_DENIED])(
    "explains Python server tracebacks even when the errno is on another line",
    (output) => {
      expect(denial({ output })?.notice).toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
      expect(denial({ output, exitCode: null })?.kind).toBe("network_bind");
      expect(denial({ output, sandboxApplied: false })).toBeNull();
    },
  );

  test("does not classify Python file errors or client socket creation as a server denial", () => {
    for (const output of [
      '  File "/usr/lib/python3.11/socket.py", line 232, in __init__\n    _socket.socket.__init__(self, family, type, proto, fileno)\nPermissionError: [Errno 1] Operation not permitted',
      '  File "/usr/lib/python3.11/http/server.py", line 730, in send_head\n    f = open(path, "rb")\nPermissionError: [Errno 13] Permission denied',
      PYTHON_SERVER_SOCKET_DENIED.replace("PermissionError: [Errno 1] Operation not permitted", "OSError: [Errno 24] Too many open files"),
      PYTHON_SERVER_BIND_DENIED.replace("PermissionError: [Errno 13] Permission denied", "OSError: [Errno 98] Address already in use"),
    ]) expect(denial({ output })).toBeNull();
  });

  test("stays silent when the sandbox did not cause it", () => {
    // Nothing was sandboxed: the same errno then means the OS refused for its
    // own reasons (a privileged port, an address in use), and blaming the
    // sandbox would send the model down the wrong path.
    expect(denial({ sandboxApplied: false })).toBeNull();
    // A successful command without a server refusal needs no diagnostic.
    expect(denial({ exitCode: 0, output: "server-local-ok" })).toBeNull();
    // A permission error that has nothing to do with a socket.
    expect(denial({ output: "chmod: /etc/hosts: EPERM: operation not permitted" })).toBeNull();
    // A port conflict is the user's to fix, not the sandbox's.
    expect(denial({ output: "Error: listen EADDRINUSE: address already in use 0.0.0.0:8080" })).toBeNull();
  });

  test("explains a failed background server even when shell cleanup exits zero", () => {
    expect(denial({ exitCode: 0 })?.notice).toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
    expect(denial({ exitCode: 0, output: PYTHON_SERVER_SOCKET_DENIED })?.notice).toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
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
  test("a bypass session in a workspace-write sandbox can still leave it, without a card", () => {
    expect(sandboxEscalationAvailable("never", workspaceWrite(sessionIn("bypassPermissions")))).toBe(true);
    expect(sandboxEscalationGrant("never", workspaceWrite(sessionIn("bypassPermissions")))).toBe("without_asking");
    expect(bypassGrantsSandboxEscalation(sessionIn("bypassPermissions"))).toBe(true);
    expect(denial({
      escalation: sandboxEscalationGrant("never", workspaceWrite(sessionIn("bypassPermissions"))),
    })?.notice).toBe(SANDBOX_BIND_DENIED_WITHOUT_ASKING);
  });

  // The orchestrator refuses these requests whatever the policy: a routine
  // never leaves its sandbox, a read-only delegation child refuses
  // require_escalated, and a print run denies every approval request.
  test("no notice offers a retry nobody can grant, under any policy", () => {
    const nobody = [
      sessionIn("acceptEdits", { runtimeOptions: { routineRun: true } }),
      sessionIn("default", { runtimeOptions: { routineRun: true } }),
      sessionIn("default", { readOnlyDelegation: { deniedRules: [] } }),
      sessionIn("default", { runtimeOptions: { nonInteractive: true } }),
      sessionIn("default", { runtimeOptions: { lightMode: true, nonInteractive: true } }),
      sessionIn("acceptEdits", { runtimeOptions: { nonInteractive: true } }),
    ];
    for (const session of nobody) {
      for (const policy of ["on_request", "on_failure", "untrusted", "never"]) {
        expect(sandboxEscalationGrant(policy, workspaceWrite(session)), JSON.stringify(session.services)).toBe("unavailable");
      }
      expect(denial({ escalation: sandboxEscalationGrant("on_request", workspaceWrite(session)) })?.notice)
        .toBe(SANDBOX_BIND_DENIED_NO_ESCALATION);
    }
    // A standard print run in bypass is granted without asking, as its prompt says.
    expect(sandboxEscalationGrant("never", workspaceWrite(
      sessionIn("bypassPermissions", { runtimeOptions: { nonInteractive: true } }),
    ))).toBe("without_asking");
    // A worktree child's card adds the network, which a refused bind or lookup needs.
    expect(sandboxEscalationGrant("on_request", workspaceWrite(
      sessionIn("default", { sandboxExecutionBroker: { worktreeConfinement: { worktree: "/w", checkout: "/c" } } }),
    ))).toBe("with_approval");
    // An attended session, and a call without a session, keep the card.
    for (const mode of ["default", "acceptEdits", "plan"]) {
      expect(sandboxEscalationGrant("on_request", workspaceWrite(sessionIn(mode)))).toBe("with_approval");
    }
    expect(sandboxEscalationGrant("on_request")).toBe("with_approval");
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
