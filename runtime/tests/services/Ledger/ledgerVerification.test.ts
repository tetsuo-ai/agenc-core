import { afterEach, describe, expect, test } from "vitest";

import {
  beginLedgerVerification,
  dismissLedgerVerification,
  getLedgerVerificationSnapshot,
  isLedgerAuthenticityRequest,
  isLedgerGenuineResult,
  markLedgerVerificationFailed,
  markLedgerVerified,
  observeLedgerGenuineCheck,
  resetLedgerVerificationForTests,
} from "../../../src/services/Ledger/ledgerVerification.js";

function toolUse(id: string, command: string): unknown {
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id,
          name: "exec_command",
          input: { cmd: command },
        },
      ],
    },
  };
}

function toolResult(
  id: string,
  content: string,
  isError = false,
): unknown {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          is_error: isError,
        },
      ],
    },
  };
}

afterEach(() => {
  resetLedgerVerificationForTests();
});

describe("Ledger verification store", () => {
  test("recognizes focused authenticity requests without matching ordinary Ledger questions", () => {
    expect(
      isLedgerAuthenticityRequest(
        "Check whether my Ledger wallet is authentic",
      ),
    ).toBe(true);
    expect(
      isLedgerAuthenticityRequest(
        "verifica si mi Ledger Nano es auténtica",
      ),
    ).toBe(true);
    expect(isLedgerAuthenticityRequest("/ledger genuine-check")).toBe(true);
    expect(isLedgerAuthenticityRequest("show my Ledger balance")).toBe(false);
    expect(isLedgerAuthenticityRequest("verify this downloaded file")).toBe(
      false,
    );
  });

  test("protects a newer request from stale completion updates", () => {
    const first = beginLedgerVerification({ source: "prompt" });
    dismissLedgerVerification(first);
    const second = beginLedgerVerification({ source: "prompt" });

    markLedgerVerified(first);
    expect(getLedgerVerificationSnapshot().requestId).toBe(second);
    expect(getLedgerVerificationSnapshot().phase).toBe("waiting");

    markLedgerVerificationFailed(second, "USB device unavailable");
    expect(getLedgerVerificationSnapshot()).toMatchObject({
      phase: "failed",
      detail: "USB device unavailable",
    });
  });
});

describe("observeLedgerGenuineCheck", () => {
  test("tracks a running wallet-cli genuine check", () => {
    const messages = [
      toolUse(
        "call-ledger",
        "/managed/tools/wallet-cli genuine-check --output human",
      ),
    ];
    expect(
      observeLedgerGenuineCheck({
        messages,
        inProgressToolUseIDs: new Set(["call-ledger"]),
      }),
    ).toEqual({
      callId: "call-ledger",
      status: "running",
    });
  });

  test("only reports success after the matching non-error result", () => {
    const messages = [
      toolUse(
        "call-ledger",
        "/managed/tools/wallet-cli genuine-check --output human",
      ),
      toolResult("call-ledger", '{"ok":true,"data":{"genuine":true}}'),
    ];
    expect(
      observeLedgerGenuineCheck({
        messages,
        inProgressToolUseIDs: new Set(),
      }),
    ).toEqual({
      callId: "call-ledger",
      status: "succeeded",
      detail: '{"ok":true,"data":{"genuine":true}}',
    });
  });

  test("requires explicit proof before reporting a genuine device", () => {
    expect(
      isLedgerGenuineResult(
        '{"status":"success","command":"genuine-check","genuine":true}',
      ),
    ).toBe(true);
    expect(isLedgerGenuineResult("Device is genuine")).toBe(true);
    expect(isLedgerGenuineResult('{"ok":true}')).toBe(false);

    const messages = [
      toolUse(
        "call-ledger",
        "/managed/tools/wallet-cli genuine-check --output human",
      ),
      toolResult("call-ledger", "Command completed successfully"),
    ];
    expect(
      observeLedgerGenuineCheck({
        messages,
        inProgressToolUseIDs: new Set(),
      }),
    ).toEqual({
      callId: "call-ledger",
      status: "failed",
      detail:
        "Wallet CLI completed without an explicit genuine-device confirmation.",
    });
  });

  test("keeps failures out of the verified state", () => {
    const messages = [
      toolUse(
        "call-ledger",
        "/managed/tools/wallet-cli genuine-check --output human",
      ),
      toolResult("call-ledger", "Device is not genuine", true),
    ];
    expect(
      observeLedgerGenuineCheck({
        messages,
        inProgressToolUseIDs: new Set(),
      }),
    ).toEqual({
      callId: "call-ledger",
      status: "failed",
      detail: "Device is not genuine",
    });
  });

  test("ignores completed checks before the current request baseline", () => {
    const messages = [
      toolUse(
        "old-call",
        "/managed/tools/wallet-cli genuine-check --output human",
      ),
      toolResult("old-call", '{"ok":true}'),
      { type: "user", message: { content: "check it again" } },
    ];
    expect(
      observeLedgerGenuineCheck({
        messages,
        inProgressToolUseIDs: new Set(),
        startIndex: 2,
      }),
    ).toBeNull();
  });
});
