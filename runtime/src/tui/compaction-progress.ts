import { asRecord } from "../utils/record.js";

export type CompactionProgress = {
  readonly attemptId?: string;
  readonly phase: "prepare" | "summary" | "validate" | "commit" | "complete" | "failed" | "refused";
  readonly percent: number;
  readonly startedAtMs: number;
  readonly beforeTokens: number;
  readonly afterTokens?: number;
  readonly elapsedMs?: number;
  readonly reason?: string;
};

const phases = new Set(["prepare", "summary", "validate", "commit", "complete", "failed", "refused"]);
const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Accept both the local callback and the daemon event envelope. */
export function readCompactionProgress(event: unknown): CompactionProgress | null {
  const outer = asRecord(event);
  const message = asRecord(outer?.msg) ?? outer;
  const payload = asRecord(message?.payload) ?? message;
  if (message?.type !== "compact_progress" && message?.type !== undefined) return null;
  if (payload === null) return null;
  if (typeof payload.phase !== "string" || !phases.has(payload.phase) ||
      !nonNegative(payload.percent) || payload.percent > 100 ||
      !nonNegative(payload.startedAtMs) || !nonNegative(payload.beforeTokens) ||
      (payload.afterTokens !== undefined && !nonNegative(payload.afterTokens)) ||
      (payload.elapsedMs !== undefined && !nonNegative(payload.elapsedMs)) ||
      (payload.reason !== undefined && typeof payload.reason !== "string")) return null;
  return payload as CompactionProgress;
}

export function compactionIsActive(progress: CompactionProgress): boolean {
  return !["complete", "failed", "refused"].includes(progress.phase);
}

export function compactionTokenLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

