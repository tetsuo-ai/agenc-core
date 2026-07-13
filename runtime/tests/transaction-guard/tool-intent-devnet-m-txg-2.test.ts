import { describe, expect, test } from "vitest";

import { buildToolTransactionGuardInput } from "../../src/transaction-guard/tool-intent.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";

// M-TXG-2 (core-todo.md): isDevnet = DEVNET_RE.test(combined) matched the bare word
// "devnet" anywhere in attacker-influenced text, so a comment like "# devnet test"
// on a MAINNET transfer made the framework author "targeting DevNet." and set
// devnetRpcExplicit=true, biasing the benign-leaning judge. DevNet must be asserted
// from a URL/flag position and only when no mainnet marker is present.

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
    metadata: { family: "terminal", source: "builtin", mutating: true },
    async execute() {
      return { content: "executed" };
    },
  };
}

function guardFor(cmd: string) {
  return buildToolTransactionGuardInput(makeExecTool(), makeInvocation("txg2"), { cmd });
}

describe("transaction guard — M-TXG-2 devnet spoofing", () => {
  test("a mainnet transfer with a 'devnet' comment is NOT labeled DevNet", () => {
    const input = guardFor(
      "# devnet test only\nsolana transfer ATTACKER11111111111111111111111111111111 100 --url https://api.mainnet-beta.solana.com",
    );
    expect(input).not.toBeNull();
    expect(input?.transactionSummary).not.toContain("DevNet");
    expect((input?.metadata as { detector?: { devnetRpcExplicit?: boolean } })?.detector?.devnetRpcExplicit).toBe(
      false,
    );
  });

  test("a bare 'devnet' word with no devnet RPC/flag does not assert DevNet", () => {
    const input = guardFor(
      "solana transfer X1111111111111111111111111111111111111111 1 # remember devnet earlier",
    );
    expect(input).not.toBeNull();
    expect(input?.transactionSummary).not.toContain("DevNet");
  });

  test("a genuine devnet RPC URL IS labeled DevNet", () => {
    const input = guardFor(
      "solana transfer X1111111111111111111111111111111111111111 1 --url https://api.devnet.solana.com",
    );
    expect(input).not.toBeNull();
    expect(input?.transactionSummary).toContain("DevNet");
    expect((input?.metadata as { detector?: { devnetRpcExplicit?: boolean } })?.detector?.devnetRpcExplicit).toBe(
      true,
    );
  });

  test("a --url devnet flag value is labeled DevNet", () => {
    const input = guardFor("solana airdrop 1 --url devnet");
    expect(input).not.toBeNull();
    expect(input?.transactionSummary).toContain("DevNet");
  });
});
