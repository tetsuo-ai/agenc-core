import type { PendingEffectReview } from "../app-server/protocol/index.js";
import { isRecord } from "../utils/record.js";

function reviewKey(callId: string, sessionId?: string): string {
  return sessionId === undefined ? callId : `${sessionId}\0${callId}`;
}

/** Review state comes from effect events, never from matching model prose. */
export class PendingEffectReviews {
  private readonly calls = new Map<string, { toolName: string; description: string; error?: string }>();
  private readonly refusals = new Set<string>();
  private readonly pending = new Map<string, PendingEffectReview>();

  get reviews(): readonly PendingEffectReview[] { return [...this.pending.values()]; }

  recordRefusal(message: string): void {
    if ([...this.pending.values()].some(review => review.blocksSession !== false)) return;
    const ids = [...message.matchAll(/\/resolve ([^\s<>]+)/gu)].map(match => match[1]!);
    for (const callId of ids.length > 0 ? ids : [""]) {
      this.refusals.add(callId);
      const call = this.calls.get(callId);
      this.pending.set(callId, { callId, toolName: call?.toolName ?? "Tool",
        description: call?.description ?? "Interrupted call", error: call?.error ?? message.slice(0, 2000) });
    }
  }

  apply(raw: unknown): boolean {
    if (!isRecord(raw)) return false;
    const event = isRecord(raw.msg) ? raw.msg : raw;
    const payload = event.payload;
    if (!isRecord(payload)) return false;
    if (event.type === "effect_reviews_snapshot" && Array.isArray(payload.reviews)) {
      this.pending.clear();
      this.refusals.clear();
      for (const review of payload.reviews) {
        if (isRecord(review) && typeof review.callId === "string" &&
            typeof review.toolName === "string" && typeof review.description === "string" &&
            typeof review.error === "string") {
          this.pending.set(reviewKey(review.callId, typeof review.sessionId === "string" ? review.sessionId : undefined), review as PendingEffectReview);
        }
      }
      return true;
    }
    if (event.type === "effect_review_acknowledged") {
      // A legacy poisoned call has no canonical review event. An RPC receipt
      // can clear refusal placeholders, never newer canonical review state.
      if (payload.remaining === 0) {
        for (const id of this.refusals) this.pending.delete(id);
        this.refusals.clear();
      } else if (typeof payload.callId === "string" &&
                 (payload.disposition === "confirmed_no_effect" || payload.disposition === "confirmed_committed") &&
                 this.refusals.delete(payload.callId)) {
        this.pending.delete(payload.callId);
      }
      return true;
    }
    const callId = payload.callId;
    if (typeof callId !== "string") return false;
    const sessionId = typeof payload.runId === "string" ? payload.runId : undefined;
    const key = reviewKey(callId, sessionId);
    if (event.type === "tool_call_started" && typeof payload.toolName === "string") {
      let description = typeof payload.args === "string" ? payload.args : "";
      try {
        const args: unknown = JSON.parse(description);
        if (isRecord(args)) description = Object.values(args)
          .filter((value) => typeof value === "string").join(" ") || description;
      } catch { /* Historical calls can have plain text arguments. */ }
      this.calls.set(callId, { toolName: payload.toolName, description: description.slice(0, 1000) });
      // Keep recent input context without retaining an unbounded second transcript.
      if (this.calls.size > 256) {
        for (const id of this.calls.keys()) {
          if (!this.pending.has(id)) { this.calls.delete(id); break; }
        }
      }
    } else if (event.type === "tool_call_completed" && payload.isError === true &&
               typeof payload.result === "string") {
      const call = this.calls.get(callId) ?? { toolName: String(payload.toolName ?? "Tool"), description: "" };
      call.error = payload.result.slice(0, 2000);
      this.calls.set(callId, call);
      const review = this.pending.get(key) ?? this.pending.get(callId);
      if (review !== undefined) {
        this.pending.set(reviewKey(callId, review.sessionId), { ...review, error: call.error });
        return true;
      }
    } else if (event.type === "effect_unknown_outcome" && payload.requiresReview === true &&
               (payload.recoveryCategory === "side-effecting" || payload.recoveryCategory === "interactive")) {
      const call = this.calls.get(callId);
      this.refusals.delete(callId);
      if (this.refusals.delete("")) this.pending.delete("");
      this.pending.delete(callId);
      this.pending.set(key, {
        callId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        toolName: String(payload.toolName ?? call?.toolName ?? "Tool"),
        description: call?.description ?? "Interrupted tool call",
        error: call?.error ?? String(payload.reason ?? "Unknown outcome"),
      });
      return true;
    } else if (event.type === "effect_review_resolved" && isRecord(payload.resolution) &&
               (payload.resolution.workflowStatus === "resolved" || payload.resolution.workflowStatus === "abandoned")) {
      const deleted = this.pending.delete(key);
      return this.pending.delete(callId) || deleted;
    }
    return false;
  }
}
