import { describe, expect, test } from "vitest";

import { parseLedgerModel } from "../../../src/services/Ledger/ledgerStatus.js";

describe("parseLedgerModel", () => {
  test("extracts the model from a Nano S Plus lsusb line", () => {
    const out =
      "Bus 001 Device 018: ID 2c97:5011 Ledger Nano S Plus\n" +
      "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n";
    expect(parseLedgerModel(out)).toBe("Nano S Plus");
  });

  test("extracts other Ledger models", () => {
    expect(parseLedgerModel("Bus 002 Device 004: ID 2c97:0004 Ledger Nano X\n")).toBe(
      "Nano X",
    );
    expect(parseLedgerModel("Bus 002 Device 005: ID 2c97:6000 Ledger Stax\n")).toBe(
      "Stax",
    );
  });

  test("returns null when no Ledger vendor id is present", () => {
    const out =
      "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\n" +
      "Bus 003 Device 002: ID 046d:c52b Logitech USB Receiver\n";
    expect(parseLedgerModel(out)).toBeNull();
    expect(parseLedgerModel("")).toBeNull();
  });

  test("falls back to a generic label when the model text is empty", () => {
    expect(parseLedgerModel("Bus 001 Device 018: ID 2c97:5011\n")).toBe("Ledger");
  });
});
