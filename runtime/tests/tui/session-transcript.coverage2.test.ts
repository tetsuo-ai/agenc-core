import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./session-transcript.js";

describe("session transcript startup message coverage", () => {
  test("projects startup content arrays, images, JSON fallback, and empty content into user rows", () => {
    const transcript = adaptTranscriptEvents([], [
      {
        role: "user",
        content: [
          "literal",
          { type: "text", text: "block text" },
          { type: "image" },
          { type: "metadata", value: 7 },
        ],
      },
      { role: "user", content: null },
      { role: "user", content: 42 },
    ] as any);

    expect(
      transcript.messages.map((message) => message.message.content),
    ).toEqual([
      'literal\nblock text\n[Image]\n{"type":"metadata","value":7}',
      "(empty)",
      "42",
    ]);
  });
});
