/**
 * In-band think-tag extraction for chat-completions content.
 *
 * Reasoning models served over the openai-compat wire disagree about
 * where chain-of-thought goes. The well-behaved ones stream it on
 * `delta.reasoning_content`; the rest inline it in `delta.content`
 * wrapped in template markers — `<think>…</think>` (MiniMax M3, Qwen3
 * family, R1 distills) or `◁think▷…◁/think▷` (Kimi K2 template) — and
 * the tags land verbatim in the chat transcript.
 *
 * The extraction rule is deliberately narrow: only a marker that opens
 * at the very start of the assistant message (leading whitespace
 * allowed) starts a reasoning block, and only its first matching closer
 * ends it. That is where every known chat template puts the block, and
 * it keeps a literal "<think>" later in an answer — likely when the
 * subject of the conversation is this very bug — visible text.
 */

interface ThinkMarkerPair {
  readonly open: string;
  readonly close: string;
}

const THINK_MARKERS: readonly ThinkMarkerPair[] = [
  { open: "<think>", close: "</think>" },
  { open: "◁think▷", close: "◁/think▷" },
];

export interface ThinkSplit {
  /** Visible assistant text in this piece. */
  readonly text: string;
  /** Chain-of-thought extracted from this piece. */
  readonly reasoning: string;
}

/**
 * Split a complete message: a leading think block moves to `reasoning`,
 * the rest (leading whitespace dropped) stays `text`. A leading opener
 * that never closes sends the whole remainder to `reasoning` — the
 * generation died mid-thought and the fragment is not an answer.
 */
export function splitLeadingThinkBlock(content: string): ThinkSplit {
  const trimmed = content.trimStart();
  for (const marker of THINK_MARKERS) {
    if (!trimmed.startsWith(marker.open)) continue;
    const body = trimmed.slice(marker.open.length);
    const closeAt = body.indexOf(marker.close);
    if (closeAt === -1) return { text: "", reasoning: body };
    return {
      text: body.slice(closeAt + marker.close.length).trimStart(),
      reasoning: body.slice(0, closeAt),
    };
  }
  return { text: content, reasoning: "" };
}

/**
 * The streaming form: feed arbitrary chunk boundaries in, get the
 * pieces that are RESOLVED so far out. Markers split across chunks are
 * held back until they can be classified, so neither channel ever has
 * to retract text it already emitted:
 *
 *   - before classification, input buffers while it is still a prefix
 *     of (whitespace +) an opener;
 *   - inside a block, a tail short enough to be a partial closer stays
 *     buffered;
 *   - `flush()` at stream end drains the buffer to whichever channel
 *     the state says it belongs to.
 */
export class ThinkTagStreamFilter {
  private state: "detect" | "inside" | "pass" = "detect";
  private buffer = "";
  private marker: ThinkMarkerPair | null = null;

  push(input: string): ThinkSplit {
    if (input.length === 0) return { text: "", reasoning: "" };
    let text = "";
    let reasoning = "";
    this.buffer += input;

    if (this.state === "detect") {
      const trimmed = this.buffer.trimStart();
      const opened = THINK_MARKERS.find((candidate) =>
        trimmed.startsWith(candidate.open),
      );
      if (opened !== undefined) {
        this.state = "inside";
        this.marker = opened;
        this.buffer = trimmed.slice(opened.open.length);
      } else if (
        trimmed.length === 0 ||
        THINK_MARKERS.some((candidate) => candidate.open.startsWith(trimmed))
      ) {
        // Still ambiguous — could grow into an opener. Keep buffering.
        return { text: "", reasoning: "" };
      } else {
        this.state = "pass";
        text = this.buffer;
        this.buffer = "";
        return { text, reasoning };
      }
    }

    if (this.state === "inside" && this.marker !== null) {
      const closeAt = this.buffer.indexOf(this.marker.close);
      if (closeAt !== -1) {
        reasoning = this.buffer.slice(0, closeAt);
        this.state = "pass";
        text = this.buffer
          .slice(closeAt + this.marker.close.length)
          .trimStart();
        this.buffer = "";
        this.marker = null;
        return { text, reasoning };
      }
      // Hold back a possible partial closer; everything before it is
      // definitively reasoning.
      const holdback = this.partialCloserLength();
      const settled = this.buffer.length - holdback;
      if (settled > 0) {
        reasoning = this.buffer.slice(0, settled);
        this.buffer = this.buffer.slice(settled);
      }
      return { text, reasoning };
    }

    text = this.buffer;
    this.buffer = "";
    return { text, reasoning };
  }

  /** Drain whatever is still buffered when the stream ends. */
  flush(): ThinkSplit {
    const remainder = this.buffer;
    this.buffer = "";
    if (remainder.length === 0) return { text: "", reasoning: "" };
    if (this.state === "inside") {
      this.state = "pass";
      this.marker = null;
      return { text: "", reasoning: remainder };
    }
    this.state = "pass";
    return { text: remainder, reasoning: "" };
  }

  /** Longest tail of the buffer that is a proper prefix of the closer. */
  private partialCloserLength(): number {
    const close = this.marker?.close ?? "";
    const max = Math.min(close.length - 1, this.buffer.length);
    for (let length = max; length > 0; length -= 1) {
      if (this.buffer.endsWith(close.slice(0, length))) return length;
    }
    return 0;
  }
}
