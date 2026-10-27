import { redactSecretsInValue } from "../../secrets/sanitizer.js";
import { CompactionCannotReduceError, CompactionSummaryRejectedError } from "./transaction-types.js";
import type { CompactContext, CompactionProgressEvent } from "./types.js";

const observers = new WeakMap<object, Set<(event: CompactionProgressEvent) => void>>();
const latest = new WeakMap<object, CompactionProgressEvent>();

export function subscribeToCompactionProgress(
  session: object,
  listener: (event: CompactionProgressEvent) => void,
): () => void {
  let callbacks = observers.get(session);
  if (callbacks === undefined) observers.set(session, callbacks = new Set());
  callbacks.add(listener);
  const ownedCallbacks = callbacks;
  return () => { ownedCallbacks.delete(listener); };
}

export function readCompactionProgress(session: object): CompactionProgressEvent | undefined {
  return latest.get(session);
}

/** Observer failures must never alter transaction authority or its outcome. */
export function createCompactionProgress(
  context: CompactContext,
  attemptId: string,
  beforeTokens: number,
) {
  const startedAtMs = Date.now();
  let percent = 0;
  let lastSummaryEmitAt = 0;
  const summaryTokensByCall = new Map<number, number>();
  const send = (
    phase: CompactionProgressEvent["phase"],
    value: number,
    details: Partial<Pick<CompactionProgressEvent,
      "afterTokens" | "summaryTokensReceived" | "targetSummaryTokens" | "summaryTokensEstimated" | "reason">> = {},
  ): void => {
    percent = Math.max(percent, Math.min(100, Math.max(0, value)));
    const event: CompactionProgressEvent = Object.freeze({
      type: "compact_progress", attemptId, phase, percent,
      startedAtMs, beforeTokens, ...details,
    });
    try { context.onCompactProgress?.(event); } catch { /* observer only */ }
    const session = context.admissionSession;
    if (session === undefined) return;
    latest.set(session, event);
    for (const listener of observers.get(session) ?? []) {
      try { listener(event); } catch { /* observer only */ }
    }
  };
  send("prepare", 0);
  return {
    send,
    setBeforeTokens: (tokens: number): void => { beforeTokens = tokens; },
    summary: (completedCalls: number, plannedCalls: number, received: number, target: number, force = false): void => {
      if (completedCalls < plannedCalls) summaryTokensByCall.set(completedCalls, received);
      const now = Date.now();
      if (!force && now - lastSummaryEmitAt < 250) return;
      lastSummaryEmitAt = now;
      send("summary", 10 + 70 * Math.min(1, (completedCalls + Math.min(1, received / Math.max(1, target))) / Math.max(1, plannedCalls)), {
        summaryTokensReceived: [...summaryTokensByCall.values()].reduce((sum, tokens) => sum + tokens, 0),
        targetSummaryTokens: plannedCalls * target,
        summaryTokensEstimated: true,
      });
    },
    fail: (error: unknown): void => {
      const refused = error instanceof CompactionCannotReduceError || error instanceof CompactionSummaryRejectedError;
      const reason = redactSecretsInValue(error instanceof Error ? error.message : String(error));
      send(refused ? "refused" : "failed", percent, { reason });
    },
  };
}

export type CompactionProgressReporter = ReturnType<typeof createCompactionProgress>;

/** Accept only bounded runtime progress, never a transcript-shaped authority. */
export function readCompactionProgressEvent(value: unknown): CompactionProgressEvent | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.payload ?? (record.msg as Record<string, unknown> | undefined)?.payload ?? record;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const event = candidate as Record<string, unknown>;
  const type = event.type ?? record.type ?? (record.msg as Record<string, unknown> | undefined)?.type;
  if (type !== "compact_progress" || typeof event.attemptId !== "string" || event.attemptId.length > 4096 ||
      typeof event.phase !== "string" || !["prepare", "summary", "validate", "commit", "complete", "failed", "refused"].includes(event.phase) ||
      typeof event.percent !== "number" || !Number.isFinite(event.percent) || event.percent < 0 || event.percent > 100 ||
      typeof event.startedAtMs !== "number" || !Number.isSafeInteger(event.startedAtMs) || event.startedAtMs < 0 ||
      typeof event.beforeTokens !== "number" || !Number.isSafeInteger(event.beforeTokens) || event.beforeTokens < 0) return undefined;
  for (const field of ["afterTokens", "summaryTokensReceived", "targetSummaryTokens"] as const) {
    if (event[field] !== undefined && (typeof event[field] !== "number" || !Number.isSafeInteger(event[field]) || event[field] < 0)) return undefined;
  }
  if (event.reason !== undefined && (typeof event.reason !== "string" || event.reason.length > 16_384)) return undefined;
  if (event.summaryTokensEstimated !== undefined && typeof event.summaryTokensEstimated !== "boolean") return undefined;
  return event as unknown as CompactionProgressEvent;
}
