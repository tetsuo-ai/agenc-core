import { describe, expect, test } from "vitest";

import { normalizeMessagesForAPI } from "./messages.js";
import type { LLMMessage } from "./types.js";

describe("normalizeMessagesForAPI", () => {
  test("keeps only leading system messages for provider requests", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "hello" },
      {
        role: "system",
        content: "<system-reminder>late reminder</system-reminder>",
      },
      { role: "assistant", content: "ok" },
      { role: "system", content: "retry with evidence" },
    ];

    const out = normalizeMessagesForAPI(messages);

    expect(out.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(out[0]?.content).toBe("base prompt");
    expect(JSON.stringify(out)).not.toContain("late reminder");
    expect(JSON.stringify(out)).not.toContain("retry with evidence");
  });
});
