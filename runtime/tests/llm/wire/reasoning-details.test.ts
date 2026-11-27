import { describe, expect, it } from "vitest";

import {
  ReasoningDetailsAccumulator,
  decodeReasoningDetailsReplay,
  encodeReasoningDetailsReplay,
} from "../../../src/llm/wire/reasoning-details.js";

/**
 * OpenRouter and Venice GPT tool-continuations replay `reasoning_details`
 * through an opaque envelope on `providerReasoningContent`. The gateway
 * family suite checks the happy path on the wire. These cases lock the
 * shared contract the wire does not name: only compact tagged JSON
 * round-trips, items without a string `type` never enter the envelope,
 * pretty-printed or plain reasoning text is refused, and a type change
 * at the same index replaces the item instead of merging it.
 */

const SUMMARY = {
  type: "reasoning.summary",
  summary: "**Plan** read the file",
  format: "openai-responses-v1",
  index: 0,
};
const ENCRYPTED = {
  type: "reasoning.encrypted",
  data: "gAAAA-opaque",
  format: "openai-responses-v1",
  id: "rs_1",
  index: 1,
};

describe("encodeReasoningDetailsReplay", () => {
  it("keeps typed items in a compact envelope and drops everything else", () => {
    expect(encodeReasoningDetailsReplay([SUMMARY, ENCRYPTED])).toBe(
      JSON.stringify({ reasoning_details: [SUMMARY, ENCRYPTED] }),
    );
    expect(encodeReasoningDetailsReplay([SUMMARY, { no: "type" }, "skip"])).toBe(
      JSON.stringify({ reasoning_details: [SUMMARY] }),
    );
    expect(encodeReasoningDetailsReplay([])).toBeUndefined();
    expect(encodeReasoningDetailsReplay({ type: "reasoning.summary" })).toBeUndefined();
    expect(encodeReasoningDetailsReplay(undefined)).toBeUndefined();
  });
});

describe("decodeReasoningDetailsReplay", () => {
  it("reads only the compact envelope encode writes", () => {
    const encoded = encodeReasoningDetailsReplay([SUMMARY, ENCRYPTED]);
    expect(decodeReasoningDetailsReplay(encoded)).toEqual([SUMMARY, ENCRYPTED]);
    expect(decodeReasoningDetailsReplay(undefined)).toBeUndefined();
    expect(decodeReasoningDetailsReplay("**Plan** read the file")).toBeUndefined();
    expect(decodeReasoningDetailsReplay("{not-json")).toBeUndefined();
    expect(decodeReasoningDetailsReplay(JSON.stringify({ reasoning_details: [] }))).toBeUndefined();
    expect(
      decodeReasoningDetailsReplay(JSON.stringify({ reasoning_details: [{ no: "type" }] })),
    ).toBeUndefined();
    expect(
      decodeReasoningDetailsReplay(
        JSON.stringify({ reasoning_details: [SUMMARY, { no: "type" }] }),
      ),
    ).toBeUndefined();
    // JSON.stringify pretty-print puts a space after `{` and fails the prefix.
    expect(
      decodeReasoningDetailsReplay(JSON.stringify({ reasoning_details: [SUMMARY] }, null, 2)),
    ).toBeUndefined();
  });
});

describe("ReasoningDetailsAccumulator", () => {
  it("replaces an item when the same index changes type", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push([{ type: "reasoning.summary", summary: "old", index: 0 }]);
    acc.push([{ type: "reasoning.encrypted", data: "gAAAA", index: 0 }]);
    expect(acc.items()).toEqual([{ type: "reasoning.encrypted", data: "gAAAA", index: 0 }]);
  });

  it("assigns a sequential index when Venice sends the index as a string", () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.push([{ type: "reasoning.encrypted", data: "g", format: "openai-responses-v1", index: "0" }]);
    acc.push([{ type: "reasoning.encrypted", data: "AAAA", format: "openai-responses-v1", index: 0 }]);
    expect(acc.size).toBe(1);
    expect(acc.items()).toEqual([{
      type: "reasoning.encrypted",
      data: "gAAAA",
      format: "openai-responses-v1",
      index: "0",
    }]);
  });
});
