import { describe, expect, test } from "vitest";

import { buildToolTransactionGuardInput } from "../../src/transaction-guard/tool-intent.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";

// C2 (core-todo.md): buildToolTransactionGuardInput checked isReadOnlySolanaLookup
// (which returns null = guard skipped) BEFORE the write-signal check, and that
// read-only check consulted only SOLANA_WRITE_SIGNAL_RE — never the direct-signing
// or program-write regexes. So prefixing a real signing/deploy command with one
// read-only lookup skipped the guard entirely. These tests pin that the guard now
// FIRES on the prefixed forms while genuine read-only lookups still skip it.

function makeInvocation(callId: string): ToolInvocation {
  return {
    session: { services: {} } as never,
    turn: {
      cwd: "/repo",
      sandboxPolicy: { value: "workspace_write" },
      approvalPolicy: { value: "on_request" },
    } as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId,
    toolName: { name: "exec_command" },
    payload: { kind: "function", arguments: "" },
    source: "direct",
  };
}

function makeExecTool(): Tool {
  return {
    name: "exec_command",
    description: "test tool",
    inputSchema: { type: "object", additionalProperties: true },
    // family "terminal" carries NO solana hint, so the metadata branch is inert
    // and detection is decided purely by the command text.
    metadata: { family: "terminal", source: "builtin", mutating: true },
    async execute() {
      return { content: "executed" };
    },
  };
}

function guardInputFor(cmd: string) {
  return buildToolTransactionGuardInput(makeExecTool(), makeInvocation("c2"), { cmd });
}

describe("transaction guard — C2 read-only-prefix bypass", () => {
  // Each command pairs a read-only lookup with a real signing/deploy action. The
  // guard MUST fire (non-null) despite the read-only prefix.
  test.each([
    {
      name: "direct submitTransaction after balance lookup",
      cmd: "solana balance && node -e 'conn.submitTransaction(raw)'",
    },
    {
      name: "walletSign after balance lookup",
      cmd: "solana balance; node -e 'provider.walletSign(tx)'",
    },
    {
      name: "program write-buffer after program show",
      cmd: "solana program show Prog && solana program write-buffer ./evil.so --url mainnet-beta",
    },
    {
      name: "program set-buffer-authority after program show",
      cmd: "solana program show Prog && solana program set-buffer-authority BUF --new-buffer-authority Attacker",
    },
  ])("guards a signing/deploy action hidden behind a read-only prefix: $name", ({ cmd }) => {
    const input = guardInputFor(cmd);
    expect(input).not.toBeNull();
    expect(input?.kind).toBe("solana_tool_invocation");
  });

  // Genuine read-only lookups (no write/sign/deploy signal) must still skip the guard.
  test.each([
    { name: "balance", cmd: "solana balance --url https://api.mainnet-beta.solana.com" },
    { name: "program show", cmd: "solana program show Prog1111111111111111111111111111111111111111" },
    { name: "spl-token accounts", cmd: "spl-token accounts" },
    { name: "epoch-info", cmd: "solana epoch-info" },
  ])("does not guard a genuine read-only lookup: $name", ({ cmd }) => {
    expect(guardInputFor(cmd)).toBeNull();
  });
});
