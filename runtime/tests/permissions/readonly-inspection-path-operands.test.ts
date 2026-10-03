import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectReadOnlyCommand } from "../../src/permissions/readonly-inspection.js";
import { analyzeShellRuntimeAccess } from "../../src/tools/runtimes/shell.js";
import { enforceRuntimeSandboxAttempt } from "../../src/tools/runtimes/sandboxing.js";
import { EXCLUSIVE } from "../../src/tools/concurrency.js";
import type { Tool } from "../../src/tools/types.js";

// grep and rg read every operand after the pattern. When the pattern rides an
// attached -e value (-e1, -e=1) or git diff compares a path outside the
// repository (implicit --no-index), that operand is a file the command reads.
const cwd = "/project";
const shellTool: Tool = {
  name: "exec_command",
  description: "",
  inputSchema: { type: "object" },
  metadata: { mutating: true },
  execute: async () => ({ content: "not reached" }),
};

const ESCAPES = [
  "grep -e1 /etc/passwd",
  "grep -e=1 /etc/passwd",
  "rg -e1 /etc/passwd",
] as const;

function readOnlyContext() {
  const dir = mkdtempSync(join(tmpdir(), "agenc-ro-operand-helper-"));
  const helper = join(dir, "agenc-linux-sandbox");
  writeFileSync(helper, "#!/bin/sh\nexit 126\n");
  chmodSync(helper, 0o755);
  return {
    callId: "call-ro-operands",
    toolName: "RuntimeProbe",
    runtimeKind: "function",
    classification: EXCLUSIVE,
    supportsParallelToolCalls: false,
    source: "direct",
    submittedAtMs: performance.now(),
    approvalPolicy: "never",
    requestedSandboxMode: "read_only",
    sandboxMode: "read_only",
    approvalResolved: false,
    rawArgs: "{}",
    invocation: {
      session: { services: { admissionRequired: false, runtimeOptions: { sessionTempRoot: join(tmpdir(), "agenc-ro-operand-root") } } },
      turn: { cwd, agencLinuxSandboxExe: helper },
      tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      callId: "call-ro-operands",
      toolName: { name: "exec_command" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    },
  } as never;
}

describe("read-only inspection path operands", () => {
  it.each(ESCAPES)("keeps the delegation workspace boundary for %s", (cmd) => {
    // The separated spelling is already refused; attached spellings must match.
    expect(inspectReadOnlyCommand("exec_command", { cmd: "grep -e 1 /etc/passwd" }, cwd)).toMatchObject({ allowed: false });
    expect(inspectReadOnlyCommand("exec_command", { cmd }, cwd)).toMatchObject({ allowed: false });
  });

  it.each([...ESCAPES, "git diff /etc/passwd /dev/null"])("reports the read target of %s", (cmd) => {
    const analysis = analyzeShellRuntimeAccess(shellTool, { cmd }, cwd);
    expect(analysis?.readTargets).toContain("/etc/passwd");
  });

  it.each([...ESCAPES, "git diff /etc/passwd /dev/null"])("read_only sandbox blocks %s like cat", (cmd) => {
    const context = readOnlyContext();
    expect(() => enforceRuntimeSandboxAttempt({ context, tool: shellTool, args: { cmd: "cat /etc/passwd" } }))
      .toThrow(/read_only blocked read outside workspace: \/etc\/passwd/);
    expect(() => enforceRuntimeSandboxAttempt({ context, tool: shellTool, args: { cmd } }))
      .toThrow(/read_only blocked read outside workspace: \/etc\/passwd/);
  });

  it.each(["grep -e1 src/a.ts", "rg -e1 src", "grep -rn TODO src", "git show HEAD:README.md", "git diff --stat -- src", "git diff main -- src", "git log --oneline -5"])(
    "still accepts in-project inspection: %s",
    (cmd) => {
      expect(inspectReadOnlyCommand("exec_command", { cmd }, cwd, { allowWorktreeGitInspection: true })).toMatchObject({ allowed: true });
    },
  );
});
