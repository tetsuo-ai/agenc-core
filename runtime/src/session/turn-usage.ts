import type { AdmissionUsageSummary } from "../budget/admission-types.js";
import type { Event } from "./event-log.js";

/** Missing counters are omitted. Costs exclude descendants and unresolved holds. */
export interface TurnUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cached?: number;
  readonly reasoning?: number;
  readonly costUsd?: number;
  readonly billedEstimateUsd?: number;
  readonly planCalls?: number;
}

export class TurnUsageCollector {
  private readonly before: AdmissionUsageSummary | undefined;
  private input: number | undefined;
  private output: number | undefined;
  private cached: number | undefined;
  private reasoning: number | undefined;
  private readonly missing = new Set<string>();
  constructor(private readonly read?: () => AdmissionUsageSummary) {
    this.before = this.readSummary();
  }
  private readSummary(): AdmissionUsageSummary | undefined {
    try { return this.read?.(); } catch { return undefined; }
  }
  observe(event: Event): void {
    if (event.msg.type !== "token_count") return;
    const p = event.msg.payload;
    for (const [key, value] of Object.entries({ input: p.promptTokens, output: p.completionTokens, cached: p.cachedInputTokens, reasoning: p.reasoningOutputTokens })) {
      if (value === undefined) this.missing.add(key);
    }
    if (p.promptTokens !== undefined) this.input = (this.input ?? 0) + p.promptTokens;
    if (p.completionTokens !== undefined) this.output = (this.output ?? 0) + p.completionTokens;
    if (p.cachedInputTokens !== undefined) this.cached = (this.cached ?? 0) + p.cachedInputTokens;
    if (p.reasoningOutputTokens !== undefined) this.reasoning = (this.reasoning ?? 0) + p.reasoningOutputTokens;
  }
  snapshot(): TurnUsage {
    const after = this.readSummary();
    const before = this.before;
    const difference = (key: "costUsd" | "billedEstimateUsd" | "planCalls") => {
      const a = after?.[key], b = before?.[key];
      return typeof a === "number" && typeof b === "number" && a >= b && Number.isFinite(a - b)
        ? a - b : undefined;
    };
    const costUsd = before && after && !before.hasUnknownCost && !after.hasUnknownCost &&
      !before.costEstimated && !after.costEstimated ? difference("costUsd") : undefined;
    const billedEstimateUsd = difference("billedEstimateUsd");
    const planCalls = difference("planCalls");
    return {
      ...(this.input !== undefined && !this.missing.has("input") ? { input: this.input } : {}),
      ...(this.output !== undefined && !this.missing.has("output") ? { output: this.output } : {}),
      ...(this.cached !== undefined && !this.missing.has("cached") ? { cached: this.cached } : {}),
      ...(this.reasoning !== undefined && !this.missing.has("reasoning") ? { reasoning: this.reasoning } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(billedEstimateUsd !== undefined ? { billedEstimateUsd } : {}),
      ...(planCalls !== undefined ? { planCalls } : {}),
    };
  }
}
