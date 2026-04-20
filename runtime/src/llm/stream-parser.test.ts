import { describe, expect, test } from "vitest";
import {
  CitationStreamParser,
  ProposedPlanStreamParser,
  extractProposedPlanText,
  sanitizeModelOutput,
  StreamChunkReorderBuffer,
  stripCitations,
  stripProposedPlanBlocks,
  validateToolCallsForExecution,
} from "./stream-parser.js";

describe("stream-parser", () => {
  test("stripCitations removes inline citation tags", () => {
    const { visibleText, citations } = stripCitations(
      "a<oai-mem-citation>one</oai-mem-citation>b<oai-mem-citation>two</oai-mem-citation>c",
    );
    expect(visibleText).toBe("abc");
    expect([...citations]).toEqual(["one", "two"]);
  });

  test("stripCitations auto-closes unterminated tag at EOF", () => {
    const { visibleText, citations } = stripCitations("x<oai-mem-citation>y");
    expect(visibleText).toBe("x");
    expect([...citations]).toEqual(["y"]);
  });

  test("stripProposedPlanBlocks removes plan blocks", () => {
    const text = "pre<proposed_plan>inner</proposed_plan>post";
    expect(stripProposedPlanBlocks(text)).toBe("prepost");
    expect([...extractProposedPlanText(text)]).toEqual(["inner"]);
  });

  test("CitationStreamParser handles tag split across chunks", () => {
    const parser = new CitationStreamParser();
    const a = parser.pushStr("Hello <oai-mem-");
    const b = parser.pushStr("citation>source A</oai-mem-");
    const c = parser.pushStr("citation> world");
    const tail = parser.finish();
    const visible =
      a.visibleText + b.visibleText + c.visibleText + tail.visibleText;
    const extracted = [...a.extracted, ...b.extracted, ...c.extracted, ...tail.extracted];
    expect(visible).toBe("Hello  world");
    expect(extracted.map((e) => e.content)).toEqual(["source A"]);
  });

  test("ProposedPlanStreamParser emits extracted plan content across chunks", () => {
    const parser = new ProposedPlanStreamParser();
    const a = parser.pushStr("head<proposed_plan>step ");
    const b = parser.pushStr("one</proposed_plan>tail");
    const tail = parser.finish();
    const visible = a.visibleText + b.visibleText + tail.visibleText;
    expect(visible).toBe("headtail");
    const extracted = [...a.extracted, ...b.extracted].map((e) => e.content);
    expect(extracted).toEqual(["step one"]);
  });
});

describe("I-56 StreamChunkReorderBuffer", () => {
  test("reorders out-of-order chunks to canonical order", () => {
    const buf = new StreamChunkReorderBuffer<string>();
    buf.push({ kind: "text", chunk: "T1" });
    buf.push({ kind: "tool_use", chunk: "Tu1" });
    buf.push({ kind: "reasoning", chunk: "R1" });
    buf.push({ kind: "text", chunk: "T2" });
    buf.push({ kind: "tool_use", chunk: "Tu2" });
    const { chunks, reordered, countsByKind } = buf.finish();
    expect(reordered).toBe(true);
    expect(chunks.map((c) => c.chunk)).toEqual(["R1", "Tu1", "Tu2", "T1", "T2"]);
    expect(countsByKind).toEqual({ reasoning: 1, tool_use: 2, text: 2, other: 0 });
  });

  test("already-canonical stream reports reordered=false", () => {
    const buf = new StreamChunkReorderBuffer<string>();
    buf.push({ kind: "reasoning", chunk: "R" });
    buf.push({ kind: "tool_use", chunk: "Tu" });
    buf.push({ kind: "text", chunk: "T" });
    const { reordered } = buf.finish();
    expect(reordered).toBe(false);
  });

  test("stable within kind — preserves relative order of same-kind chunks", () => {
    const buf = new StreamChunkReorderBuffer<string>();
    buf.push({ kind: "text", chunk: "first" });
    buf.push({ kind: "reasoning", chunk: "reason" });
    buf.push({ kind: "text", chunk: "second" });
    const { chunks } = buf.finish();
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.chunk);
    expect(texts).toEqual(["first", "second"]);
  });
});

describe("I-77 sanitizeModelOutput", () => {
  test("plain text passes through unchanged", () => {
    const out = sanitizeModelOutput("hello world");
    expect(out.spoofed).toBe(false);
    expect(out.text).toBe("hello world");
  });

  test("[Approval Required] pattern prefixes with marker", () => {
    const out = sanitizeModelOutput(
      "[Approval Required] Run bash? [y/n]",
    );
    expect(out.spoofed).toBe(true);
    expect(out.text.startsWith("[MODEL OUTPUT] ")).toBe(true);
    expect(out.matches).toContain("approval_required");
  });

  test("strict mode removes the pattern", () => {
    const out = sanitizeModelOutput("[Approval Required] something", {
      strict: true,
    });
    expect(out.spoofed).toBe(true);
    expect(out.text.includes("Approval Required")).toBe(false);
  });

  test("ANSI CSI sequences detected", () => {
    const out = sanitizeModelOutput("text\x1B[31mRED\x1B[0m more");
    expect(out.spoofed).toBe(true);
    expect(out.matches).toContain("ansi_csi");
  });

  test("idempotent — already prefixed text doesn't double-prefix", () => {
    const first = sanitizeModelOutput("[Allow/Deny] test");
    const second = sanitizeModelOutput(first.text);
    // Second pass may still detect (we retained the pattern); but the
    // prefix is not duplicated.
    const prefixCount = (second.text.match(/\[MODEL OUTPUT\]/g) ?? []).length;
    expect(prefixCount).toBe(1);
  });
});

describe("I-54 validateToolCallsForExecution", () => {
  test("valid calls pass through", () => {
    const batch = validateToolCallsForExecution([
      { id: "c1", name: "tool1", arguments: "{}" },
      { id: "c2", name: "tool2", arguments: "{}" },
    ]);
    expect(batch.valid).toHaveLength(2);
    expect(batch.failures).toHaveLength(0);
  });

  test("malformed calls land in failures array", () => {
    const batch = validateToolCallsForExecution([
      { id: "c1", name: "tool1", arguments: "{}" },
      { id: "", name: "tool2", arguments: "{}" },
      { id: "c3", name: "tool3", arguments: 12345 },
      null,
    ]);
    expect(batch.valid).toHaveLength(1);
    expect(batch.failures.length).toBeGreaterThanOrEqual(2);
    // Each failure has a structured cause.
    for (const f of batch.failures) {
      expect(f.cause).toMatch(/invalid|missing|non_string|non_object/);
    }
  });
});
