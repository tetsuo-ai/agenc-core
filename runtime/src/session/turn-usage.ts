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
  constructor(private readonly read?: () => AdmissionUsageSummary) {
    this.before = read?.();
  }
  observe(event: Event): void {
    if (event.msg.type !== "token_count") return;
    const p = event.msg.payload;
    this.input = (this.input ?? 0) + p.promptTokens;
    this.output = (this.output ?? 0) + p.completionTokens;
    if (p.cachedInputTokens !== undefined) this.cached = (this.cached ?? 0) + p.cachedInputTokens;
    if (p.reasoningOutputTokens !== undefined) this.reasoning = (this.reasoning ?? 0) + p.reasoningOutputTokens;
  }
  snapshot(): TurnUsage {
    const after = this.read?.();
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
      ...(this.input !== undefined ? { input: this.input } : {}),
      ...(this.output !== undefined ? { output: this.output } : {}),
      ...(this.cached !== undefined ? { cached: this.cached } : {}),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(billedEstimateUsd !== undefined ? { billedEstimateUsd } : {}),
      ...(planCalls !== undefined ? { planCalls } : {}),
    };
  }
}
