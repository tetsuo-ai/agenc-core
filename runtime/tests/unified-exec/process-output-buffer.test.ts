import { describe, expect, test } from "vitest";

import { ProcessOutputBuffer } from "./process-manager.js";

const CAP = 4096;

describe("ProcessOutputBuffer cap enforcement (audit #9)", () => {
  test("preserves unconsumed HEAD and TAIL on a single oversized burst before drain", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // Emit > cap chars in one window before any drain. Use distinctive
    // sentinels at the very start and very end so we can prove neither end was
    // discarded wholesale.
    const head = "HEAD_SENTINEL_BEGIN";
    const tail = "TAIL_SENTINEL_END";
    const filler = "x".repeat(CAP * 4);
    buffer.append("stdout", `${head}${filler}${tail}`);

    const chunks = buffer.drain();
    const combined = chunks.map((chunk) => chunk.chunk).join("");

    // The previously-buggy implementation dropped the unconsumed head wholesale,
    // leaving only a count marker. Both ends must now survive.
    expect(combined).toContain(head);
    expect(combined).toContain(tail);

    // The explicit omitted-count marker must be present.
    expect(combined).toMatch(/\[\.\.\. omitted \d+ chars \.\.\.\]/);

    // The collected output must respect the cap (plus the inline marker text).
    expect(combined.length).toBeLessThanOrEqual(CAP + 128);
  });

  test("preserves HEAD/TAIL when the oversized burst is split across many appends", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    const head = "FIRST_BYTES_HEAD";
    buffer.append("stdout", head);
    for (let i = 0; i < 200; i += 1) {
      buffer.append("stdout", "y".repeat(64));
    }
    const tail = "LAST_BYTES_TAIL";
    buffer.append("stdout", tail);

    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");

    expect(combined).toContain(head);
    expect(combined).toContain(tail);
    expect(combined).toMatch(/\[\.\.\. omitted \d+ chars \.\.\.\]/);
  });

  test("evicts already-consumed chunks silently without an omitted marker", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // First window: small output that is drained (consumed).
    buffer.append("stdout", "consumed-output\n");
    const firstDrain = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");
    expect(firstDrain).toBe("consumed-output\n");

    // Second window: enough new output to force eviction of the consumed chunk.
    buffer.append("stdout", "z".repeat(CAP));
    const secondDrain = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");

    // Consumed bytes were already delivered, so re-evicting them must NOT emit a
    // "before collection" marker, and the new pending bytes must survive intact.
    expect(secondDrain).not.toContain("omitted");
    expect(secondDrain).toContain("z".repeat(CAP - 100));
  });

  test("does not truncate output that fits within the cap", () => {
    const buffer = new ProcessOutputBuffer(CAP);
    const payload = "small payload that fits";
    buffer.append("stdout", payload);

    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");

    expect(combined).toBe(payload);
    expect(combined).not.toContain("omitted");
  });

  test("keeps the trailing exit-summary visible after a head-heavy burst", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    buffer.append("stdout", "x".repeat(CAP * 3));
    // An exit summary / final line that arrives last must remain in the tail.
    const exitSummary = "process exited with code 0";
    buffer.append("stderr", exitSummary);

    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");

    expect(combined).toContain(exitSummary);
  });

  test("preserves stderr stream label on truncation (not relabeled as stdout)", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // Oversized stdout burst that forces cap enforcement, followed by a stderr
    // exit-summary. The truncated pending region interleaves both streams; the
    // buggy implementation collapsed everything under a hard-coded "stdout"
    // label, silently emptying the returned stderr field.
    buffer.append("stdout", "x".repeat(CAP * 4));
    const errSummary = "ERROR_SUMMARY: process failed with code 2";
    buffer.append("stderr", errSummary);

    const chunks = buffer.drain();

    // The stderr summary must survive in a stderr-labeled chunk, NOT be
    // relabeled as stdout.
    const stderrText = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join("");
    const stdoutText = chunks
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.chunk)
      .join("");

    expect(stderrText).toContain(errSummary);
    expect(stderrText).not.toBe("");
    expect(stdoutText).not.toContain(errSummary);
  });

  test("does not starve a small stderr summary that arrived BEFORE a stdout flood", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // A program that warns to stderr first and THEN floods stdout past the cap.
    // A proportional cap split gives stderr only ~(cap * stderrLen/totalLen)
    // chars — near zero when stdout dwarfs it — truncating away the summary.
    // Max-min fair allocation keeps the small stream intact.
    const errSummary = "WARNING: deprecated flag; process exited with code 0";
    buffer.append("stderr", errSummary);
    buffer.append("stdout", "x".repeat(CAP * 100));

    const chunks = buffer.drain();
    const stderrText = chunks
      .filter((chunk) => chunk.stream === "stderr")
      .map((chunk) => chunk.chunk)
      .join("");

    // The full summary must survive verbatim regardless of arrival order.
    expect(stderrText).toBe(errSummary);
  });

  test("amortizes the pending collapse instead of re-collapsing on every append (M-EXEC-3)", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // Deferred drain (consumedIndex stays 0), the exact hot path: append many
    // small chunks well past the cap without draining. The expensive
    // slice/filter/join/truncateHeadTail collapse must NOT run on every append
    // past the cap — with the 2*cap watermark it runs ~totalChars/cap times.
    const appends = 500;
    for (let i = 0; i < appends; i += 1) {
      buffer.append("stdout", "q".repeat(256));
    }
    // 500*256 = 128000 chars over a 4096 cap. Per-append collapse would fire on
    // essentially every append past the cap (~480); amortized fires ~30 times.
    expect(buffer.collapseCountForTest).toBeLessThan(appends / 4);

    // Behavior preserved: a drain still returns a capped, head/tail-truncated
    // window with an omitted marker.
    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");
    expect(combined.length).toBeLessThanOrEqual(CAP + 128);
    expect(combined).toMatch(/\[\.\.\. omitted \d+ chars \.\.\.\]/);
  });

  test("bounds memory under deferred drain even without ever draining", () => {
    const buffer = new ProcessOutputBuffer(CAP);
    for (let i = 0; i < 1000; i += 1) {
      buffer.append("stdout", "m".repeat(256));
    }
    // Never drained; the pending region must stay bounded (~2*cap), not grow to
    // 256000 chars. Drain and confirm the returned window respects the cap.
    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");
    expect(combined.length).toBeLessThanOrEqual(CAP + 128);
  });

  test("never emits a negative omitted-count marker", () => {
    const buffer = new ProcessOutputBuffer(CAP);

    // A moderately sized stderr stream plus a giant stdout flood. Any per-stream
    // budget passed to truncateHeadTail must be >= its 64-char floor so the
    // reported omitted count can never go negative (e.g. "[... omitted -23 ...]").
    buffer.append("stderr", "e".repeat(200));
    buffer.append("stdout", "x".repeat(CAP * 50));

    const combined = buffer
      .drain()
      .map((chunk) => chunk.chunk)
      .join("");

    expect(combined).not.toMatch(/omitted -\d+/);
    // Any marker that IS present must report a positive count.
    for (const match of combined.matchAll(/omitted (-?\d+) chars/g)) {
      expect(Number(match[1])).toBeGreaterThan(0);
    }
  });
});
