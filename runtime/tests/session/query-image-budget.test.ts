import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  boundContextImageBytes,
  CONTEXT_IMAGE_BUDGET_ENV,
  DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES,
  OMITTED_IMAGE_TEXT,
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

  test("keeps the newest images up to half the budget and replaces the rest", () => {
    const messages = [image(1000, "one"), image(1000, "two"), image(1000, "three"), image(1000, "four")];
    const bounded = boundContextImageBytes(messages, 3000);
    // 4000 > 3000: keep newest up to 1500 bytes = one image ("four").
    expect(bounded.omitted).toBe(3);
    expect(bounded.retainedBytes).toBe(1000);
    const texts = bounded.messages.map((message) =>
      (message.content as Array<{ type: string; text?: string }>).map((part) => part.type === "text" ? part.text : "IMG").join("|"),
    );
    expect(texts).toEqual([
      `one|${OMITTED_IMAGE_TEXT}`,
      `two|${OMITTED_IMAGE_TEXT}`,
      `three|${OMITTED_IMAGE_TEXT}`,
      "four|IMG",
    ]);
    // Untouched messages keep their identity; replaced ones are copies.
    expect(bounded.messages[3]).toBe(messages[3]);
    expect(bounded.messages[0]).not.toBe(messages[0]);
    expect((messages[0]!.content as unknown[]).length).toBe(2);
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
