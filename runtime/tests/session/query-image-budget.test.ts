import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  admitContextImageBytes,
  CONTEXT_IMAGE_BUDGET_ENV,
  DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES,
  UNINSPECTED_IMAGE_TEXT,
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

/** Indexes of the messages that still carry an image. */
function keptIndexes(messages: readonly LLMMessage[]): number[] {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "image_url") ? [index] : [],
  );
}

/** One projection per request of a history that gains a 1000-byte screenshot each time. */
function screenshotRequests(count: number, budget: number) {
  const shots = Array.from({ length: count }, (_, index) => image(1000, String(index)));
  return shots.map((_, index) => admitContextImageBytes(shots.slice(0, index + 1), budget));
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

describe("admitContextImageBytes", () => {
  test("leaves a history under budget untouched", () => {
    const messages = [image(1000, "one"), image(1000, "two")];
    const bounded = admitContextImageBytes(messages, 5000);
    expect(bounded.omitted).toBe(0);
    expect(bounded.messages[0]).toBe(messages[0]);
    expect(bounded.totalBytes).toBe(2000);
  });

  test("a budget of 0 disables bounding", () => {
    const bounded = admitContextImageBytes([image(4000, "one"), image(4000, "two")], 0);
    expect(bounded.omitted).toBe(0);
  });

  test("retains earlier images and labels the newest image when the budget fills", () => {
    const messages = [image(1000, "one"), image(1000, "two"), image(1000, "three"), image(1000, "four")];
    const bounded = admitContextImageBytes(messages, 3000);
    expect(bounded.omitted).toBe(1);
    expect(bounded.retainedBytes).toBe(3000);
    const texts = bounded.messages.map((message) =>
      (message.content as Array<{ type: string; text?: string }>).map((part) => part.type === "text" ? part.text : "IMG").join("|"),
    );
    expect(texts).toEqual([
      "one|IMG", "two|IMG", "three|IMG", `four|${UNINSPECTED_IMAGE_TEXT}`,
    ]);
    // Untouched messages keep their identity; replaced ones are copies.
    expect(bounded.messages[0]).toBe(messages[0]);
    expect(bounded.messages[3]).not.toBe(messages[3]);
    expect((messages[0]!.content as unknown[]).length).toBe(2);
  });

  test.each([
    { sizes: [3000, 4000], budget: 6000, kept: [0], bytes: 3000 },
    { sizes: [1000, 4000, 3000], budget: 6000, kept: [0, 1], bytes: 5000 },
    { sizes: [1000, 6000], budget: 6000, kept: [0], bytes: 1000 },
    { sizes: [1000, 7000], budget: 6000, kept: [0], bytes: 1000 },
    { sizes: [1000, 7000, 1000], budget: 6000, kept: [0, 2], bytes: 2000 },
    { sizes: [2000, 2000, 2000, 1000, 1000], budget: 6000, kept: [0, 1, 2], bytes: 6000 },
  ])("admits images without evicting prior entries: $sizes with budget $budget", ({ sizes, budget, kept, bytes }) => {
    const messages = sizes.map((size, index) => image(size, String(index)));
    const original = structuredClone(messages);
    const bounded = admitContextImageBytes(messages, budget);
    expect(keptIndexes(bounded.messages)).toEqual(kept);
    expect(bounded.retainedBytes).toBe(bytes);
    expect(bounded.omitted).toBe(sizes.length - kept.length);
    expect(bounded.totalBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
    for (const index of sizes.keys()) {
      if (kept.includes(index)) continue;
      expect(bounded.messages[index]!.content).toContainEqual({
        type: "text", text: UNINSPECTED_IMAGE_TEXT,
      });
    }
    expect(messages).toEqual(original);
  });

  // Six 1000-byte screenshots fill the budget; later omissions remain stable.
  test("repeats the previous request byte for byte across image pressure", () => {
    const requests = screenshotRequests(12, 6000);
    const repeated = requests.slice(1).map((request, index) => {
      const previous = requests[index]!.messages;
      return JSON.stringify(request.messages.slice(0, previous.length)) === JSON.stringify(previous);
    });
    expect(repeated).toEqual(Array(11).fill(true));
  });

  test("does not evict any admitted image while history grows", () => {
    const requests = screenshotRequests(12, 6000);
    expect(requests.map(({ omitted }) => omitted)).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    expect(requests.map(({ retainedBytes }) => retainedBytes))
      .toEqual([1000, 2000, 3000, 4000, 5000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
    for (const { messages, omitted } of requests) {
      expect(keptIndexes(messages))
        .toEqual(Array.from({ length: messages.length - omitted }, (_, index) => index));
    }
  });

  test("uses content order for multiple images in one message without dropping surrounding text", () => {
    const parts = [image(1000, "old"), image(4000, "middle"), image(3000, "new")]
      .flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const bounded = admitContextImageBytes([{ role: "user", content: parts }], 6000);
    const projected = bounded.messages[0]!.content;
    expect(Array.isArray(projected) && projected.map((part) => part.type === "text" ? part.text : "IMG"))
      .toEqual(["old", "IMG", "middle", "IMG", "new", UNINSPECTED_IMAGE_TEXT]);
    expect(bounded.retainedBytes).toBe(5000);
  });

  test("remote image URLs and text do not count", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
      { role: "tool", content: "x".repeat(10_000), toolCallId: "c1", toolName: "Read" },
      image(500, "shot"),
    ];
    const bounded = admitContextImageBytes(messages, 400);
    expect(bounded.totalBytes).toBe(500);
    expect(bounded.omitted).toBe(1);
    expect(bounded.messages[0]).toBe(messages[0]);
    expect(bounded.messages[1]).toBe(messages[1]);
  });
});

test("first-admission budget names unseen FileRead images and never rewrites earlier admissions", async () => {
  const { admitContextImageBytes } = await import("../../src/session/query-image-budget.js");
  const first = image(1000, "first");
  const second: LLMMessage = { ...image(1000, "second"), role: "tool", toolCallId: "read-current" };
  const call: LLMMessage = { role: "assistant", content: "", toolCalls: [
    { id: "read-current", name: "FileRead", arguments: '{"file_path":"/work/current.png"}' },
  ] };
  const a = admitContextImageBytes([first], 1500);
  const b = admitContextImageBytes([first, call, second], 1500);
  expect(b.messages[0]).toEqual(a.messages[0]);
  expect(b.retainedBytes).toBe(1000);
  expect(JSON.stringify(b.messages[2])).toContain('/work/current.png');
  expect(JSON.stringify(b.messages[2])).toContain('not inspected');
  expect(admitContextImageBytes([first, call, second, image(200, "crop")], 1500).messages.slice(0, 3)).toEqual(b.messages);
  expect(admitContextImageBytes([second], 1500).omitted).toBe(0);
});
