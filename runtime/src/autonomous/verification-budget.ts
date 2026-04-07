/**
 * Verification budget — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 470-LOC adaptive lamports budget allocator
 * tied to the deleted verifier lane. Kept as opaque types so the
 * verifier stub still type-checks.
 *
 * @module
 */

export interface BudgetGuardrail {
  readonly minBudgetLamports: bigint;
  readonly maxBudgetLamports: bigint;
  readonly cooldownMs?: number;
  readonly adjustmentRate?: number;
}

export interface BudgetAdjustmentInput {
  readonly outcome: "pass" | "fail";
  readonly currentBudgetLamports: bigint;
  readonly guardrail: BudgetGuardrail;
}

export interface BudgetAdjustmentResult {
  readonly nextBudgetLamports: bigint;
  readonly direction: "up" | "down" | "hold";
}

export interface BudgetAuditEntry {
  readonly timestamp: number;
  readonly outcome: "pass" | "fail";
  readonly nextBudgetLamports: bigint;
}

export interface VerificationBudgetDecision {
  readonly allocated: bigint;
  readonly remaining: bigint;
}

export const DEFAULT_BUDGET_GUARDRAIL: BudgetGuardrail = {
  minBudgetLamports: 0n,
  maxBudgetLamports: 0n,
  adjustmentRate: 0,
  cooldownMs: 0,
};

export const DEFAULT_INITIAL_BUDGET_LAMPORTS = 0n;

export function resolveBudgetGuardrail(
  _input?: Partial<BudgetGuardrail>,
): BudgetGuardrail {
  return DEFAULT_BUDGET_GUARDRAIL;
}

export function validateBudgetGuardrail(_guardrail: BudgetGuardrail): void {
  // no-op
}

export function calculateNextBudget(
  input: BudgetAdjustmentInput,
): BudgetAdjustmentResult {
  return { nextBudgetLamports: input.currentBudgetLamports, direction: "hold" };
}

export function countConsecutiveFromEnd(
  _values: readonly boolean[],
  _target: boolean,
): number {
  return 0;
}

export function clampBudget(value: bigint, _guardrail: BudgetGuardrail): bigint {
  return value;
}

export class BudgetAuditTrail {
  private readonly entries: BudgetAuditEntry[] = [];
  record(entry: BudgetAuditEntry): void {
    this.entries.push(entry);
  }
  getEntries(): readonly BudgetAuditEntry[] {
    return this.entries;
  }
}

export function allocateVerificationBudget(
  _input: unknown,
): VerificationBudgetDecision {
  return { allocated: 0n, remaining: 0n };
}
