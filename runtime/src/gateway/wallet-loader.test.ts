/**
 * wallet-loader tests.
 *
 * expandPath has moved to runtime/src/types/wallet.ts — see wallet.test.ts.
 */

import { describe, it, expect } from "vitest";
import * as walletLoader from "./wallet-loader.js";

describe("wallet-loader module", () => {
  it("exports loadWallet", () => {
    expect(typeof walletLoader.loadWallet).toBe("function");
  });

  it("does not export expandPath (moved to wallet.ts)", () => {
    expect((walletLoader as Record<string, unknown>).expandPath).toBeUndefined();
  });
});
