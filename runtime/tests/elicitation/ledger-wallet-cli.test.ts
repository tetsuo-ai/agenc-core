import { describe, expect, test } from "vitest";

import {
  createInstallLedgerWalletCliTool,
  hasLedgerWalletCliMention,
} from "../../src/elicitation/ledger-wallet-cli.js";

describe("Ledger Wallet CLI routing and install approval", () => {
  test("routes Ledger hardware-wallet language but not accounting ledgers", () => {
    expect(hasLedgerWalletCliMention("what happened with Ledger?")).toBe(true);
    expect(hasLedgerWalletCliMention("run wallet-cli balances")).toBe(true);
    expect(
      hasLedgerWalletCliMention("post this journal entry to the accounting ledger"),
    ).toBe(false);
  });

  test("the managed installer always requires a bypass-immune confirmation", () => {
    const tool = createInstallLedgerWalletCliTool({
      agencHome: "/tmp/agenc-test",
      env: { HOME: "/tmp" },
    });
    const permission = tool.checkPermissions?.({}, {} as never);

    expect(tool.requiresApproval).toBe(true);
    expect(tool.requiresUserInteraction?.()).toBe(true);
    expect(permission).toMatchObject({
      behavior: "ask",
      decisionReason: {
        type: "safetyCheck",
        classifierApprovable: false,
      },
    });
    if (permission && "message" in permission) {
      expect(permission.message).toContain("Nothing has been downloaded yet");
      expect(permission.message).toContain("latest official");
    }
  });
});
