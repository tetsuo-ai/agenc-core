import { describe, expect, it } from "vitest";

import {
  IncrementalTracker,
  type IncrementalRequestShape,
} from "../../../../src/llm/providers/grok/incremental.js";
import type { LLMMessage } from "../../../../src/llm/types.js";

const SHAPE: IncrementalRequestShape = {
  model: "grok-4-fast",
  parallelToolCalls: true,
};

function user(content: string): LLMMessage {
  return { role: "user", content };
}

function assistant(content: string): LLMMessage {
  return { role: "assistant", content };
}

function system(content: string): LLMMessage {
  return { role: "system", content };
}

function primed(
  input: readonly LLMMessage[],
  extras?: {
    readonly shape?: IncrementalRequestShape;
    readonly itemsAdded?: readonly LLMMessage[];
    readonly trailingInstructions?: string;
  },
): IncrementalTracker {
  const tracker = new IncrementalTracker();
  tracker.recordRequest(extras?.shape ?? SHAPE, input);
  if (extras?.itemsAdded !== undefined || extras?.trailingInstructions !== undefined) {
    tracker.recordResponse({
      previousResponseId: "resp_1",
      itemsAdded: extras.itemsAdded ?? [assistant("hi")],
      recordedAtMs: 1,
      ...(extras.trailingInstructions !== undefined
        ? { trailingInstructions: extras.trailingInstructions }
        : {}),
    });
  }
  return tracker;
}

describe("IncrementalTracker", () => {
  it("sends a full request before any baseline exists", () => {
    expect(
      new IncrementalTracker().decide({ currentShape: SHAPE, currentInput: [user("hello")] }),
    ).toEqual({ kind: "full", reason: "no_previous_request" });
  });

  it.each([
    ["model", { ...SHAPE, model: "grok-4.6" }],
    ["tools", { ...SHAPE, tools: [{ name: "web_search" }] }],
    ["extra knobs", { ...SHAPE, extra: { temperature: 0 } }],
    ["parallel tool calls", { ...SHAPE, parallelToolCalls: false }],
  ] as const)("refuses to reuse after a %s change", (_label, shape) => {
    const tracker = primed([user("hello")]);
    expect(
      tracker.decide({ currentShape: shape, currentInput: [user("hello"), user("again")] }),
    ).toEqual({ kind: "full", reason: "request_shape_mismatch" });
  });

  it("reuses only the messages after the stored baseline", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), assistant("hi"), user("follow up")],
      }),
    ).toEqual({ kind: "reuse", delta: [user("follow up")] });
  });

  it("treats a compacted or rewritten prefix as a full request (I-2)", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("summary of earlier turns"), user("follow up")],
      }),
    ).toEqual({ kind: "full", reason: "baseline_not_prefix" });
  });

  it("does not treat a matching prefix with no new items as incremental", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), assistant("hi")],
      }),
    ).toEqual({ kind: "full", reason: "empty_delta_not_allowed" });
  });

  it("allows an empty delta only when the caller opts in", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), assistant("hi")],
        allowEmptyDelta: true,
      }),
    ).toEqual({ kind: "reuse", delta: [] });
  });

  it("cannot take back trailing instructions the stored chain already holds", () => {
    const tracker = primed([user("hello")], {
      itemsAdded: [assistant("hi")],
      trailingInstructions: "Current time: noon",
    });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), assistant("hi"), user("follow up")],
      }),
    ).toEqual({ kind: "full", reason: "trailing_instructions_removed" });
  });

  it("omits unchanged trailing instructions when the delta has other items", () => {
    const noon = "Current time: noon";
    const tracker = primed([user("hello")], {
      itemsAdded: [assistant("hi")],
      trailingInstructions: noon,
    });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [
          user("hello"),
          assistant("hi"),
          user("follow up"),
          system(noon),
        ],
        trailingInstructions: noon,
      }),
    ).toEqual({ kind: "reuse", delta: [user("follow up")] });
  });

  it("keeps unchanged trailing instructions when they are the only new item", () => {
    const noon = "Current time: noon";
    const tracker = primed([user("hello")], {
      itemsAdded: [assistant("hi")],
      trailingInstructions: noon,
    });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), assistant("hi"), system(noon)],
        trailingInstructions: noon,
      }),
    ).toEqual({ kind: "reuse", delta: [system(noon)] });
  });

  it("sends changed trailing instructions as the end of the delta", () => {
    const tracker = primed([user("hello")], {
      itemsAdded: [assistant("hi")],
      trailingInstructions: "Current time: noon",
    });
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [
          user("hello"),
          assistant("hi"),
          user("follow up"),
          system("Current time: one"),
        ],
        trailingInstructions: "Current time: one",
      }),
    ).toEqual({
      kind: "reuse",
      delta: [user("follow up"), system("Current time: one")],
    });
  });

  it("clears only the stored response id so expiry can resend without previous_response_id", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    expect(tracker.previousResponseId()).toBe("resp_1");
    tracker.clearResponseId();
    expect(tracker.previousResponseId()).toBeUndefined();
    expect(
      tracker.decide({
        currentShape: SHAPE,
        currentInput: [user("hello"), user("follow up")],
      }),
    ).toEqual({ kind: "reuse", delta: [user("follow up")] });
  });

  it("resets both the request baseline and the stored response (I-13)", () => {
    const tracker = primed([user("hello")], { itemsAdded: [assistant("hi")] });
    tracker.reset();
    expect(tracker.previousResponseId()).toBeUndefined();
    expect(
      tracker.decide({ currentShape: SHAPE, currentInput: [user("hello")] }),
    ).toEqual({ kind: "full", reason: "no_previous_request" });
  });
});
