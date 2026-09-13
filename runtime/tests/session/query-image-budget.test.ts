import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  boundContextImageBytes,
  CONTEXT_IMAGE_BUDGET_ENV,
  DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES,
  OMITTED_IMAGE_TEXT,
  OVERSIZED_IMAGE_TEXT,
  resolveContextImageBudgetBytes,
} from "../../src/session/query-image-budget.js";

function image(bytes: number, label: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: label },
      { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(bytes - 22)}` } },
    ],
  };
}

describe("resolveContextImageBudgetBytes", () => {
  test("defaults, disables on 0, ignores malformed values", () => {
    expect(resolveContextImageBudgetBytes({})).toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
    expect(resolveContextImageBudgetBytes({ [CONTEXT_IMAGE_BUDGET_ENV]: "0" })).toBe(0);
    expect(resolveContextImageBudgetBytes({ [CONTEXT_IMAGE_BUDGET_ENV]: "2048" })).toBe(2048);
    expect(resolveContextImageBudgetBytes({ [CONTEXT_IMAGE_BUDGET_ENV]: "lots" })).toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
    expect(resolveContextImageBudgetBytes({ [CONTEXT_IMAGE_BUDGET_ENV]: "-5" })).toBe(DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES);
  });
});

describe("boundContextImageBytes", () => {
  test("leaves a history under budget untouched", () => {
    const messages = [image(1000, "one"), image(1000, "two")];
    const bounded = boundContextImageBytes(messages, 5000);
    expect(bounded.omitted).toBe(0);
    expect(bounded.messages[0]).toBe(messages[0]);
    expect(bounded.totalBytes).toBe(2000);
  });

  test("a budget of 0 disables bounding", () => {
    const bounded = boundContextImageBytes([image(4000, "one"), image(4000, "two")], 0);
    expect(bounded.omitted).toBe(0);
  });

  test("keeps the newest images up to the full budget and replaces the rest", () => {
    const messages = [image(1000, "one"), image(1000, "two"), image(1000, "three"), image(1000, "four")];
    const bounded = boundContextImageBytes(messages, 3000);
    expect(bounded.omitted).toBe(1);
    expect(bounded.retainedBytes).toBe(3000);
    const texts = bounded.messages.map((message) =>
      (message.content as Array<{ type: string; text?: string }>).map((part) => part.type === "text" ? part.text : "IMG").join("|"),
    );
    expect(texts).toEqual([
      `one|${OMITTED_IMAGE_TEXT}`,
      "two|IMG",
      "three|IMG",
      "four|IMG",
    ]);
    // Untouched messages keep their identity; replaced ones are copies.
    expect(bounded.messages[3]).toBe(messages[3]);
    expect(bounded.messages[0]).not.toBe(messages[0]);
    expect((messages[0]!.content as unknown[]).length).toBe(2);
  });

  test.each([
    { sizes: [3000, 4000], budget: 6000, kept: [1], bytes: 4000 },
    { sizes: [1000, 4000, 3000], budget: 6000, kept: [2], bytes: 3000 },
    { sizes: [1000, 6000], budget: 6000, kept: [1], bytes: 6000 },
    { sizes: [1000, 7000], budget: 6000, kept: [], bytes: 0 },
    { sizes: [1000, 7000, 1000], budget: 6000, kept: [2], bytes: 1000 },
  ])("retains a contiguous newest suffix: $sizes with budget $budget", ({ sizes, budget, kept, bytes }) => {
    const messages = sizes.map((size, index) => image(size, String(index)));
    const original = structuredClone(messages);
    const bounded = boundContextImageBytes(messages, budget);
    const actualKept = bounded.messages.flatMap((message, index) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image_url") ? [index] : [],
    );
    expect(actualKept).toEqual(kept);
    expect(bounded.retainedBytes).toBe(bytes);
    expect(bounded.omitted).toBe(sizes.length - kept.length);
    expect(bounded.totalBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
    for (const [index, size] of sizes.entries()) {
      if (kept.includes(index)) continue;
      expect(bounded.messages[index]!.content).toContainEqual({
        type: "text", text: size > budget ? OVERSIZED_IMAGE_TEXT : OMITTED_IMAGE_TEXT,
      });
    }
    expect(messages).toEqual(original);
  });

  test("does not silently reserve half the budget when reprojecting durable history", () => {
    const history = Array.from({ length: 7 }, (_, index) => image(1000, String(index)));
    const first = boundContextImageBytes(history, 6000);
    const second = boundContextImageBytes([...history, image(1000, "7")], 6000);
    expect([first.retainedBytes, second.retainedBytes]).toEqual([6000, 6000]);
    expect([first.omitted, second.omitted]).toEqual([1, 2]);
  });

  test("uses content order for multiple images in one message without dropping surrounding text", () => {
    const parts = [image(1000, "old"), image(4000, "middle"), image(3000, "new")]
      .flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const bounded = boundContextImageBytes([{ role: "user", content: parts }], 6000);
    const projected = bounded.messages[0]!.content;
    expect(Array.isArray(projected) && projected.map((part) => part.type === "text" ? part.text : "IMG"))
      .toEqual(["old", OMITTED_IMAGE_TEXT, "middle", OMITTED_IMAGE_TEXT, "new", "IMG"]);
    expect(bounded.retainedBytes).toBe(3000);
  });

  test("remote image URLs and text do not count", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
      { role: "tool", content: "x".repeat(10_000), toolCallId: "c1", toolName: "Read" },
      image(500, "shot"),
    ];
    const bounded = boundContextImageBytes(messages, 400);
    expect(bounded.totalBytes).toBe(500);
    expect(bounded.omitted).toBe(1);
    expect(bounded.messages[0]).toBe(messages[0]);
    expect(bounded.messages[1]).toBe(messages[1]);
  });
});
