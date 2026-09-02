import { describe, expect, test } from "vitest";

import {
  execSandboxDenialNotice,
  sandboxEscalationAvailable,
  SANDBOX_BIND_DENIED_ESCALATION_AVAILABLE,
  SANDBOX_BIND_DENIED_NO_ESCALATION,
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
});
