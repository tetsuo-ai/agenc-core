import type { UnifiedExecStream } from "./types.js";
import { truncateHeadTail } from "./head-tail-buffer.js";

const DEFAULT_OUTPUT_BUFFER_CHARS = 1024 * 1024;
const TASK_OUTPUT_TAIL_CHARS = 8192;

interface OutputChunk {
  readonly stream: UnifiedExecStream;
  readonly chunk: string;
}

export class ProcessOutputBuffer {
  private readonly chunks: OutputChunk[] = [];
  private consumedIndex = 0;
  private totalChars = 0;
  private outputTail = "";
  private outputBytes = 0;
  /**
   * Test-only counter of expensive pending-collapse passes, so a perf test can
   * assert the O(pending) work is amortized rather than run on every append.
   */
  collapseCountForTest = 0;

  constructor(private readonly maxChars = DEFAULT_OUTPUT_BUFFER_CHARS,
    observed?: { readonly outputTail: string; readonly outputBytes: number }) {
    if (observed !== undefined) {
      this.outputTail = observed.outputTail;
      this.outputBytes = observed.outputBytes;
    }
  }

  append(stream: UnifiedExecStream, chunk: string): void {
    if (chunk.length === 0) return;
    this.outputBytes += Buffer.byteLength(chunk);
    this.outputTail = chunk.length >= TASK_OUTPUT_TAIL_CHARS
      ? chunk.slice(-TASK_OUTPUT_TAIL_CHARS)
      : (this.outputTail + chunk).slice(-TASK_OUTPUT_TAIL_CHARS);
    this.chunks.push({ stream, chunk });
    this.totalChars += chunk.length;
    // Evicting already-consumed chunks is cheap and safe on every append. The
    // expensive pending collapse (slice/filter/join/truncateHeadTail over the
    // whole ~1MB pending region) is amortized: under deferred drain
    // (consumedIndex stays 0) it previously re-ran on every 8KB chunk past the
    // cap, pinning a core for a verbose emitter. Now it runs only once the
    // pending region overshoots by a full cap's worth, then collapses back to
    // the cap — bounding memory at ~2*maxChars and making the collapse amortized
    // O(1) per appended char. drain() still collapses to the cap so a caller
    // never sees more than maxChars.
    this.evictConsumed();
    if (this.totalChars > this.maxChars * 2) {
      this.collapsePending();
    }
  }

  drain(): OutputChunk[] {
    if (this.totalChars > this.maxChars) {
      this.evictConsumed();
      if (this.totalChars > this.maxChars) {
        this.collapsePending();
      }
    }
    const drained = this.chunks.slice(this.consumedIndex);
    this.consumedIndex = this.chunks.length;
    return drained;
  }

  /** Reading task details must never consume the model's pending output. */
  snapshot(): { outputTail: string; outputBytes: number } {
    return { outputTail: this.outputTail, outputBytes: this.outputBytes };
  }

  private evictConsumed(): void {
    // Already-consumed chunks were returned to the caller by a prior drain(), so
    // discarding them costs nothing and never needs an omitted-count marker.
    while (
      this.totalChars > this.maxChars &&
      this.consumedIndex > 0 &&
      this.chunks.length > 0
    ) {
      const removed = this.chunks.shift()!;
      this.totalChars -= removed.chunk.length;
      this.consumedIndex -= 1;
    }
  }

  private collapsePending(): void {
    if (this.totalChars <= this.maxChars) return;
    this.collapseCountForTest += 1;

    // The cap is still exceeded by pending (undrained) output. Rather than
    // dropping the most-recent unconsumed bytes wholesale (which previously
    // discarded still-unconsumed HEAD output on a single oversized burst),
    // collapse the pending region with head/tail truncation so both the head
    // and the tail/exit-summary survive, and surface the omitted count.
    const pending = this.chunks.slice(this.consumedIndex);
    if (pending.length === 0) return;

    // The pending region interleaves stdout AND stderr chunks. Collapsing them
    // under a single hard-coded "stdout" label would relabel all stderr bytes
    // as stdout (silently emptying the returned stderr field). Instead, truncate
    // each stream's pending bytes SEPARATELY so each keeps its own head/tail and
    // its own stream label.
    const stdoutText = pending
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.chunk)
      .join("");
    const stderrText = pending
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join("");

    // Preserve original stream order (stdout before stderr) for deterministic
    // output; only non-empty streams participate.
    const segments: OutputChunk[] = [];
    if (stdoutText.length > 0) {
      segments.push({ stream: "stdout", chunk: stdoutText });
    }
    if (stderrText.length > 0) {
      segments.push({ stream: "stderr", chunk: stderrText });
    }
    if (segments.length === 0) return;
    const totalLen = stdoutText.length + stderrText.length;

    // Allocate the cap across streams with max-min fairness: smallest stream
    // first, each taking an equal share of the remaining budget, with any unused
    // share rolling forward to the larger stream(s). A proportional split would
    // starve a tiny stderr exit-summary when stdout floods past the cap; this
    // keeps the small stream intact (its budget == its length) and gives the
    // overflow budget to whichever stream actually needs truncating.
    const budgetByStream = new Map<UnifiedExecStream, number>();
    const ordered = [...segments].sort(
      (a, b) => a.chunk.length - b.chunk.length,
    );
    let remainingCap = this.maxChars;
    let remaining = ordered.length;
    for (const segment of ordered) {
      const share = Math.floor(remainingCap / remaining);
      const budget = Math.min(segment.chunk.length, share);
      budgetByStream.set(segment.stream, budget);
      remainingCap -= budget;
      remaining -= 1;
    }

    // truncateHeadTail embeds its own `[... omitted N chars ...]` marker inline
    // between the preserved head and tail, so we replace the pending chunks with
    // the per-stream truncated text directly. Clamp each budget to truncateHeadTail's
    // own 64-char floor: passing a smaller budget would make it report a negative
    // omitted count for a sub-64 stream (it never truncates below 64 chars anyway).
    const replacement: OutputChunk[] = [];
    for (const segment of segments) {
      const budget = budgetByStream.get(segment.stream) ?? segment.chunk.length;
      const truncated = truncateHeadTail(segment.chunk, Math.max(64, budget));
      replacement.push({ stream: segment.stream, chunk: truncated.text });
    }

    this.chunks.length = this.consumedIndex;
    this.chunks.push(...replacement);
    const replacementChars = replacement.reduce(
      (sum, chunk) => sum + chunk.chunk.length,
      0,
    );
    this.totalChars = this.totalChars - totalLen + replacementChars;
  }
}
