import { describe, expect, test } from "vitest";

import {
  maxCharsForTokens,
  truncateHeadTailTogether,
} from "./head-tail-buffer.js";

const OMITTED_MARKER = /\n\[\.\.\. omitted \d+ chars \.\.\.\]\n/;

describe("maxCharsForTokens", () => {
  test("budgets 10,000 tokens when max_output_tokens is unset or not finite", () => {
    expect(maxCharsForTokens(undefined)).toBe(40_000);
    expect(maxCharsForTokens(Number.NaN)).toBe(40_000);
  });

  test("honors an explicit budget of at least one token", () => {
    expect(maxCharsForTokens(500.9)).toBe(2_000);
    expect(maxCharsForTokens(0)).toBe(4);
  });

  test("clamps an explicit budget to the 25,000-token ceiling", () => {
    expect(maxCharsForTokens(25_000)).toBe(100_000);
    expect(maxCharsForTokens(1_000_000)).toBe(100_000);
  });
});

describe("truncateHeadTailTogether", () => {
  test("returns texts that fit the budget unchanged", () => {
    expect(truncateHeadTailTogether(["out", "err"], 64)).toEqual([
      { text: "out", truncated: false, originalChars: 3 },
      { text: "err", truncated: false, originalChars: 3 },
    ]);
  });

  test("splits the budget evenly between two long texts, each keeping head and tail", () => {
    const [stdout, stderr] = truncateHeadTailTogether(
      [
        `OUT_HEAD${"o".repeat(10_000)}OUT_TAIL`,
        `ERR_HEAD${"e".repeat(10_000)}ERR_TAIL`,
      ],
      4_000,
    );

    expect(stdout.text.length + stderr.text.length).toBe(4_000);
    expect(stdout.text.length).toBe(2_000);
    expect(stdout).toMatchObject({ truncated: true, originalChars: 10_016 });
    expect(stdout.text).toMatch(/^OUT_HEAD[^]*OUT_TAIL$/);
    expect(stdout.text).toMatch(OMITTED_MARKER);
    expect(stderr).toMatchObject({ truncated: true, originalChars: 10_016 });
    expect(stderr.text).toMatch(/^ERR_HEAD[^]*ERR_TAIL$/);
    expect(stderr.text).toMatch(OMITTED_MARKER);
  });

  test("keeps a short text whole and gives its unused share to the long one", () => {
    const summary = "error: 3 of 120 tests failed";
    const [stdout, stderr] = truncateHeadTailTogether(
      ["o".repeat(10_000), summary],
      4_000,
    );

    expect(stderr).toEqual({
      text: summary,
      truncated: false,
      originalChars: summary.length,
    });
    expect(stdout.truncated).toBe(true);
    expect(stdout.text.length).toBe(4_000 - summary.length);
  });

  test("gives an empty text no share of the budget", () => {
    const [stdout, stderr] = truncateHeadTailTogether(
      ["o".repeat(10_000), ""],
      4_000,
    );

    expect(stdout.text.length).toBe(4_000);
    expect(stderr).toEqual({ text: "", truncated: false, originalChars: 0 });
  });

  test("keeps at least 64 chars of each text under a smaller budget", () => {
    // 20 chars each: a 60-char text stays whole instead of being cut around
    // a marker that would report a negative omitted count.
    const [short, long] = truncateHeadTailTogether(
      ["s".repeat(60), "l".repeat(1_000)],
      40,
    );

    expect(short).toEqual({
      text: "s".repeat(60),
      truncated: false,
      originalChars: 60,
    });
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(64);
    expect(long.text).toMatch(OMITTED_MARKER);
  });
});
