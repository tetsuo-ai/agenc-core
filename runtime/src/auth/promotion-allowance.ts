import type { AuthLlmUsageAllowance } from "./backend.js";

/** Project an active, single promotional grant without counting holds as spend. */
export function withPromotionWalletAmounts(allowance: AuthLlmUsageAllowance, value: unknown): AuthLlmUsageAllowance {
  if (allowance.duration !== "promotion" || allowance.status !== "active" ||
      allowance.includedUsd === undefined || !value || typeof value !== "object") return allowance;
  const wallet = value as Record<string, unknown>;
  if (wallet.unit !== "credit_microunits" || wallet.funding !== "promotion" || wallet.costBasis !== "provider_usd") return allowance;
  const integer = (value: unknown): bigint | undefined => typeof value === "string" && /^(0|[1-9]\d{0,15})$/u.test(value)
    ? BigInt(value) : undefined;
  const balance = integer(wallet.balance), reserved = integer(wallet.reserved), available = integer(wallet.available);
  const grant = Math.round(allowance.includedUsd * 1_000_000);
  if (!Number.isSafeInteger(grant) || grant < 0 || balance === undefined || reserved === undefined || available === undefined ||
      wallet.deficit !== "0" || balance > BigInt(grant) || reserved > balance || available !== balance - reserved) return allowance;
  const used = BigInt(grant) - balance;
  return { ...allowance, usedUsd: Number(used) / 1_000_000, pendingUsd: Number(reserved) / 1_000_000,
    remainingUsd: Number(available) / 1_000_000, ...(grant > 0 ? { percentUsed: Number(used) / grant * 100 } : {}) };
}
