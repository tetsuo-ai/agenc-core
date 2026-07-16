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
  writeAgentMetadata: vi.fn(async () => undefined),
}));

import {
  dequeue,
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  getQueuedUserInputCount,
  peek,
  popAllEditable,
  removeLastQueuedInput,
  resetCommandQueue,
} from "./messageQueueManager.js";
import type { QueuedCommand } from "../types/textInputTypes.js";

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

describe("messageQueueManager per-item removal (removeLastQueuedInput)", () => {
  afterEach(() => {
    resetCommandQueue();
  });

  // Mirror of App.tsx's drain primitive: peek the next main-thread runnable
  // command (prompt/bash, no agentId), then dequeue it by reference identity.
  function isMainThreadRunnableCommand(command: QueuedCommand): boolean {
    return (
      command.agentId === undefined &&
      (command.mode === "prompt" || command.mode === "bash")
    );
  }
  function dispatchNext(): QueuedCommand | undefined {
    const next = peek(isMainThreadRunnableCommand);
    if (next === undefined) return undefined;
    return dequeue((command) => command === next);
  }

  test("counts only user inputs (prompt/bash), not notifications", () => {
    enqueue({ value: "first", mode: "prompt" });
    enqueue({ value: "echo hi", mode: "bash" });
    enqueuePendingNotification({
      value: "<task-notification/>",
      mode: "task-notification",
    });
    expect(getQueuedUserInputCount()).toBe(2);
  });

  test("removes only the most recently queued input and leaves the rest intact", () => {
    enqueue({ value: "first", mode: "prompt" });
    enqueue({ value: "second", mode: "prompt" });
    enqueue({ value: "third", mode: "prompt" });

    const removed = removeLastQueuedInput();

    expect(removed?.value).toBe("third");
    expect(getCommandQueue().map((c) => c.value)).toEqual(["first", "second"]);
  });

  test("queue 3 → remove the middle item is reachable by removing twice then re-checking dispatch order", () => {
    // The slice ships "drop last", so to drop the middle of [a,b,c] the user
    // drops c (last) then b (now last). Prove b never dispatches afterward.
    enqueue({ value: "a", mode: "prompt" });
    enqueue({ value: "b", mode: "prompt" });
    enqueue({ value: "c", mode: "prompt" });

    expect(removeLastQueuedInput()?.value).toBe("c");
    expect(removeLastQueuedInput()?.value).toBe("b");

    // Only "a" remains and only "a" can ever dispatch.
    expect(getCommandQueue().map((c) => c.value)).toEqual(["a"]);
    expect(dispatchNext()?.value).toBe("a");
    expect(dispatchNext()).toBeUndefined();
  });

  test("a removed item is never dispatched", () => {
    enqueue({ value: "keep", mode: "prompt" });
    enqueue({ value: "drop-me", mode: "prompt" });

    removeLastQueuedInput();

    const dispatched: (string | unknown)[] = [];
    let cmd = dispatchNext();
    while (cmd !== undefined) {
      dispatched.push(cmd.value);
      cmd = dispatchNext();
    }
    expect(dispatched).toEqual(["keep"]);
    expect(dispatched).not.toContain("drop-me");
  });

  test("dispatch-boundary race: removing an item that was JUST dispatched is a safe no-op (no double-send)", () => {
    enqueue({ value: "racing", mode: "prompt" });

    // The drain dispatches the item first (synchronous splice out of the queue).
    const dispatched = dispatchNext();
    expect(dispatched?.value).toBe("racing");
    expect(getCommandQueue()).toEqual([]);

    // The user's drop key lands a tick later — the item is already gone, so the
    // removal finds nothing and returns undefined. It does NOT remove some other
    // item, and the item is not sent a second time.
    expect(removeLastQueuedInput()).toBeUndefined();
    expect(getCommandQueue()).toEqual([]);
  });

  test("dispatch-boundary race: dropping the item BEFORE the drain runs means it is never dispatched", () => {
    enqueue({ value: "will-dispatch", mode: "prompt" });
    enqueue({ value: "will-drop", mode: "prompt" });

    // The user drops the last item before the turn settles; the drain then runs.
    expect(removeLastQueuedInput()?.value).toBe("will-drop");

    const dispatched: unknown[] = [];
    let cmd = dispatchNext();
    while (cmd !== undefined) {
      dispatched.push(cmd.value);
      cmd = dispatchNext();
    }
    expect(dispatched).toEqual(["will-dispatch"]);
    expect(dispatched).not.toContain("will-drop");
  });

  test("ignores task notifications and meta commands — only user input is dropped", () => {
    enqueuePendingNotification({
      value: "<task-notification/>",
      mode: "task-notification",
    });
    enqueue({ value: "system-meta", mode: "prompt", isMeta: true });

    // No droppable user input → no-op, queue untouched.
    expect(removeLastQueuedInput()).toBeUndefined();
    expect(getCommandQueue()).toHaveLength(2);
  });

  test("returns undefined and mutates nothing when the queue is empty", () => {
    expect(removeLastQueuedInput()).toBeUndefined();
    expect(getCommandQueue()).toEqual([]);
  });
});
