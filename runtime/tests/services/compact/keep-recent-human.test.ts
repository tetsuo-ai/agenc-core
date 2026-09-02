import { describe, expect, it } from "vitest";

import { nearestRecentHumanMessageIndex } from "../../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";

const user = (content: string): RuntimeMessage => ({ role: "user", content });
const assistant = (content: string): RuntimeMessage => ({ role: "assistant", content });

describe("the kept suffix reaches back to the most recent human message", () => {
  it("returns the index of a recent human message", () => {
    const messages = [
      user("build the game"),
      ...Array.from({ length: 30 }, (_, index) => assistant(`work ${index}`)),
      user("continue with the plan"),
      assistant("on it"),
      assistant("still on it"),
    ];
    expect(nearestRecentHumanMessageIndex(messages, 4)).toBe(31);
  });

  it("leaves the positional split alone when the last human message is far back", () => {
    const messages = [
      user("build the game"),
      ...Array.from({ length: 40 }, (_, index) => assistant(`work ${index}`)),
    ];
    expect(nearestRecentHumanMessageIndex(messages, 4)).toBe(messages.length);
  });

  it("leaves the split alone when the tail since the last human message is heavy", () => {
    // Thirty small messages, then the user's question followed by a 40 KB
    // tool result: keeping that tail would defeat a collapse, so it is
    // summarized like the rest.
    const messages = [
      user("build the game"),
      ...Array.from({ length: 30 }, (_, index) => assistant(`work ${index}`)),
      user("read the big file"),
      { role: "tool", toolCallId: "c1", content: "#".repeat(40_000) } as RuntimeMessage,
      assistant("done reading"),
    ];
    expect(nearestRecentHumanMessageIndex(messages, 4)).toBe(messages.length);
  });

  it("ignores runtime-authored user-role messages", () => {
    const messages = [
      user("build the game"),
      ...Array.from({ length: 20 }, (_, index) => assistant(`work ${index}`)),
      { role: "user", originalRole: "developer", content: "boundary" } as RuntimeMessage,
      {
        role: "user",
        content: "summary",
        runtimeOnly: { compactionHistory: {} },
      } as unknown as RuntimeMessage,
      assistant("after"),
    ];
    expect(nearestRecentHumanMessageIndex(messages, 4)).toBe(messages.length);
  });
});
