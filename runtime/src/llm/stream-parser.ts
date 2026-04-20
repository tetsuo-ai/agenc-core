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
