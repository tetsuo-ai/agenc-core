// Static import for I-54 validateToolCallsForExecution.
import {
  validateToolCallDetailed,
  type LLMToolCall,
} from "./types.js";

/**
 * Stream parser — extract/strip hidden tags from assistant text.
 *
 * Hand-port of the core subset of codex
 * `codex-rs/utils/stream-parser/src/`:
 *
 *   - `citation.rs` / `strip_citations`         — <oai-mem-citation>…</oai-mem-citation>
 *   - `proposed_plan.rs` / `strip_proposed_plan_blocks` — <proposed_plan>…</proposed_plan>
 *   - `inline_hidden_tag.rs`                    — generic literal-tag stripper
 *
 * The codex parser handles streaming (partial chunks that split a tag
 * across a `push_str` boundary). Here we ship a full-string stripper
 * for each tag family plus a streaming `InlineHiddenTagParser` class
 * for phase-5 consumers that feed per-chunk output from the provider
 * stream.
 *
 * Invariants covered here:
 *   I-54 (tool-call schema validation)      — T7 wires the Zod
 *        validation layer on top of parsed tool-use blocks.
 *   I-56 (stream chunk reorder normalize)   — T7 wires reorder.
 *   I-77 (model UI-spoof sanitization)      — strip/extract runs
 *        before any TUI rendering.
 *
 * T7 tightens the streaming semantics (currently the streaming class
 * buffers a partial open tag at the end of a push_str but emits the
 * rest of the chunk unchanged). For T5 the synchronous/full-string
 * strip functions are exact-match with codex output on complete text;
 * the streaming class is a best-effort chunked emitter.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// Tag constants
// ─────────────────────────────────────────────────────────────────────

const CITATION_OPEN = "<oai-mem-citation>";
const CITATION_CLOSE = "</oai-mem-citation>";

const PLAN_OPEN = "<proposed_plan>";
const PLAN_CLOSE = "</proposed_plan>";

// ─────────────────────────────────────────────────────────────────────
// InlineTagSpec (shared) — literal, non-nested tag specs
// ─────────────────────────────────────────────────────────────────────

export interface InlineTagSpec<TagName extends string = string> {
  readonly tag: TagName;
  readonly open: string;
  readonly close: string;
}

export interface ExtractedInlineTag<TagName extends string = string> {
  readonly tag: TagName;
  readonly content: string;
}

export interface StripResult<TagName extends string = string> {
  readonly visibleText: string;
  readonly extracted: ReadonlyArray<ExtractedInlineTag<TagName>>;
}

// ─────────────────────────────────────────────────────────────────────
// Full-string strip — matches codex `strip_citations` / `strip_proposed_plan_blocks`
// ─────────────────────────────────────────────────────────────────────

/**
 * Generic literal-tag stripper. Non-nested matching: a tag nested
 * inside another of the same kind is consumed verbatim as part of
 * the outer tag's content, and its closing tag terminates the outer
 * block. Unterminated tags auto-close at EOF.
 *
 * Matches codex `InlineHiddenTagParser` semantics on a finished
 * input.
 */
export function stripInlineHiddenTags<TagName extends string>(
  input: string,
  specs: ReadonlyArray<InlineTagSpec<TagName>>,
): StripResult<TagName> {
  let visible = "";
  const extracted: ExtractedInlineTag<TagName>[] = [];
  let i = 0;
  outer: while (i < input.length) {
    // Check for any open-tag at the current position.
    for (const spec of specs) {
      if (input.startsWith(spec.open, i)) {
        const closeIdx = input.indexOf(spec.close, i + spec.open.length);
        if (closeIdx >= 0) {
          const content = input.slice(i + spec.open.length, closeIdx);
          extracted.push({ tag: spec.tag, content });
          i = closeIdx + spec.close.length;
        } else {
          // Unterminated → auto-close at EOF (codex semantics).
          const content = input.slice(i + spec.open.length);
          extracted.push({ tag: spec.tag, content });
          i = input.length;
        }
        continue outer;
      }
    }
    visible += input[i];
    i += 1;
  }
  return { visibleText: visible, extracted };
}

/**
 * Strip `<oai-mem-citation>…</oai-mem-citation>` tags from a complete
 * string. Returns `(visibleText, citations)`. Mirrors codex
 * `strip_citations`.
 */
export function stripCitations(text: string): {
  readonly visibleText: string;
  readonly citations: ReadonlyArray<string>;
} {
  const { visibleText, extracted } = stripInlineHiddenTags(text, [
    { tag: "citation", open: CITATION_OPEN, close: CITATION_CLOSE },
  ]);
  return {
    visibleText,
    citations: extracted.map((e) => e.content),
  };
}

/**
 * Strip `<proposed_plan>…</proposed_plan>` blocks from a complete
 * string. Mirrors codex `strip_proposed_plan_blocks`.
 */
export function stripProposedPlanBlocks(text: string): string {
  return stripInlineHiddenTags(text, [
    { tag: "proposed_plan", open: PLAN_OPEN, close: PLAN_CLOSE },
  ]).visibleText;
}

/**
 * Extract proposed_plan text content from a complete string.
 * Mirrors codex `extract_proposed_plan_text`.
 */
export function extractProposedPlanText(text: string): ReadonlyArray<string> {
  return stripInlineHiddenTags(text, [
    { tag: "proposed_plan", open: PLAN_OPEN, close: PLAN_CLOSE },
  ]).extracted.map((e) => e.content);
}

// ─────────────────────────────────────────────────────────────────────
// Streaming parser — incremental push_str/finish model (codex parity)
// ─────────────────────────────────────────────────────────────────────

export interface StreamTextChunk<Extracted> {
  readonly visibleText: string;
  readonly extracted: ReadonlyArray<Extracted>;
}

/**
 * Stateful streaming stripper. Consumers call `pushStr(chunk)` for
 * each incoming provider chunk and `finish()` at EOF; each call
 * returns only the newly-resolved visible text + extracted tags. A
 * partial open-tag prefix at the end of a chunk is buffered until
 * the next chunk (or emitted verbatim at `finish()` if it never
 * resolves — matches codex `preserves_partial_open_tag_at_eof`).
 *
 * Used by phase 5 (stream-model) once T7 wires the streaming
 * `chatStream()` path.
 */
export class InlineHiddenTagParser<TagName extends string> {
  private readonly specs: ReadonlyArray<InlineTagSpec<TagName>>;
  private buffer = "";
  private mode: "outside" | { activeTag: InlineTagSpec<TagName>; contentBuf: string } = "outside";

  constructor(specs: ReadonlyArray<InlineTagSpec<TagName>>) {
    if (specs.length === 0) {
      throw new Error("InlineHiddenTagParser requires at least one TagSpec");
    }
    this.specs = specs;
  }

  pushStr(chunk: string): StreamTextChunk<ExtractedInlineTag<TagName>> {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): StreamTextChunk<ExtractedInlineTag<TagName>> {
    return this.drain(true);
  }

  private drain(isEof: boolean): StreamTextChunk<ExtractedInlineTag<TagName>> {
    let visible = "";
    const extracted: ExtractedInlineTag<TagName>[] = [];

    while (this.buffer.length > 0) {
      if (this.mode === "outside") {
        const earliestOpen = this.findEarliestOpen();
        if (earliestOpen === null) {
          // No complete open tag found. If the buffer tail could still
          // be the beginning of an open tag, keep it pending; otherwise
          // flush everything.
          if (isEof) {
            visible += this.buffer;
            this.buffer = "";
            break;
          }
          const pendingStart = this.earliestPartialOpenIndex();
          if (pendingStart === null) {
            visible += this.buffer;
            this.buffer = "";
          } else {
            visible += this.buffer.slice(0, pendingStart);
            this.buffer = this.buffer.slice(pendingStart);
          }
          break;
        }
        visible += this.buffer.slice(0, earliestOpen.index);
        this.buffer = this.buffer.slice(earliestOpen.index + earliestOpen.spec.open.length);
        this.mode = { activeTag: earliestOpen.spec, contentBuf: "" };
      } else {
        const closeIdx = this.buffer.indexOf(this.mode.activeTag.close);
        if (closeIdx >= 0) {
          const content = this.mode.contentBuf + this.buffer.slice(0, closeIdx);
          extracted.push({ tag: this.mode.activeTag.tag, content });
          this.buffer = this.buffer.slice(closeIdx + this.mode.activeTag.close.length);
          this.mode = "outside";
        } else if (isEof) {
          // Auto-close at EOF.
          const content = this.mode.contentBuf + this.buffer;
          extracted.push({ tag: this.mode.activeTag.tag, content });
          this.buffer = "";
          this.mode = "outside";
        } else {
          // Keep a potential-close prefix in buffer; flush the rest
          // to the active tag's content so we don't retain unbounded
          // memory.
          const closePrefix = this.longestSuffixPrefixOf(this.buffer, this.mode.activeTag.close);
          this.mode.contentBuf += this.buffer.slice(0, this.buffer.length - closePrefix);
          this.buffer = this.buffer.slice(this.buffer.length - closePrefix);
          break;
        }
      }
    }

    return { visibleText: visible, extracted };
  }

  private findEarliestOpen(): { index: number; spec: InlineTagSpec<TagName> } | null {
    let best: { index: number; spec: InlineTagSpec<TagName> } | null = null;
    for (const spec of this.specs) {
      const i = this.buffer.indexOf(spec.open);
      if (i >= 0 && (best === null || i < best.index)) {
        best = { index: i, spec };
      }
    }
    return best;
  }

  private earliestPartialOpenIndex(): number | null {
    let earliest: number | null = null;
    for (const spec of this.specs) {
      const idx = this.longestPartialOpenIndex(spec.open);
      if (idx !== null && (earliest === null || idx < earliest)) {
        earliest = idx;
      }
    }
    return earliest;
  }

  private longestPartialOpenIndex(open: string): number | null {
    // Return the smallest i such that buffer[i..] is a strict prefix
    // of `open` (i.e. an incomplete open tag pending more chunks).
    const len = this.buffer.length;
    for (let i = Math.max(0, len - (open.length - 1)); i < len; i += 1) {
      if (open.startsWith(this.buffer.slice(i))) return i;
    }
    return null;
  }

  private longestSuffixPrefixOf(haystack: string, needle: string): number {
    const max = Math.min(haystack.length, needle.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (needle.startsWith(haystack.slice(haystack.length - len))) return len;
    }
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience wrappers — preconfigured streaming parsers
// ─────────────────────────────────────────────────────────────────────

export class CitationStreamParser extends InlineHiddenTagParser<"citation"> {
  constructor() {
    super([{ tag: "citation", open: CITATION_OPEN, close: CITATION_CLOSE }]);
  }
}

export class ProposedPlanStreamParser extends InlineHiddenTagParser<"proposed_plan"> {
  constructor() {
    super([{ tag: "proposed_plan", open: PLAN_OPEN, close: PLAN_CLOSE }]);
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-56 · Stream-chunk reorder normalization
// ─────────────────────────────────────────────────────────────────────

/**
 * Canonical chunk kinds in the order consumers expect them. Codex
 * + AgenC history format is: reasoning → tool_use → text. Some
 * providers emit in arbitrary order — buffer during streaming and
 * re-emit in canonical order on end().
 */
export type StreamChunkKind = "reasoning" | "tool_use" | "text" | "other";

export interface StreamChunkReorderEntry<T> {
  readonly kind: StreamChunkKind;
  readonly chunk: T;
}

const CHUNK_KIND_ORDER: Readonly<Record<StreamChunkKind, number>> =
  Object.freeze({
    reasoning: 0,
    tool_use: 1,
    text: 2,
    other: 3,
  });

/**
 * I-56: buffer chunks during a stream; on `finish()` reorder them
 * into canonical order (reasoning → tool_use → text → other) and
 * report whether any reorder actually occurred. Callers emit
 * `warning:'stream_chunk_reordered'` with the provider + count when
 * the reorder flag is set.
 *
 * The reorder is stable within each kind — relative order of two
 * reasoning chunks is preserved, same for tool_use, same for text.
 * This matches codex's stream-parser behaviour (stable sort).
 */
export class StreamChunkReorderBuffer<T = unknown> {
  private buffered: StreamChunkReorderEntry<T>[] = [];

  push(entry: StreamChunkReorderEntry<T>): void {
    this.buffered.push(entry);
  }

  /**
   * Finalize the buffer. Returns the reordered chunks + a
   * `reordered: boolean` diagnostic flag + per-kind count.
   */
  finish(): {
    readonly chunks: ReadonlyArray<StreamChunkReorderEntry<T>>;
    readonly reordered: boolean;
    readonly countsByKind: Readonly<Record<StreamChunkKind, number>>;
  } {
    const original = [...this.buffered];
    const sorted = [...this.buffered]
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const diff =
          CHUNK_KIND_ORDER[a.entry.kind] - CHUNK_KIND_ORDER[b.entry.kind];
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map((x) => x.entry);
    this.buffered = [];
    const reordered = original.some((entry, i) => entry !== sorted[i]);
    const countsByKind: Record<StreamChunkKind, number> = {
      reasoning: 0,
      tool_use: 0,
      text: 0,
      other: 0,
    };
    for (const entry of sorted) countsByKind[entry.kind] += 1;
    return { chunks: sorted, reordered, countsByKind };
  }

  get size(): number {
    return this.buffered.length;
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-77 · Model output UI-spoof sanitization
// ─────────────────────────────────────────────────────────────────────

/**
 * Patterns the model should never be allowed to emit verbatim — they
 * mimic real AgenC TUI approval modals and trick reflexive user input.
 *
 * Extend here if new UI chrome is added that the model could plausibly
 * replicate.
 */
const UI_SPOOF_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> =
  [
    { label: "approval_required", re: /\[Approval Required\]/i },
    { label: "allow_deny", re: /\[Allow\s*\/\s*Deny\]/i },
    { label: "yes_no", re: /\[Yes\s*\/\s*No\](\s*:)?/i },
    { label: "agenc_prompt", re: /^\s*agenc\s*[>:]\s/im },
    // ANSI CSI sequences (colour / cursor control) — the TUI has no
    // reason to accept these in plaintext assistant output.
    // eslint-disable-next-line no-control-regex
    { label: "ansi_csi", re: /\x1B\[[0-9;]*[A-Za-z]/ },
  ];

export interface SanitizeModelOutputResult {
  /** The text to display / inject into history. */
  readonly text: string;
  /** True when at least one pattern matched. */
  readonly spoofed: boolean;
  /** Matched-pattern labels for telemetry. */
  readonly matches: ReadonlyArray<string>;
}

export interface SanitizeModelOutputOptions {
  /**
   * Strict mode — when true, matched patterns are removed entirely
   * from the output. When false (default), the text is prefixed with
   * a visible `[MODEL OUTPUT]` marker and the caller is expected to
   * render it in a distinct TUI colour.
   */
  readonly strict?: boolean;
}

const SPOOF_PREFIX = "[MODEL OUTPUT] ";

/**
 * I-77: scan `text` for UI-spoof patterns. Returns the possibly-
 * rewritten text + a diagnostic flag. The consumer (phase-5 or TUI)
 * emits `warning:'model_ui_spoof_pattern'` with the `matches[]`
 * array when `spoofed` is true.
 *
 * Idempotent — re-sanitizing a sanitized output is a no-op.
 */
export function sanitizeModelOutput(
  text: string,
  options: SanitizeModelOutputOptions = {},
): SanitizeModelOutputResult {
  if (text.length === 0) {
    return { text, spoofed: false, matches: [] };
  }
  const matches: string[] = [];
  let cleaned = text;
  for (const { label, re } of UI_SPOOF_PATTERNS) {
    if (re.test(cleaned)) {
      matches.push(label);
      if (options.strict) {
        cleaned = cleaned.replace(new RegExp(re, re.flags + "g"), "");
      }
    }
  }
  if (matches.length === 0) {
    return { text, spoofed: false, matches: [] };
  }
  if (options.strict) {
    return { text: cleaned, spoofed: true, matches };
  }
  // Prefix once; idempotent check on already-prefixed strings.
  if (cleaned.startsWith(SPOOF_PREFIX)) {
    return { text: cleaned, spoofed: true, matches };
  }
  return {
    text: `${SPOOF_PREFIX}${cleaned}`,
    spoofed: true,
    matches,
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-54 · Tool-call schema validation before execution
// ─────────────────────────────────────────────────────────────────────

/**
 * I-54 result: valid calls pass through; malformed calls surface via
 * the `failures` array with a structured cause. Caller (phase-5)
 * emits `stream_error{cause:'malformed_tool_call'}` per failure and
 * forwards valid calls to the StreamingToolExecutor.
 */
export interface ValidatedToolCallBatch {
  readonly valid: ReadonlyArray<LLMToolCall>;
  readonly failures: ReadonlyArray<{
    readonly raw: unknown;
    readonly cause: string;
  }>;
}

/**
 * Validate a batch of tool_use blocks before injection into the
 * executor. Uses the existing `validateToolCallDetailed` from
 * `llm/types.ts` as the shape-check primitive.
 *
 * Source-of-truth for the shape: `{id:string, name:string, arguments:string}`.
 * Failures are returned (not thrown) so the caller can partially
 * succeed — valid calls still run, malformed ones become typed errors.
 */
export function validateToolCallsForExecution(
  raw: ReadonlyArray<unknown>,
): ValidatedToolCallBatch {
  const valid: LLMToolCall[] = [];
  const failures: Array<{ raw: unknown; cause: string }> = [];
  for (const item of raw) {
    const result = validateToolCallDetailed(item);
    if (result.toolCall) {
      valid.push(result.toolCall);
    } else {
      failures.push({
        raw: item,
        cause: result.failure?.code ?? "invalid_shape",
      });
    }
  }
  return { valid, failures };
}
