import { describe, expect, test, vi, afterEach } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../bootstrap/state.js", () => ({
  getActiveTimeCounter: () => null,
  getSessionId: () => "queue-test-session",
}));

vi.mock("./sessionStorage.js", () => ({
  recordQueueOperation: vi.fn(),
}));

import {
  enqueue,
  getCommandQueue,
  popAllEditable,
  resetCommandQueue,
} from "./messageQueueManager.js";

describe("messageQueueManager editable restore", () => {
  afterEach(() => {
    resetCommandQueue();
  });

  test("restores a queued prompt without placing the cursor past the restored text", () => {
    enqueue({ value: "queued prompt", mode: "prompt" });

    expect(popAllEditable("", 0)).toEqual({
      text: "queued prompt",
      cursorOffset: "queued prompt".length,
      images: [],
    });
    expect(getCommandQueue()).toEqual([]);
  });

  test("restores queued prompt text before the current draft with the cursor inside the draft", () => {
    enqueue({ value: "queued prompt", mode: "prompt" });

    expect(popAllEditable("draft", 2)).toEqual({
      text: "queued prompt\ndraft",
      cursorOffset: "queued prompt\n".length + 2,
      images: [],
    });
  });

  test("restores image-only queued prompts without inventing text or cursor movement", () => {
    const image = {
      id: 7,
      type: "image",
      content: "base64-image",
      mediaType: "image/png",
      filename: "pasted.png",
    } as const;

    enqueue({
      value: "",
      mode: "prompt",
      pastedContents: { 7: image },
    });

    expect(popAllEditable("", 0)).toEqual({
      text: "",
      cursorOffset: 0,
      images: [image],
    });
    expect(getCommandQueue()).toEqual([]);
  });
});
