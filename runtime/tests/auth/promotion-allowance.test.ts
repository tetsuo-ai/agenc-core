import { describe, expect, it } from "vitest";
import type { AuthLlmUsageAllowance } from "../../src/auth/backend.js";
import { withPromotionWalletAmounts } from "../../src/auth/promotion-allowance.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";

const allowance: AuthLlmUsageAllowance = { status: "active", duration: "promotion", includedUsd: 2.66,
  remainingUsd: 2.59, allowedModelCount: 1 };
const wallet = { unit: "credit_microunits", funding: "promotion", costBasis: "provider_usd",
  balance: "2658000", reserved: "65000", available: "2593000", deficit: "0" };

describe("promotional usage display", () => {
  it("retains pending amounts through the complete remote usage resolver", async () => {
    const backend = new RemoteAuthBackend({ token: "synthetic-only",
      usageEndpoint: "https://identity.example.test/v1/auth/llm-usage",
      fetchImpl: async () => Response.json({ subscriptionTier: "free", managedModelsEnabled: true,
        modelAllowance: allowance, creditWallet: wallet }),
    });
    expect((await backend.getLlmUsage({ sessionId: "synthetic" })).modelAllowance).toMatchObject({
      usedUsd: 0.002, pendingUsd: 0.065, remainingUsd: 2.593,
    });
  });
  it("separates settled spend and pending reservations using integer wallet amounts", () => {
    expect(withPromotionWalletAmounts(allowance, wallet)).toMatchObject({
      usedUsd: 0.002, pendingUsd: 0.065, remainingUsd: 2.593, includedUsd: 2.66,
    });
  });
  it.each([
    { ...wallet, reserved: "-1" }, { ...wallet, reserved: "9999999" },
    { ...wallet, available: "2658000" }, { ...wallet, balance: "9999999999999999999999" },
    { ...wallet, costBasis: "retail" }, { ...wallet, balance: "3000000" },
    { ...wallet, deficit: "5" }, undefined,
  ])("does not invent totals from an incompatible wallet %#", value => {
    expect(withPromotionWalletAmounts(allowance, value)).toEqual(allowance);
  });
  it("does not report expired credit or a paid wallet as model consumption", () => {
    for (const other of [{ ...allowance, status: "unavailable" as const }, { ...allowance, duration: "credit_wallet" }]) {
      expect(withPromotionWalletAmounts(other, { ...wallet, balance: "0", reserved: "0", available: "0" })).toEqual(other);
    }
  });
});
