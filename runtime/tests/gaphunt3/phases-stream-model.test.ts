import { afterEach, describe, expect, test, vi } from "vitest";

import { sanitizeModelOutput } from "src/llm/stream-parser";
import type { LLMStreamChunk } from "src/llm/types";
import type { Session } from "src/session/session";
import type { ThinkingDisplayState } from "src/phases/stream-model";

/**
 * Revert-sensitive regression test for gaphunt #3 finding #43.
 *
 * #43 On every streamed delta the old emitSanitizedAssistantDelta /
 *     emitSanitizedThinkingDelta called sanitizeModelOutput over the ENTIRE
 *     accumulated buffer, making total work O(n^2) in the message length. The
 *     fix introduces IncrementalSpoofSanitizer: it finalizes/emits only the
 *     already-settled buffer prefix and carries the unsettled tail, so the
 *     per-chunk sanitize input is bounded (scan is O(n) overall) while the
 *     produced output stays byte-identical to a one-shot sanitize of the full
 *     text.
 *
 * These tests assert both halves: (a) chunked output == one-shot output (the
 * correctness contract), and (b) per-chunk sanitize input is bounded, not
 * growing with accumulated length (the anti-quadratic contract). Both fail if
 * the fix is reverted — the IncrementalSpoofSanitizer symbol disappears and the
 * streaming path reverts to whole-buffer re-sanitization.
 */

// Helper: chunk a string into fixed-size pieces.
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const SAMPLES: ReadonlyArray<string> = [
  "Hello, this is a perfectly normal assistant message with no spoof content.",
  "Continue? [Approval Required] please confirm",
  "Choose one: [Allow / Deny] now",
  "Spread out: [Allow   /   Deny] across spaces",
  "Confirm the action [Yes / No]: right here",
  "line one\nagenc> spoofed prompt\nline three",
  "indented\n   agenc> deep prompt",
  "ansi attack \x1B[31mred text\x1B[0m back to normal",
  "two spoofs [Approval Required] then [Allow / Deny] together",
  "bracket exposure [Approval Required][Allow / Deny]agenc> tail",
  "trailing whitespace run        ",
  "multi\nagenc>\nagenc: ok\n",
];

describe("IncrementalSpoofSanitizer — gaphunt3 #43 (output equality with one-shot)", () => {
  test.each(SAMPLES)(
    "chunked sanitization equals one-shot for %j",
    async (sample) => {
      const { IncrementalSpoofSanitizer } = await import(
        "src/phases/stream-model"
      );
      const expected = sanitizeModelOutput(sample, { strict: true });

      for (const size of [1, 2, 3, 5, 7, sample.length || 1]) {
        const san = new IncrementalSpoofSanitizer();
        let out = "";
        const matches = new Set<string>();
        for (const piece of chunks(sample, size)) {
          const r = san.push(piece);
          out += r.text;
          for (const m of r.newMatches) matches.add(m);
        }
        const f = san.flush();
        out += f.text;
        for (const m of f.newMatches) matches.add(m);

        // (a) The streamed output is byte-identical to the one-shot sanitize.
        expect(out).toBe(expected.text);
        // The deduped spoof labels match the one-shot's matches.
        expect([...matches].sort()).toEqual([...new Set(expected.matches)].sort());
      }
    },
  );

  test("a spoof split across the chunk boundary is still removed", async () => {
    const { IncrementalSpoofSanitizer } = await import(
      "src/phases/stream-model"
    );
    const san = new IncrementalSpoofSanitizer();
    // Feed "[Allow / Deny]" one char at a time so the pattern only completes
    // across many chunk boundaries — the exact case the old per-chunk
    // full-buffer pass handled and a naive incremental scan would leak.
    let out = "";
    const matches = new Set<string>();
    for (const ch of "before [Allow / Deny] after") {
      const r = san.push(ch);
      out += r.text;
      for (const m of r.newMatches) matches.add(m);
    }
    const f = san.flush();
    out += f.text;
    for (const m of f.newMatches) matches.add(m);

    expect(out).toBe("before  after");
    expect(out).not.toContain("[Allow / Deny]");
    expect([...matches]).toContain("allow_deny");
  });

  test("a spoof that ends exactly at end-of-stream is flushed and removed", async () => {
    const { IncrementalSpoofSanitizer } = await import(
      "src/phases/stream-model"
    );
    const san = new IncrementalSpoofSanitizer();
    let out = "";
    // The buffer ends mid-pattern ("[Allow") then completes; nothing after.
    // The held tail must be surfaced (and sanitized) by flush().
    for (const ch of "tail [Allow / Deny]") out += san.push(ch).text;
    out += san.flush().text;
    expect(out).toBe("tail ");
    expect(out).not.toContain("Allow");
  });
});

describe("IncrementalSpoofSanitizer — gaphunt3 #43 (anti-quadratic / bounded scan)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test("per-chunk sanitize input is bounded, not the whole accumulated buffer", async () => {
    // Record the length of every string the underlying sanitizer scans. With
    // the fix each call sees only a settled, bounded segment; the reverted
    // whole-buffer pass would feed inputs that grow linearly with N (making the
    // total O(N^2)).
    const seenLengths: number[] = [];
    vi.resetModules();
    vi.doMock("src/llm/stream-parser", async () => {
      const actual = await vi.importActual<
        typeof import("src/llm/stream-parser")
      >("src/llm/stream-parser");
      return {
        ...actual,
        sanitizeModelOutput: (text: string, options?: unknown) => {
          seenLengths.push(text.length);
          return actual.sanitizeModelOutput(
            text,
            options as { strict?: boolean } | undefined,
          );
        },
      };
    });

    const { IncrementalSpoofSanitizer } = await import(
      "src/phases/stream-model"
    );
    const san = new IncrementalSpoofSanitizer();
    const N = 500;
    // Plain non-spoof text streamed one char at a time. "z" cannot begin any
    // spoof partial, so each char is finalized immediately as a bounded segment.
    for (let i = 0; i < N; i += 1) san.push("z");
    san.flush();

    const maxSeen = Math.max(0, ...seenLengths);
    const totalSeen = seenLengths.reduce((a, b) => a + b, 0);

    // Bounded per-call input — does NOT scale with N (a reverted full-buffer
    // pass would reach ~N here).
    expect(maxSeen).toBeLessThanOrEqual(8);
    // Total characters scanned is O(N), not O(N^2).
    expect(totalSeen).toBeLessThanOrEqual(N * 8);

    vi.doUnmock("src/llm/stream-parser");
  });
});

type EmittedEvent = { id: string; msg: { type: string; payload: unknown } };

function buildSessionStub(): { session: Session; emitted: EmittedEvent[] } {
  let counter = 0;
  const emitted: EmittedEvent[] = [];
  const stub = {
    nextInternalSubId: vi.fn(() => `sub-${++counter}`),
    emit: vi.fn((event: EmittedEvent) => {
      emitted.push(event);
    }),
  };
  return { session: stub as unknown as Session, emitted };
}

describe("emitThinkingChunkEvents — gaphunt3 #43 (incremental thinking sanitization wired)", () => {
  test("a spoof split across thinking deltas is sanitized incrementally and flushed on block stop", async () => {
    const { emitThinkingChunkEvents } = await import("src/phases/stream-model");
    const { session, emitted } = buildSessionStub();
    const displays = new Map<string, ThinkingDisplayState>();

    // Open a thinking block, then stream a UI-spoof pattern one char at a time
    // so it only resolves across deltas, then close the block.
    const text = "thinking [Approval Required] tail";
    emitThinkingChunkEvents(
      { thinkingBlockStart: { index: 0, redacted: false } } as LLMStreamChunk,
      session,
      displays,
    );
    for (const ch of text) {
      emitThinkingChunkEvents(
        { thinkingDelta: { delta: ch, index: 0 } } as LLMStreamChunk,
        session,
        displays,
      );
    }
    emitThinkingChunkEvents(
      { thinkingBlockStop: { index: 0 } } as LLMStreamChunk,
      session,
      displays,
    );

    const deltas = emitted
      .filter((e) => e.msg.type === "assistant_thinking_delta")
      .map((e) => (e.msg.payload as { delta: string }).delta)
      .join("");

    // The concatenated streamed thinking deltas equal the one-shot sanitize:
    // the spoof is fully removed and never partially leaked.
    expect(deltas).toBe(
      sanitizeModelOutput(text, { strict: true }).text,
    );
    expect(deltas).not.toContain("[Approval Required]");

    // A spoof warning was surfaced (once).
    const warnings = emitted.filter(
      (e) =>
        e.msg.type === "warning" &&
        (e.msg.payload as { cause?: string }).cause ===
          "model_ui_spoof_pattern",
    );
    expect(warnings.length).toBe(1);

    // The block_stop is emitted after the flushed tail (ordering preserved).
    const types = emitted.map((e) => e.msg.type);
    expect(types[types.length - 1]).toBe("assistant_thinking_block_stop");
  });
});
