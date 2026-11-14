import { describe, expect, test } from "vitest";

import {
  MAX_RETAINED_USER_PROMPT_BYTES,
  retainedUserPromptByteLimit,
  retainedUserPromptIndexes,
} from "../../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";

const user = (content: string, extra: Partial<RuntimeMessage> = {}): RuntimeMessage =>
  ({ role: "user", content, runtimeOnly: { userMessageId: "submitted" }, ...extra }) as RuntimeMessage;
const assistant = (content: string): RuntimeMessage => ({ role: "assistant", content }) as RuntimeMessage;

describe("retainedUserPromptIndexes", () => {
  test("keeps every prompt the user typed before the split, and nothing else", () => {
    const messages = [
      user("Build the renderer."),
      assistant("working"),
      user("<system-reminder>files changed</system-reminder>", { isMeta: true }),
      user("Use soft shadows."),
      assistant("done"),
      user("Now the reflections."),
    ];
    expect([...retainedUserPromptIndexes(messages, 5)].sort()).toEqual([0, 3]);
    // The split bounds the search: later messages are kept by the tail, not by this rule.
    expect([...retainedUserPromptIndexes(messages, 2)]).toEqual([0]);
    expect([...retainedUserPromptIndexes(messages, 0)]).toEqual([]);
  });

  test("keeps the first prompt when it fits, then the newest ones that fit the byte limit", () => {
    const big = "x".repeat(MAX_RETAINED_USER_PROMPT_BYTES / 2);
    const messages = [user("The task."), assistant("a"), user(big), assistant("b"), user(big), assistant("c"), user("Small fix.")];
    // The first prompt and the newest two fit; the older large one does not.
    expect([...retainedUserPromptIndexes(messages, messages.length)].sort()).toEqual([0, 4, 6]);
    // An oversized first prompt is summarized; later prompts still use the budget.
    const oversized = [user("y".repeat(MAX_RETAINED_USER_PROMPT_BYTES * 2)), assistant("a"), user("Later.")];
    expect([...retainedUserPromptIndexes(oversized, oversized.length)]).toEqual([2]);
  });

  test("the limit follows the context window, so a compaction on a small window still frees room", () => {
    expect(retainedUserPromptByteLimit(996_147)).toBe(MAX_RETAINED_USER_PROMPT_BYTES);
    expect(retainedUserPromptByteLimit(121_600)).toBe(24_320);
    expect(retainedUserPromptByteLimit(1_000)).toBe(200);
    expect(retainedUserPromptByteLimit(0)).toBe(0);
    const messages = [user("p".repeat(4_000)), assistant("a"), user("q".repeat(4_000)), assistant("b")];
    expect([...retainedUserPromptIndexes(messages, 4, retainedUserPromptByteLimit(1_000))]).toEqual([]);
    expect([...retainedUserPromptIndexes(messages, 4, retainedUserPromptByteLimit(121_600))].sort()).toEqual([0, 2]);
  });

  test("skips oversized recent prompts and spends the remaining budget on the newest ones that fit", () => {
    const messages = [user("Task"), user("older"), user("éé"), user("x".repeat(100)), user("fix")];
    // JSON-encoded UTF-8 sizes: Task=6, fix=5, éé=6. No room for older=7.
    const retained = retainedUserPromptIndexes(messages, messages.length, 17);
    expect([...retained]).toEqual([0, 4, 2]);
    expect([...retainedUserPromptIndexes(messages, messages.length, 0)]).toEqual([]);
  });
});
