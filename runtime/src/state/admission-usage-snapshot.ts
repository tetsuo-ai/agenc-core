import type { AdmissionUsageSnapshot, AdmissionUsageSummary, AdmissionUsageTotals, UnpricedUsageCall } from "../budget/admission-types.js";
import { isOffPeakAt, offPeakScheduleFor } from "../session/off-peak-pricing.js";

/** Only immutable reservation fields used by the usage observer. */
export interface UsageReservation {
  readonly reservation_id: string;
  readonly run_id: string;
  readonly step_id?: string;
  readonly kind: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly status: string;
  readonly actual_input_tokens: number | null;
  readonly actual_output_tokens: number | null;
  readonly actual_tokens: number | null;
  readonly actual_cost_nanos: number | null;
  readonly reserved_cost_nanos: number;
  readonly resolution_reason: string | null;
  readonly dispatched_at?: string | null;
}

/** Display adjustment only. Null means an eligible call has no usable time. */
export function offPeakSavingsNanos(row: Pick<UsageReservation,
  "kind" | "provider" | "model" | "status" | "actual_cost_nanos" | "resolution_reason" | "dispatched_at"
>): number | null {
  if (row.kind !== "model_turn" || !["reconciled", "provider_overrun"].includes(row.status) ||
      !row.actual_cost_nanos || row.resolution_reason === "estimated_model_price") return 0;
  const schedule = offPeakScheduleFor(row.provider ?? undefined, row.model ?? undefined);
  if (schedule === null) return 0;
  const at = Date.parse(row.dispatched_at ?? "");
  if (!Number.isFinite(at)) return null;
  return isOffPeakAt(schedule, at) ? row.actual_cost_nanos / 2 : 0;
}

export const MAX_UNPRICED_USAGE_CALLS = 20;

export function unpricedUsageCall(row: UsageReservation): UnpricedUsageCall | undefined {
  if (row.status !== "held_unknown" &&
      !(["reconciled", "provider_overrun"].includes(row.status) && row.actual_cost_nanos === null)) return undefined;
  return {
    reservationId: row.reservation_id, runId: row.run_id,
    stepId: row.step_id ?? row.reservation_id, kind: row.kind,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    reason: row.resolution_reason ?? "reported_usage_cost_unknown",
  };
}

type Counts = [number, number, number, number, number, number, number, number, number, number];
interface Group {
  readonly identity: readonly [string, string, string | null, string | null];
  readonly counts: Counts;
  count: number;
}
const zero = (): Counts => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function contribution(row: UsageReservation): Counts {
  const savings = offPeakSavingsNanos(row);
  const reported = ["reconciled", "provider_overrun", "held_unknown"].includes(row.status);
  const priced = ["reconciled", "provider_overrun"].includes(row.status);
  const held = ["reserved", "dispatched", "held_unknown"].includes(row.status) ||
    (row.status === "provider_overrun" && row.actual_cost_nanos === null);
  return [
    priced ? row.actual_cost_nanos ?? 0 : 0,
    held ? row.reserved_cost_nanos : 0,
    reported ? row.actual_input_tokens ?? 0 : 0,
    reported ? row.actual_output_tokens ?? 0 : 0,
    reported ? row.actual_tokens ?? 0 : 0,
    row.kind === "model_turn" && reported && row.actual_tokens !== null ? 1 : 0,
    row.status === "held_unknown" || (priced && row.actual_cost_nanos === null) ? 1 : 0,
    row.resolution_reason === "estimated_model_price" ? 1 : 0,
    savings ?? 0,
    savings === null ? 1 : 0,
  ];
}

function add(target: Counts, source: Counts, sign = 1): void {
  for (let i = 0; i < target.length; i += 1) target[i]! += sign * source[i]!;
}

function visible(counts: Counts): readonly (number | boolean)[] {
  return [counts[0] / 1_000_000_000, counts[1] / 1_000_000_000, ...counts.slice(2, 6), counts[6] > 0, counts[7] > 0];
}

/** Bounded-cache fallback with exactly the same observation equality. */
export function captureMaterializedUsage(summary: AdmissionUsageSummary): AdmissionUsageSnapshot {
  const captured = structuredClone(summary);
  const encode = (value: AdmissionUsageTotals) => [value.costUsd, value.heldCostUsd, value.inputTokens, value.outputTokens,
    value.totalTokens, value.modelCalls, value.hasUnknownCost, value.costEstimated === true];
  return {
    runId: captured.runId, sequence: captured.sequence,
    signature: JSON.stringify([encode(captured), captured.billedEstimateUsd,
      captured.models.map(m => [m.model, m.provider ?? null, encode(m)]),
      captured.agents.map(a => [a.runId, encode(a)]),
      captured.unpricedCalls ?? [], captured.unpricedCallCount ?? 0,
    ]),
    read: () => structuredClone(captured),
  };
}

function totals(counts: Counts): AdmissionUsageTotals {
  if (!Number.isSafeInteger(counts[0]) || counts[0] < 0 || !Number.isSafeInteger(counts[1]) || counts[1] < 0) {
    throw new Error("usage cost exceeds the safe nano-USD range");
  }
  return {
    costUsd: counts[0] / 1_000_000_000, heldCostUsd: counts[1] / 1_000_000_000,
    inputTokens: counts[2], outputTokens: counts[3], totalTokens: counts[4], modelCalls: counts[5],
    hasUnknownCost: counts[6] > 0, ...(counts[7] > 0 ? { costEstimated: true } : {}),
  };
}

function compareIdentity(a: Group, b: Group): number {
  for (let i = 0; i < a.identity.length; i += 1) {
    const x = a.identity[i]!; const y = b.identity[i]!;
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    const compared = Buffer.compare(Buffer.from(x), Buffer.from(y));
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Incremental numeric observation; never used to authorize spending. */
export class AdmissionUsageProjection {
  private readonly reservations = new Map<string, UsageReservation>();
  private readonly groups = new Map<string, Group>();
  private readonly unpriced = new Map<string, UnpricedUsageCall>();
  get size(): number { return this.reservations.size; }

  update(id: string, next: UsageReservation | undefined): void {
    const diagnostic = next === undefined ? undefined : unpricedUsageCall(next);
    if (diagnostic === undefined) this.unpriced.delete(id);
    else this.unpriced.set(id, diagnostic);
    const previous = this.reservations.get(id);
    if (previous !== undefined) this.change(previous, -1);
    if (next === undefined || next.status === "voided") this.reservations.delete(id);
    else {
      const captured = { ...next };
      this.reservations.set(id, captured);
      this.change(captured, 1);
    }
  }

  private change(row: UsageReservation, sign: number): void {
    const identity = [row.run_id, row.kind, row.model, row.provider] as const;
    const key = JSON.stringify(identity);
    const group = this.groups.get(key) ?? { identity, counts: zero(), count: 0 };
    add(group.counts, contribution(row), sign);
    group.count += sign;
    if (group.count === 0) this.groups.delete(key);
    else this.groups.set(key, group);
  }

  capture(runId: string, sequence: number): AdmissionUsageSnapshot {
    const all = zero();
    const models = new Map<string, { model: string | null; provider: string | null; counts: Counts }>();
    const agents = new Map<string, Counts>();
    // Same group ordering as SQLite's BINARY GROUP BY/ORDER BY, including
    // NULL and non-ASCII identities. Numeric snapshots own their arrays.
    for (const group of [...this.groups.values()].sort(compareIdentity)) {
      const [owner, kind, model, provider] = group.identity;
      add(all, group.counts);
      if (kind === "model_turn") {
        const key = JSON.stringify([provider, model]);
        const entry = models.get(key) ?? { model, provider, counts: zero() };
        add(entry.counts, group.counts); models.set(key, entry);
      }
      if (owner !== runId) {
        const counts = agents.get(owner) ?? zero();
        add(counts, group.counts); agents.set(owner, counts);
      }
    }
    const unpricedCalls = [...this.unpriced.values()]
      .sort((a, b) => Buffer.compare(Buffer.from(a.reservationId), Buffer.from(b.reservationId)))
      .slice(0, MAX_UNPRICED_USAGE_CALLS);
    const unpricedCallCount = this.unpriced.size;
    const billedEstimateUsd = all[9] === 0 && all[7] === 0 ? (all[0] - all[8]) / 1_000_000_000 : undefined;
    const signature = JSON.stringify([
      visible(all), billedEstimateUsd,
      [...models.values()].map(m => [m.model ?? "unknown", m.provider, visible(m.counts)]),
      [...agents].map(([id, counts]) => [id, visible(counts)]),
      unpricedCalls, unpricedCallCount,
    ]);
    return {
      runId, sequence, signature,
      read: () => ({
        runId, sequence, ...totals(all),
        ...(billedEstimateUsd !== undefined ? { billedEstimateUsd } : {}),
        ...(unpricedCallCount > 0 ? { unpricedCalls: unpricedCalls.map(call => ({ ...call })), unpricedCallCount } : {}),
        models: [...models.values()].map(m => ({ model: m.model ?? "unknown", ...(m.provider === null ? {} : { provider: m.provider }), ...totals(m.counts) })),
        agents: [...agents].map(([id, counts]) => ({ runId: id, ...totals(counts) })),
      }),
    };
  }
}
