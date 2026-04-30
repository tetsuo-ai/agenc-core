/**
 * StreamingMessage — renders the in-flight assistant reply for a turn.
 *
 * Wires Wave 2's `useMarkdownStream` to render progressive markdown from the
 * accumulated `assistant_text` chunks, and layers on I-77
 * (UI-spoof sanitization). The goal of I-77 is to keep the model from
 * forging local-UI surfaces in its output — prompts like `[Approval: …]`,
 * `[Allow/Deny]`, bare ANSI escapes, or "Press Enter to approve" strings
 * that might trick the operator into believing AgenC itself is asking for
 * confirmation.
 *
 * When a spoof pattern is detected we:
 *   1. Wrap the offending substring with a visible marker so the operator
 *      can see that *the model* typed it, not the runtime.
 *   2. Frame the whole message block with a "[MODEL OUTPUT]" label so the
 *      boundary is unambiguous on the screen.
 *   3. Emit a one-shot `warning:model_ui_spoof_pattern` event on the
 *      session (if one was passed via props or context) so downstream
 *      observability gets a record — subsequent renders with the same
 *      string suppress re-emission.
 *
 * The I-77 scanner itself is pure/stateless (`scanForUISpoof`) and lives
 * alongside the component so tests can exercise it directly.
 *
 * @module
 */

import React, { useEffect, useMemo, useRef } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { Markdown, StreamingMarkdown } from "../components/Markdown.js";
import { neutralizeControlCharsForDisplay } from "./sanitize.js";

/* ────────────────────────────────────────────────────────────────────── */
/* Pure scanner                                                            */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Ordered list of I-77 spoof patterns. Each entry carries a human-readable
 * label (used in `patterns[]` and in the warning event) plus a regex that
 * matches the raw text the model produced. Regexes are intentionally
 * anchored to real surface patterns — conservative by design so we don't
 * false-positive on benign markdown.
 *
 * The label string is stable across renders: downstream consumers (event
 * bus, tests) match on it.
 */
interface SpoofPattern {
  readonly label: string;
  readonly regex: RegExp;
}

const SPOOF_PATTERNS: readonly SpoofPattern[] = [
  // `[Approval` (any case). The task spec lists this as its own pattern
  // separate from `[Allow/Deny]`; keeping the match tight to `[Approval`
  // (plus an optional trailing `:`) lets nested prompts like
  // `[Approval: Yes/No]` fire BOTH approval-bracket AND yes-no.
  { label: "approval-bracket", regex: /\[Approval:?/gi },
  // Explicit `[Allow/Deny]` choice bracket.
  { label: "allow-deny", regex: /\[Allow\/Deny\]/gi },
  // `[Yes/No]:` or a bare `Yes/No` choice prompt tail. The task spec
  // anchors on `[Yes/No]:` but the same token is also commonly emitted
  // as `Yes/No]` inside a larger approval bracket (e.g. `[Approval:
  // Yes/No]`) — match both. `\bYes\/No\b` keeps false-positives down
  // while still firing on both variants.
  { label: "yes-no", regex: /\bYes\/No\b\]?:?/gi },
  // `[Continue/Cancel]` prompt.
  { label: "continue-cancel", regex: /\[Continue\/Cancel\]/gi },
  // Raw ANSI CSI (ESC[) and OSC (ESC]) escape sequences. The model should
  // never emit raw ANSI in a chat message — the renderer owns color.
  // Match ESC in both its literal 0x1B form and the common text-encoded
  // `\x1b[` / `\u001b[` representations that sneak in via code blocks.
  {
    label: "ansi-escape",
    // eslint-disable-next-line no-control-regex
    regex:
      /(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\\x1b\[[0-9;?]*[A-Za-z]|\\u001b\[[0-9;?]*[A-Za-z])/g,
  },
  // "Enter to approve" / "Press Enter" / "Press Y" style prompt spoofs.
  { label: "press-enter-approve", regex: /Enter to approve/gi },
  { label: "press-enter", regex: /Press Enter/gi },
  { label: "press-y", regex: /Press Y\b/gi },
];

/**
 * Ink-style tag used to highlight matched spoof substrings. The `{bad:…}`
 * wrapper is invisible to the scanner's own regexes (different character
 * class) and keeps the sanitized string safe for substring search in tests
 * without needing access to ANSI state.
 *
 * The markup style here is deliberately our own mini-language (not real
 * Ink children); consumers render the sanitized string verbatim inside a
 * `<Text>` and the frame chrome + color comes from the component, not the
 * sanitized content. Tests just assert the marker tokens are present.
 */
const BAD_OPEN = "{bad:";
const BAD_CLOSE = "}";

export interface SpoofScanResult {
  readonly hasSpoof: boolean;
  readonly patterns: readonly string[];
  readonly sanitized: string;
}

/**
 * Pure scanner. No side effects — callers are responsible for any event
 * emission. Returns `hasSpoof=false` and the original string verbatim
 * when nothing matches.
 */
export function scanForUISpoof(content: string): SpoofScanResult {
  if (typeof content !== "string" || content.length === 0) {
    return { hasSpoof: false, patterns: [], sanitized: content ?? "" };
  }

  // Collect all match spans across every pattern, then fold them down into
  // a non-overlapping ordered list so we only wrap each character once
  // even if two patterns overlap (e.g. `[Approval: Yes/No]` matches both
  // `approval-bracket` and `yes-no`).
  interface Span {
    readonly start: number;
    readonly end: number;
    readonly label: string;
  }
  const spans: Span[] = [];
  const matchedLabels = new Set<string>();

  for (const pattern of SPOOF_PATTERNS) {
    // Fresh regex state per scan — the shared lastIndex from prior calls
    // would otherwise skip matches.
    const rx = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) {
      if (m[0].length === 0) {
        // Defensive: a zero-width match would spin forever.
        rx.lastIndex += 1;
        continue;
      }
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        label: pattern.label,
      });
      matchedLabels.add(pattern.label);
    }
  }

  if (spans.length === 0) {
    return { hasSpoof: false, patterns: [], sanitized: content };
  }

  // Sort by start, then merge overlaps. When two spans overlap we keep the
  // outer span but remember both labels so `patterns[]` is complete.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) {
        merged[merged.length - 1] = {
          start: last.start,
          end: span.end,
          label: last.label,
        };
      }
      continue;
    }
    merged.push(span);
  }

  // Walk the string and wrap each merged span with the highlight markers.
  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += content.slice(cursor, span.start);
    out += `${BAD_OPEN}${content.slice(span.start, span.end)}${BAD_CLOSE}`;
    cursor = span.end;
  }
  out += content.slice(cursor);

  return {
    hasSpoof: true,
    patterns: Array.from(matchedLabels),
    sanitized: out,
  };
}

/* ────────────────────────────────────────────────────────────────────── */
/* Component                                                               */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * Minimum session surface needed to emit the I-77 warning. Any object
 * carrying an `emitEvent` method whose first positional arg is the event
 * name qualifies — keeping it structural so tests can substitute a tiny
 * spy without constructing a full runtime `Session`.
 */
export interface WarningEmittingSession {
  readonly emitEvent?: (
    name: string,
    payload?: Record<string, unknown>,
  ) => void;
}

export interface StreamingMessageProps {
  /** Accumulated assistant_text chunks joined into a single string. */
  readonly content: string;
  /** True once `turn_complete` has landed for this message's turn. */
  readonly isComplete?: boolean;
  /**
   * Optional session handle used for the I-77 warning emission. When
   * absent the component still renders the sanitized frame; only the
   * side-channel warning is skipped.
   */
  readonly session?: WarningEmittingSession;
}

/**
 * Split a sanitized string (containing `{bad:…}` markers) into an array of
 * `<Text>` children that mix normal and red-highlighted spans. The markers
 * never nest, so a single linear pass is sufficient.
 */
function renderSanitized(sanitized: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let keyIndex = 0;
  while (cursor < sanitized.length) {
    const open = sanitized.indexOf(BAD_OPEN, cursor);
    if (open === -1) {
      nodes.push(
        <Text key={`plain-${keyIndex++}`}>{sanitized.slice(cursor)}</Text>,
      );
      break;
    }
    if (open > cursor) {
      nodes.push(
        <Text key={`plain-${keyIndex++}`}>
          {sanitized.slice(cursor, open)}
        </Text>,
      );
    }
    const close = sanitized.indexOf(BAD_CLOSE, open + BAD_OPEN.length);
    if (close === -1) {
      // Unclosed marker — treat the rest as plain so we never crash the
      // renderer. The sanitizer only ever emits balanced markers, so this
      // branch only fires if upstream code mutated the string.
      nodes.push(
        <Text key={`plain-${keyIndex++}`}>{sanitized.slice(open)}</Text>,
      );
      break;
    }
    const highlighted = sanitized.slice(open + BAD_OPEN.length, close);
    nodes.push(
      <Text key={`bad-${keyIndex++}`} color="red" inverse>
        {highlighted}
      </Text>,
    );
    cursor = close + BAD_CLOSE.length;
  }
  return nodes;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({
  content,
  isComplete = false,
  session,
}) => {
  const scan = useMemo(() => scanForUISpoof(content), [content]);
  const safeSanitizedDisplay = useMemo(
    () => neutralizeControlCharsForDisplay(scan.sanitized),
    [scan.sanitized],
  );

  // One-shot warning emit per distinct matched-pattern set. A snapshot of
  // the set joined by `|` gives us a stable dedupe key so repeated
  // renders with the same matches don't re-fire, but a new pattern in a
  // later chunk does.
  const warnedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scan.hasSpoof || !session?.emitEvent) return;
    const key = scan.patterns.slice().sort().join("|");
    if (warnedKeyRef.current === key) return;
    warnedKeyRef.current = key;
    try {
      session.emitEvent("warning:model_ui_spoof_pattern", {
        patterns: scan.patterns,
      });
    } catch {
      // Never let a flaky emitter crash the UI.
    }
  }, [scan.hasSpoof, scan.patterns, session]);

  const showStreamingMarker = !isComplete;

  if (content.length === 0 && !isComplete) {
    return (
      <Box flexDirection="column">
        <Text dim>{"\u2026"}</Text>
      </Box>
    );
  }

  if (!scan.hasSpoof) {
    return (
      <Box flexDirection="column">
        {isComplete ? (
          <Markdown>{content}</Markdown>
        ) : (
          <StreamingMarkdown>{content}</StreamingMarkdown>
        )}
        {showStreamingMarker ? <Text dim>{"\u2026"}</Text> : null}
      </Box>
    );
  }

  // Spoof detected — frame the content with the neutral "[MODEL OUTPUT]"
  // label so the operator can't be tricked into thinking the runtime
  // itself is asking for approval. Frame chars are deliberately ASCII so
  // they render identically on any terminal the TUI targets.
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box flexDirection="row">
        <Text color="yellow">[MODEL OUTPUT]</Text>
      </Box>
      <Box flexDirection="column">
        <Text>{renderSanitized(safeSanitizedDisplay)}</Text>
        {showStreamingMarker ? <Text dim>{"\u2026"}</Text> : null}
      </Box>
    </Box>
  );
};

export default StreamingMessage;
