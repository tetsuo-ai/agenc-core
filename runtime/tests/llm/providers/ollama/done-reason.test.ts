import { describe, expect, test } from "vitest";
import {
  normalizeOllamaDoneReason,
  ollamaDoneReasonTrace,
  ollamaFinishReason,
} from "../../../../src/llm/providers/ollama/done-reason.js";

describe("normalizeOllamaDoneReason", () => {
  test.each([
    ["length", { rawReason: "length", kind: "mapped", truncated: true, mappedReason: "length" }],
    ["stop", { rawReason: "stop", kind: "mapped", truncated: false, mappedReason: "stop" }],
    ["load", { rawReason: "load", kind: "mapped", truncated: false, mappedReason: "stop" }],
    ["unload", { rawReason: "unload", kind: "mapped", truncated: false, mappedReason: "stop" }],
    ["  length  ", { rawReason: "length", kind: "mapped", truncated: true, mappedReason: "length" }],
  ] as const)("maps known %j", (raw, expected) => {
    expect(normalizeOllamaDoneReason(raw)).toEqual(expected);
  });

  test.each([undefined, null, "", "   ", 12, { reason: "stop" }])(
    "treats %j as a documented missing fallback",
    (raw) => {
      expect(normalizeOllamaDoneReason(raw)).toEqual({
        rawReason: undefined,
        kind: "missing",
        truncated: false,
        mappedReason: "stop",
      });
    },
  );

  test("preserves an unknown non-empty reason instead of mapping it to stop", () => {
    expect(normalizeOllamaDoneReason("future_reason")).toEqual({
      rawReason: "future_reason",
      kind: "unknown",
      truncated: false,
      mappedReason: "error",
    });
  });
});

describe("ollamaFinishReason", () => {
  test("gives truncation precedence over complete-looking tool calls", () => {
    expect(ollamaFinishReason(normalizeOllamaDoneReason("length"), 2)).toBe("length");
  });

  test("keeps natural stop when there are no tool calls", () => {
    expect(ollamaFinishReason(normalizeOllamaDoneReason("stop"), 0)).toBe("stop");
  });

  test("promotes a natural stop to tool_calls when calls are complete", () => {
    expect(ollamaFinishReason(normalizeOllamaDoneReason("stop"), 1)).toBe("tool_calls");
  });

  test("promotes a missing reason to tool_calls rather than inventing truncation", () => {
    expect(ollamaFinishReason(normalizeOllamaDoneReason(undefined), 1)).toBe("tool_calls");
  });

  test("does not execute tools when the reason is unknown", () => {
    expect(ollamaFinishReason(normalizeOllamaDoneReason("future_reason"), 1)).toBe("error");
  });
});

describe("ollamaDoneReasonTrace", () => {
  test("includes the mapped reason without a fallback field", () => {
    expect(ollamaDoneReasonTrace(normalizeOllamaDoneReason("length"))).toEqual({
      done_reason: "length",
      done_reason_kind: "mapped",
    });
  });

  test("documents the missing-reason fallback", () => {
    expect(ollamaDoneReasonTrace(normalizeOllamaDoneReason(undefined))).toEqual({
      done_reason: null,
      done_reason_kind: "missing",
      done_reason_fallback: "stop",
    });
  });

  test("preserves the raw unknown reason in diagnostics", () => {
    expect(ollamaDoneReasonTrace(normalizeOllamaDoneReason("future_reason"))).toEqual({
      done_reason: "future_reason",
      done_reason_kind: "unknown",
      done_reason_fallback: "error",
    });
  });
});
