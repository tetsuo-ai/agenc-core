import { describe, expect, it, vi } from "vitest";

import {
  createRequestLedgerTransferTool,
  LEDGER_ROOT_TURN_ROUTING_GUIDANCE,
  requestLedgerTransferInternals,
} from "../../src/elicitation/request-ledger-transfer.js";
import type {
  LedgerSolanaTransferClientAction,
  RequestUserInputArgs,
} from "../../src/elicitation/types.js";
import type { SessionConfiguration } from "../../src/session/turn-context.js";

const TO = "11111111111111111111111111111111";
const FROM = "11111111111111111111111111111111";
const SIGNATURE = "1".repeat(64);
const RESPONSE_NONCE = "test-response-nonce-with-enough-entropy";

function submittedReceipt(action: LedgerSolanaTransferClientAction) {
  return {
    type: "ledger_solana_transfer_receipt_v1" as const,
    intentId: action.intentId,
    responseNonce: action.responseNonce,
    status: "submitted" as const,
    network: "mainnet-beta" as const,
    from: FROM,
    to: action.to,
    lamports: action.lamports,
    signature: SIGNATURE,
  };
}

function session(
  text: string,
  source: SessionConfiguration["sessionSource"] = "cli_main",
) {
  return {
    sessionConfiguration: { sessionSource: source } as SessionConfiguration,
    currentRootHumanTurn: vi.fn(() => ({ turnId: "turn-current", text })),
    claimLedgerTransferAuthorization: vi.fn().mockResolvedValue(true),
    requestUserInput: vi.fn(
      async (
        _callId: string,
        args: RequestUserInputArgs,
        _signal?: AbortSignal,
      ) => ({
        answers: {},
        clientResult: submittedReceipt(
          args.clientAction as LedgerSolanaTransferClientAction,
        ),
      }),
    ),
  };
}

describe("request_ledger_transfer", () => {
  it("is sandboxed as an interactive mutation with no argument-directed filesystem writes", () => {
    const tool = createRequestLedgerTransferTool({ getSession: () => null });

    expect(tool.metadata?.mutating).toBe(true);
    expect(tool.metadata?.virtualNoFsWrites).toBe(true);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.requiresUserInteraction?.()).toBe(false);
    expect(LEDGER_ROOT_TURN_ROUTING_GUIDANCE).toContain(
      "1 SOL = 1,000,000,000 lamports",
    );
    expect(LEDGER_ROOT_TURN_ROUTING_GUIDANCE).toContain(
      "submitted receipt is not an on-chain confirmation",
    );
  });

  it("generates an Android-safe 256-bit base64url response challenge", async () => {
    const live = session("@ledger transfer once");
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
    }).execute({ to: TO, lamports: "1" });
    const action = live.requestUserInput.mock.calls[0]?.[1]
      .clientAction as LedgerSolanaTransferClientAction;

    expect(result.isError).toBeUndefined();
    expect(action.responseNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("accepts exact integer transfer data without a phone-supplied nonce", () => {
    expect(requestLedgerTransferInternals.parseInput({
      to: TO,
      lamports: "50000000",
      note: "fund the agent",
    })).toEqual({
      to: TO,
      lamports: "50000000",
      note: "fund the agent",
    });
  });

  it.each([
    ["@ledger send 1 SOL", true],
    ["Please use @LEDGER, now", true],
    ["(@Ledger)", true],
    ["old @ledgered mention", false],
    ["email@ledger", false],
    ["@ledger_wallet", false],
    ["ledger", false],
  ])("matches only an exact case-insensitive token: %s", (text, expected) => {
    expect(requestLedgerTransferInternals.hasExactLedgerMention(text)).toBe(expected);
  });

  it.each([
    [{ to: "not-an-address", lamports: "1" }],
    [{ to: "1".repeat(31), lamports: "1" }],
    [{ to: "1".repeat(33), lamports: "1" }],
    [{ to: TO, lamports: "1.5" }],
    [{ to: TO, lamports: "0" }],
  ])("rejects malformed transfer data %#", (input) => {
    expect(() => requestLedgerTransferInternals.parseInput(input)).toThrow();
  });

  it("generates a typed expiring phone action from a Mac TUI @ledger turn", async () => {
    const live = session("@ledger send funds to the address");
    const tool = createRequestLedgerTransferTool({
      getSession: () => live,
      createIntentId: () => "ledger_core_generated_123",
      createResponseNonce: () => RESPONSE_NONCE,
      now: () => Date.parse("2026-07-10T10:00:00.000Z"),
    });

    const result = await tool.execute({
      __callId: "tool-call-1",
      to: TO,
      lamports: "50000000",
      note: "fund the agent",
    });

    expect(result.isError).toBeUndefined();
    expect(live.requestUserInput).toHaveBeenCalledWith(
      "tool-call-1",
      {
        questions: [
          {
            id: "ledger_transfer",
            header: "Ledger",
            question: "Review and approve this Solana transfer on your Ledger device.",
            options: [],
            isOther: true,
            isSecret: false,
          },
        ],
        clientAction: {
          type: "ledger_solana_transfer_v1",
          source: "agenc-core",
          targetCapability: "portal.ledger.solana.sign.v1",
          network: "mainnet-beta",
          intentId: "ledger_core_generated_123",
          responseNonce: RESPONSE_NONCE,
          to: TO,
          lamports: "50000000",
          note: "fund the agent",
          expiresAt: "2026-07-10T10:10:00.000Z",
        },
      },
      expect.any(AbortSignal),
    );
    expect(result.codeModeResult).toEqual({
      type: "ledger_solana_transfer_receipt_v1",
      intentId: "ledger_core_generated_123",
      status: "submitted",
      network: "mainnet-beta",
      from: FROM,
      to: TO,
      lamports: "50000000",
      signature: SIGNATURE,
      confirmed: false,
    });
    expect(result.content).not.toContain(RESPONSE_NONCE);
  });

  it("returns a nonce-free, explicitly unconfirmed cancellation receipt", async () => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockImplementation(async (_callId, args) => {
      const action = args.clientAction as LedgerSolanaTransferClientAction;
      return {
        answers: {},
        clientResult: {
          type: "ledger_solana_transfer_receipt_v1",
          intentId: action.intentId,
          responseNonce: action.responseNonce,
          status: "cancelled",
          network: "mainnet-beta",
          to: action.to,
          lamports: action.lamports,
          reason: "rejected_on_device",
        },
      };
    });
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createIntentId: () => "ledger_cancelled",
      createResponseNonce: () => RESPONSE_NONCE,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBeUndefined();
    expect(result.codeModeResult).toEqual({
      type: "ledger_solana_transfer_receipt_v1",
      intentId: "ledger_cancelled",
      status: "cancelled",
      network: "mainnet-beta",
      to: TO,
      lamports: "1",
      reason: "rejected_on_device",
      confirmed: false,
    });
    expect(result.content).not.toContain(RESPONSE_NONCE);
  });

  it("rejects legacy arbitrary answer strings instead of treating them as receipts", async () => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockResolvedValue({
      answers: { ledger_transfer: { answers: ["tx-signature"] } },
    });
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createResponseNonce: () => RESPONSE_NONCE,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("typed clientResult receipt");
  });

  it.each([
    ["intent", { intentId: "wrong-intent" }],
    ["response challenge", { responseNonce: "wrong-nonce" }],
    ["transfer fields", { to: "SysvarRent111111111111111111111111111111111" }],
    ["transfer fields", { lamports: "2" }],
  ])("rejects a mismatched %s receipt", async (_label, overrides) => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockImplementation(async (_callId, args) => {
      const action = args.clientAction as LedgerSolanaTransferClientAction;
      return {
        answers: {},
        clientResult: { ...submittedReceipt(action), ...overrides },
      };
    });
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createIntentId: () => "ledger_expected",
      createResponseNonce: () => RESPONSE_NONCE,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`mobile Ledger receipt ${_label}`);
  });

  it("rejects a receipt that omits the response challenge", async () => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockImplementation(async (_callId, args) => {
      const action = args.clientAction as LedgerSolanaTransferClientAction;
      const { responseNonce: _omitted, ...withoutNonce } = submittedReceipt(action);
      return { answers: {}, clientResult: withoutNonce as never };
    });
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createResponseNonce: () => RESPONSE_NONCE,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("response challenge");
  });

  it.each([
    ["source address", { from: "not-a-solana-address" }],
    ["signature", { signature: "not-a-signature" }],
  ])("rejects an invalid receipt %s", async (_label, overrides) => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockImplementation(async (_callId, args) => {
      const action = args.clientAction as LedgerSolanaTransferClientAction;
      return {
        answers: {},
        clientResult: { ...submittedReceipt(action), ...overrides },
      };
    });
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createResponseNonce: () => RESPONSE_NONCE,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`valid Solana ${_label}`);
  });

  it("expires a request that never receives a phone response", async () => {
    const live = session("@ledger transfer once");
    live.requestUserInput.mockImplementation(
      async (_callId, _args, signal) => new Promise((resolve) => {
        if (signal?.aborted === true) {
          resolve(null);
          return;
        }
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      }),
    );
    const result = await createRequestLedgerTransferTool({
      getSession: () => live,
      createResponseNonce: () => RESPONSE_NONCE,
      actionTtlMs: 5,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("expired before receiving a result");
  });

  it("rejects a stale prior @ledger turn when the active root turn changed", async () => {
    const live = session("@ledger transfer once");
    const tool = createRequestLedgerTransferTool({ getSession: () => live });
    live.currentRootHumanTurn.mockReturnValue({
      turnId: "turn-new",
      text: "what is the balance?",
    });

    const result = await tool.execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("active root human turn");
    expect(live.requestUserInput).not.toHaveBeenCalled();
  });

  it("consumes @ledger once so a model retry cannot create a second transfer", async () => {
    const live = session("@ledger transfer once");
    live.claimLedgerTransferAuthorization
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const tool = createRequestLedgerTransferTool({
      getSession: () => live,
      createIntentId: () => "ledger_one_shot",
    });

    const first = await tool.execute({ to: TO, lamports: "1" });
    const replay = await tool.execute({ to: TO, lamports: "1" });

    expect(first.isError).toBeUndefined();
    expect(replay.isError).toBe(true);
    expect(replay.content).toContain("already consumed");
    expect(live.requestUserInput).toHaveBeenCalledOnce();
  });

  it("rejects subagents even if their prompt contains @ledger", async () => {
    const child = session("@ledger transfer", "cli_subagent");
    const result = await createRequestLedgerTransferTool({
      getSession: () => child,
    }).execute({ to: TO, lamports: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("root agent");
    expect(child.requestUserInput).not.toHaveBeenCalled();
  });
});
