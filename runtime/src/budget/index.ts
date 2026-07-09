/**
 * Budget enforcement (TODO task 15, Phase 2).
 *
 * A daemon-owned layer that bounds autonomous-agent spend. Grounded in
 * docs/design/budget-enforcement.md. Disabled by default.
 */

export * from "./types.js";
export { resolveBudgetPolicy } from "./config.js";
export { BudgetLedger, windowKeys, type BudgetLedgerOptions } from "./ledger.js";
export { BudgetEnforcer, type BudgetEnforcerOptions } from "./enforcer.js";
export { createModelPriceResolver } from "./pricing.js";
