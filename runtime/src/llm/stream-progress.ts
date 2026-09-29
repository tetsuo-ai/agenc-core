import type { LLMStreamChunk } from "./types.js";

/** No new reasoning window for three minutes, even if bytes keep arriving. */
export const REASONING_NO_PROGRESS_MS = 180_000;
/** Retry eligibility is finite; a stalled request gets only one fresh attempt. */
export const STREAM_RETRY_WINDOW_MS = 30 * 60_000;
export const STREAM_STALL_RETRY_BUDGET_MS = 15 * 60_000;

export type StreamProgressStop = "stream_loop" | "stream_no_progress" | "stream_retry_budget";

export class StreamProgressError extends Error {
  constructor(readonly provider: string, readonly reason: StreamProgressStop) {
    const name = provider === "grok" ? "Grok" : "The model";
    super(reason === "stream_loop"
      ? `${name} got stuck repeating itself. Try again or switch model.`
      : reason === "stream_retry_budget"
        ? `${name} could not recover from a stalled response. Try again or switch model.`
        : `${name} stopped making progress. Try again or switch model.`);
    this.name = "StreamProgressError";
  }
}

// Overlapping windows make detection independent of token/chunk boundaries,
// punctuation, sentence length and alternating summary indices. Keep numbers:
// changing a calculation or a table row is genuine progress.
const WINDOW_CHARS = 96;
const MAX_WINDOWS = 8_192;
const REPEATED_CHARS = 4_096;
const MIN_OCCURRENCES = 8;

/** Bounded-memory detector; never places a total time limit on novel reasoning. */
export class StreamProgressTracker {
  private reasoningTail = "";
  private readonly windows = new Map<string, number>();
  private repeatedChars = 0;
  private readonly tools = new Map<string, string>();

  observe(chunk: LLMStreamChunk, newVisibleText: boolean): {
    progress: boolean;
    reasoning: boolean;
    loop: boolean;
  } {
    let toolProgress = false;
    const start = chunk.toolInputBlockStart;
    if (start && !this.tools.has(start.callId)) {
      this.tools.set(start.callId, "");
      toolProgress = true;
    }
    if (chunk.toolInputDelta?.partialJson.trim()) toolProgress = true;
    for (const call of chunk.toolCalls ?? []) {
      const data = `${call.name}\n${call.arguments}`;
      if (this.tools.get(call.id) !== data) toolProgress = true;
      this.tools.set(call.id, data);
    }
    const reasoning = chunk.thinkingDelta !== undefined || chunk.reasoningSummaryDelta !== undefined;
    const delta = (chunk.thinkingDelta?.delta ?? "") + (chunk.reasoningSummaryDelta?.delta ?? "");
    let novel = false;
    let loop = false;
    for (const char of delta.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")) {
      this.reasoningTail = (this.reasoningTail + char).slice(-WINDOW_CHARS);
      if (this.reasoningTail.length < WINDOW_CHARS) {
        novel = true;
        continue;
      }
      const key = this.reasoningTail;
      const count = (this.windows.get(key) ?? 0) + 1;
      this.windows.delete(key);
      this.windows.set(key, count);
      if (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!);
      if (count === 1) {
        novel = true;
        this.repeatedChars = 0;
        loop = false;
      } else {
        this.repeatedChars += 1;
        if (this.repeatedChars >= REPEATED_CHARS && count >= MIN_OCCURRENCES) loop = true;
      }
    }
    const outputProgress = newVisibleText || toolProgress || chunk.bufferedContentProgress === true;
    if (outputProgress) {
      // A new answer or tool action breaks the reasoning-only stall. Retain
      // the dictionary so a loop cannot evade detection by opening blocks.
      this.repeatedChars = 0;
      loop = false;
    }
    return { progress: outputProgress || novel, reasoning, loop };
  }
}
