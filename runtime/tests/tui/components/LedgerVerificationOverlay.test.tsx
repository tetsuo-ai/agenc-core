import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  beginLedgerVerification,
  getLedgerVerificationSnapshot,
  markLedgerVerified,
  resetLedgerVerificationForTests,
} from "../../../src/services/Ledger/ledgerVerification.js";
import { Box } from "../../../src/tui/ink.js";
import { renderToString } from "../../utils/staticRender.js";

const harness = vi.hoisted(() => ({
  inputHandler: undefined as
    | undefined
    | ((
        input: string,
        key: Record<string, boolean>,
        event: { stopImmediatePropagation: () => void },
      ) => void),
  registerOverlay: vi.fn(),
}));

vi.mock("../context/overlayContext.js", () => ({
  useRegisterOverlay: harness.registerOverlay,
}));

vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30 }),
}));

vi.mock("./v2/primitives.js", () => ({
  kittyLogoPlaceholderRows: () => [],
  supportsKittyGraphics: () => false,
}));

vi.mock("../ink.js", async () => {
  const actual = await vi.importActual<typeof import("../ink.js")>("../ink.js");
  return {
    ...actual,
    useInput: (
      handler: (
        input: string,
        key: Record<string, boolean>,
        event: { stopImmediatePropagation: () => void },
      ) => void,
    ) => {
      harness.inputHandler = handler;
    },
  };
});

describe("LedgerVerificationOverlay", () => {
  beforeEach(() => {
    resetLedgerVerificationForTests();
    harness.inputHandler = undefined;
    harness.registerOverlay.mockClear();
  });

  afterEach(() => {
    resetLedgerVerificationForTests();
  });

  test("renders unlock guidance and registers as a modal overlay", async () => {
    beginLedgerVerification({
      source: "prompt",
      model: "Nano X",
    });
    const { LedgerVerificationOverlay } = await import(
      "./LedgerVerificationOverlay.js"
    );
    const output = await renderToString(
      <Box width={100} height={30}>
        <LedgerVerificationOverlay />
      </Box>,
      100,
    );

    expect(output).toContain("LEDGER AUTHENTICITY");
    expect(output).toContain("CONNECT & UNLOCK YOUR LEDGER");
    expect(output).toContain("device · Nano X");
    expect(harness.registerOverlay).toHaveBeenCalledWith(
      "ledger-verification",
      true,
    );
  });

  test("replaces the pending state with a verified result", async () => {
    const requestId = beginLedgerVerification({ source: "slash" });
    markLedgerVerified(requestId, { model: "Nano S Plus" });
    const { LedgerVerificationOverlay } = await import(
      "./LedgerVerificationOverlay.js"
    );
    const output = await renderToString(
      <Box width={100} height={30}>
        <LedgerVerificationOverlay />
      </Box>,
      100,
    );

    expect(output).toContain("LEDGER VERIFIED");
    expect(output).toContain("passed Ledger's official authenticity");
    expect(output).toContain("check.");
    expect(output).toContain("closing automatically");
  });

  test("Esc closes the active popup before the composer handles it", async () => {
    const requestId = beginLedgerVerification({ source: "prompt" });
    const { LedgerVerificationOverlay } = await import(
      "./LedgerVerificationOverlay.js"
    );
    await renderToString(
      <Box width={100} height={30}>
        <LedgerVerificationOverlay />
      </Box>,
      100,
    );
    const event = { stopImmediatePropagation: vi.fn() };

    harness.inputHandler?.("", { escape: true }, event);

    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(getLedgerVerificationSnapshot()).toMatchObject({
      requestId,
      phase: "idle",
    });
  });
});
