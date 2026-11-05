import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  admitContextImageBytes,
  boundContextImageBytes,
  boundContextImagesForProvider,
  CONTEXT_IMAGE_BUDGET_ENV,
  DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES,
  OMITTED_IMAGE_TEXT,
  OVERSIZED_IMAGE_TEXT,
  resolveContextImageBudgetBytes,
  unfitImageText,
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
  return shots.map((_, index) => boundContextImageBytes(shots.slice(0, index + 1), budget));
}

/** A FileRead call and its image result: one request's new content. */
function readImage(id: string, bytes: number, path = `/work/${id}.png`): LLMMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "FileRead", arguments: JSON.stringify({ file_path: path }) }] },
    { role: "tool", toolCallId: id, toolName: "FileRead", content: [
      { type: "text", text: `Read image ${path}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${id.padEnd(bytes - 22, "B")}` } },
    ] },
  ];
}

/** Every image part, as "IMG" or its placeholder text, oldest first. */
function imageSlots(messages: readonly LLMMessage[]): string[] {
  return messages.flatMap((message) => !Array.isArray(message.content)
    ? []
    : message.content.flatMap((part) =>
      part.type === "image_url" ? ["IMG"] : part.type === "text" && part.text.startsWith("[image") ? [part.text] : []));
}

/** Projections of a session in which each request reads one more image. */
function readingRequests(sizes: readonly number[], budget: number, start: LLMMessage[] = [{ role: "user", content: "Inspect each screen." }]) {
  const history = [...start];
  return sizes.map((bytes, index) => {
    history.push(...readImage(`shot-${index}`, bytes));
    return admitContextImageBytes(history, budget);
  });
}

function prefixRepeats(requests: ReadonlyArray<{ readonly messages: readonly LLMMessage[] }>): boolean[] {
  return requests.slice(1).map((request, index) => {
    const previous = requests[index]!.messages;
    return JSON.stringify(request.messages.slice(0, previous.length)) === JSON.stringify(previous);
  });
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

  test("replaces the oldest images down to half the budget once the images exceed it", () => {
    const messages = [image(1000, "one"), image(1000, "two"), image(1000, "three"), image(1000, "four")];
    const bounded = boundContextImageBytes(messages, 3000);
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

  test.each([
    { sizes: [3000, 4000], budget: 6000, kept: [1], bytes: 4000 },
    { sizes: [1000, 4000, 3000], budget: 6000, kept: [2], bytes: 3000 },
    { sizes: [1000, 6000], budget: 6000, kept: [1], bytes: 6000 },
    { sizes: [1000, 7000], budget: 6000, kept: [], bytes: 0 },
    { sizes: [1000, 7000, 1000], budget: 6000, kept: [2], bytes: 1000 },
    { sizes: [2000, 2000, 2000, 1000, 1000], budget: 6000, kept: [2, 3, 4], bytes: 4000 },
  ])("retains a contiguous newest suffix: $sizes with budget $budget", ({ sizes, budget, kept, bytes }) => {
    const messages = sizes.map((size, index) => image(size, String(index)));
    const original = structuredClone(messages);
    const bounded = boundContextImageBytes(messages, budget);
    expect(keptIndexes(bounded.messages)).toEqual(kept);
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

  // Six 1000-byte screenshots fill a 6000-byte budget. The seventh drops
  // the oldest four, down to half the budget; the next three fit, and the
  // eleventh drops the next four.
  test("repeats the previous request byte for byte until the next batch", () => {
    const requests = screenshotRequests(12, 6000);
    expect(prefixRepeats(requests)).toEqual([true, true, true, true, true, false, true, true, true, false, true]);
  });

  test("drops the oldest images in one batch and fills the budget again before the next", () => {
    const requests = screenshotRequests(12, 6000);
    expect(requests.map(({ omitted }) => omitted)).toEqual([0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 8, 8]);
    expect(requests.map(({ retainedBytes }) => retainedBytes))
      .toEqual([1000, 2000, 3000, 4000, 5000, 6000, 3000, 4000, 5000, 6000, 3000, 4000]);
    for (const { messages, omitted } of requests) {
      expect(keptIndexes(messages))
        .toEqual(Array.from({ length: messages.length - omitted }, (_, index) => omitted + index));
    }
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

describe("admitContextImageBytes", () => {
  test("leaves a history under budget untouched and changes nothing as images arrive", () => {
    const requests = readingRequests([1000, 1000, 1000, 1000, 1000], 6000);
    expect(requests.map(({ omitted }) => omitted)).toEqual([0, 0, 0, 0, 0]);
    expect(prefixRepeats(requests)).toEqual([true, true, true, true]);
    expect(admitContextImageBytes([image(4000, "one"), image(4000, "two")], 0).omitted).toBe(0);
  });

  test("the budget is full, then the next new image is visible", () => {
    const requests = readingRequests([1000, 1000, 1000, 1000, 1000, 1000, 1000], 6000);
    expect(requests[5]!.retainedBytes).toBe(6000);
    const full = requests[6]!;
    // The new screenshot reaches the model; the oldest leave in one batch.
    expect(imageSlots(full.messages)).toEqual([
      OMITTED_IMAGE_TEXT, OMITTED_IMAGE_TEXT, OMITTED_IMAGE_TEXT, OMITTED_IMAGE_TEXT, "IMG", "IMG", "IMG",
    ]);
    expect(full.retainedBytes).toBe(3000);
    expect(JSON.stringify(full.messages)).not.toContain("not inspected");
  });

  test("repeated reads past the budget break the cache once per batch, not once per image", () => {
    const requests = readingRequests(Array(20).fill(1000), 6000);
    expect(requests.map((request) => request.retainedBytes / 1000))
      .toEqual([1, 2, 3, 4, 5, 6, 3, 4, 5, 6, 3, 4, 5, 6, 3, 4, 5, 6, 3, 4]);
    const repeats = prefixRepeats(requests);
    expect(repeats.filter((repeated) => !repeated)).toHaveLength(4);
    expect(repeats.flatMap((repeated, index) => repeated ? [] : [index + 1])).toEqual([6, 10, 14, 18]);
    // Every request shows the image it just returned.
    for (const request of requests) expect(imageSlots(request.messages).at(-1)).toBe("IMG");
  });

  test("keeps the images sent with the turn while its tool results fill the budget", () => {
    const omitted = OMITTED_IMAGE_TEXT;
    const turn: LLMMessage[] = [
      ...readImage("earlier", 1000),
      { role: "assistant", content: "Earlier screen checked." },
      { role: "user", content: [{ type: "text", text: "Match this mockup." }, { type: "image_url", image_url: { url: `data:image/png;base64,${"M".repeat(1978)}` } }] },
    ];
    for (const index of [0, 1, 2, 3]) turn.push(...readImage(`shot-${index}`, 1000));
    // 1000 earlier + 2000 mockup + four 1000-byte captures: the fourth capture
    // overflows. The earlier screen and the older captures go, not the mockup.
    const bounded = admitContextImageBytes(turn, 6000);
    expect(imageSlots(bounded.messages)).toEqual([omitted, "IMG", omitted, omitted, omitted, "IMG"]);
    expect(bounded.retainedBytes).toBe(3000);
    // The base policy left the mockup out first.
    expect(imageSlots(boundContextImageBytes(turn, 6000).messages)).toEqual([omitted, omitted, omitted, "IMG", "IMG", "IMG"]);
    // A later turn no longer owns the mockup: it is the oldest image and leaves with the next batch.
    const later: LLMMessage[] = [...turn, { role: "assistant", content: "Done." }, { role: "user", content: "Check four more screens." }];
    for (const index of [0, 1, 2, 3]) later.push(...readImage(`later-${index}`, 1000));
    expect(imageSlots(admitContextImageBytes(later, 6000).messages)).toEqual([
      omitted, omitted, omitted, omitted, omitted, omitted, omitted, "IMG", "IMG", "IMG",
    ]);
    // Until that batch, the earlier verdicts stand byte for byte.
    expect(admitContextImageBytes(later.slice(0, -2), 6000).messages.slice(0, turn.length)).toEqual(bounded.messages);
  });

  test("shows every image the latest tool results returned together when they fit together", () => {
    const history: LLMMessage[] = [{ role: "user", content: "Compare the screens." }, ...readImage("old", 3000)];
    history.push({ role: "assistant", content: "", toolCalls: ["a", "b", "c"].map((id) => ({ id, name: "FileRead", arguments: `{"file_path":"/work/${id}.png"}` })) });
    for (const id of ["a", "b", "c"]) history.push(readImage(id, 1500)[1]!);
    const bounded = admitContextImageBytes(history, 6000);
    expect(imageSlots(bounded.messages)).toEqual([OMITTED_IMAGE_TEXT, "IMG", "IMG", "IMG"]);
    // The base policy evicts down to half and also hides a new result.
    expect(imageSlots(boundContextImageBytes(history, 6000).messages)).toEqual([OMITTED_IMAGE_TEXT, OMITTED_IMAGE_TEXT, "IMG", "IMG"]);
  });

  test("new images that cannot fit together keep the newest and name the others truthfully", () => {
    const history: LLMMessage[] = [{ role: "user", content: "Compare the screens." }];
    history.push({ role: "assistant", content: "", toolCalls: ["a", "b", "c"].map((id) => ({ id, name: "FileRead", arguments: `{"file_path":"/work/${id}.png"}` })) });
    for (const id of ["a", "b", "c"]) history.push(readImage(id, 2500)[1]!);
    const bounded = admitContextImageBytes(history, 6000);
    expect(imageSlots(bounded.messages)).toEqual([unfitImageText('"/work/a.png"'), "IMG", "IMG"]);
    expect(unfitImageText('"/work/a.png"')).not.toMatch(/compaction/i);
    expect(bounded.retainedBytes).toBe(5000);
  });

  test("an image larger than the whole budget leaves with older screens, not the current turn's images", () => {
    const history: LLMMessage[] = [...readImage("old", 2000), { role: "assistant", content: "Checked." },
      { role: "user", content: [{ type: "text", text: "Here is the bug." }, { type: "image_url", image_url: { url: `data:image/png;base64,${"U".repeat(1978)}` } }] },
      ...readImage("huge", 7000)];
    const bounded = admitContextImageBytes(history, 6000);
    expect(imageSlots(bounded.messages)).toEqual([OMITTED_IMAGE_TEXT, "IMG", OVERSIZED_IMAGE_TEXT]);
  });

  test("an appended message never changes an earlier verdict", () => {
    // Mixed sizes, several images per request and turn boundaries.
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const history: LLMMessage[] = [{ role: "user", content: "Start." }];
    let previous: string[] = [];
    for (let request = 0; request < 60; request++) {
      if (random() < 0.15) history.push({ role: "assistant", content: "Turn done." }, { role: "user", content: `Turn ${request}.` });
      const ids = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => `r${request}-${index}`);
      history.push({ role: "assistant", content: "", toolCalls: ids.map((id) => ({ id, name: "FileRead", arguments: `{"file_path":"/work/${id}.png"}` })) });
      for (const id of ids) history.push(readImage(id, 300 + Math.floor(random() * 2500))[1]!);
      const slots = imageSlots(admitContextImageBytes(history, 6000).messages);
      // An image, once left out, never returns, and a kept one changes only by leaving.
      for (const [index, slot] of previous.entries()) {
        if (slot !== "IMG") expect(slots[index]).toBe(slot);
      }
      // A request never leaves out more than the images it had to make room for.
      expect(slots.at(-1)).toBe("IMG");
      previous = slots;
    }
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

test("only providers that cache an unchanged prefix use the turn-aware admission", () => {
  const history: LLMMessage[] = [{ role: "user", content: "Compare the screens." }, ...readImage("old", 3000)];
  history.push({ role: "assistant", content: "", toolCalls: ["a", "b", "c"].map((id) => ({ id, name: "FileRead", arguments: `{"file_path":"/work/${id}.png"}` })) });
  for (const id of ["a", "b", "c"]) history.push(readImage(id, 1500)[1]!);
  for (const provider of ["deepseek", "openai", "anthropic"]) {
    expect(boundContextImagesForProvider(history, 6000, provider)).toEqual(admitContextImageBytes(history, 6000));
  }
  for (const provider of ["local-test", "ollama", undefined]) {
    expect(boundContextImagesForProvider(history, 6000, provider)).toEqual(boundContextImageBytes(history, 6000));
  }
});
