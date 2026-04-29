import { describe, expect, it } from "vitest";

import { DEFAULT_SNIP_GAP_MS } from "./constants.js";
import {
  applyReactiveCompact,
  createReactiveCompactState,
} from "./reactive-compact.js";
import { applySnip, createSnipState } from "./snip.js";
import type { LLMMessage } from "../types.js";

function makeMultimodalUser(content: string, imageUrl: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: content },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  };
}

function makeUser(content: string): LLMMessage {
  return { role: "user", content };
}

describe("preserved attachments", () => {
  it("preserves attachments from snipped multimodal messages", () => {
    let state = createSnipState();
    state = applySnip({
      messages: [makeUser("seed")],
      state,
      nowMs: 1_000_000_000,
    }).state;

    const messages: LLMMessage[] = [makeMultimodalUser("look", "https://example.com/a.png")];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUser(`q${i}`));
    }

    const result = applySnip({
      messages,
      state,
      nowMs: 1_000_000_000 + DEFAULT_SNIP_GAP_MS + 1,
    });

    expect(result.action).toBe("snipped");
    expect(result.preservedAttachments).toHaveLength(1);
    expect(result.preservedAttachments[0]).toMatchObject({
      messageIndex: 0,
      role: "user",
      content: messages[0]?.content,
    });
  });

  it("preserves attachments from reactive trims", () => {
    const messages: LLMMessage[] = [
      makeMultimodalUser("look", "https://example.com/b.png"),
      makeUser("q1"),
      makeUser("q2"),
      makeUser("q3"),
      makeUser("q4"),
      makeUser("q5"),
      makeUser("q6"),
      makeUser("q7"),
    ];

    const result = applyReactiveCompact({
      messages,
      state: createReactiveCompactState(),
      nowMs: 1_000_000_000,
    });

    expect(result.action).toBe("trimmed");
    expect(result.preservedAttachments).toHaveLength(1);
    expect(result.preservedAttachments[0]).toMatchObject({
      messageIndex: 0,
      role: "user",
      content: messages[0]?.content,
    });
  });
});
