import { describe, expect, it } from "vitest";

import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import {
  restoreWithheldImages,
  withheldImagePlaceholder,
} from "../../src/session/query-image-withheld.js";

const IMAGE: LLMContentPart = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,aaaa" },
};

function userParts(parts: LLMContentPart[]): LLMMessage {
  return { role: "user", content: parts };
}

describe("withheldImagePlaceholder", () => {
  it("is a text part that restoreWithheldImages turns back into the image", () => {
    const placeholder = withheldImagePlaceholder(
      IMAGE,
      "[Image not shown: the model cannot view images.]",
    );
    expect(placeholder).toEqual({
      type: "text",
      text: "[Image not shown: the model cannot view images.]",
    });

    const restored = restoreWithheldImages([userParts([placeholder])]);
    const parts = restored[0]?.content;
    expect(parts).toEqual([IMAGE]);
    expect(Array.isArray(parts) && parts[0]).toBe(IMAGE);
  });
});

describe("restoreWithheldImages", () => {
  it("leaves messages without a placeholder as the same objects", () => {
    const text = userParts([{ type: "text", text: "look" }]);
    const stringContent: LLMMessage = { role: "assistant", content: "ok" };
    const messages = [text, stringContent];
    const restored = restoreWithheldImages(messages);
    expect(restored[0]).toBe(text);
    expect(restored[1]).toBe(stringContent);
    expect(restored).toEqual(messages);
  });

  it("does not treat a copied note as a placeholder", () => {
    const placeholder = withheldImagePlaceholder(IMAGE, "left out");
    const copy: LLMContentPart = { type: "text", text: "left out" };
    const restored = restoreWithheldImages([userParts([copy, placeholder])]);
    expect(restored[0]?.content).toEqual([copy, IMAGE]);
  });

  it("keeps sibling parts and tool identity when only one image was withheld", () => {
    const placeholder = withheldImagePlaceholder(IMAGE, "left out");
    const caption: LLMContentPart = { type: "text", text: "Read image shot.png" };
    const tool: LLMMessage = {
      role: "tool",
      toolCallId: "call_1",
      toolName: "FileRead",
      content: [caption, placeholder],
    };
    const restored = restoreWithheldImages([tool]);
    expect(restored[0]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "FileRead",
    });
    expect(restored[0]?.content).toEqual([caption, IMAGE]);
    expect(tool.content).toEqual([caption, placeholder]);
  });

  it("does not mutate the messages it is given", () => {
    const placeholder = withheldImagePlaceholder(IMAGE, "left out");
    const message = userParts([{ type: "text", text: "see" }, placeholder]);
    const original = structuredClone(message);
    restoreWithheldImages([message]);
    expect(message).toEqual(original);
  });
});
