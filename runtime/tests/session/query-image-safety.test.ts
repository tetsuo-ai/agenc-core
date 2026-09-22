import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import {
  imageContentIdentity,
  imageRoute,
  pruneRejectedImages,
  recordRejectedImages,
  rejectedImagesFor,
  requestImageUrls,
  withholdImagesForModel,
  withholdUndecodableToolImages,
} from "../../src/session/query-image-safety.js";

const FAKE_PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
// 1x1 PNG, complete: 67 bytes.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG.toString("base64")}`;
const REMOTE_URL = "https://example.test/diagram.png";
const FLASH_ROUTE = "deepseek/deepseek-flash";

function toolImage(url: string, callId = "call_1"): LLMMessage {
  return {
    role: "tool",
    toolCallId: callId,
    toolName: "FileRead",
    content: [
      { type: "text", text: "Read image shot.png (67B, image/png)" },
      { type: "image_url", image_url: { url } },
    ],
  };
}

function userImage(url: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url } },
    ],
  };
}

function texts(messages: readonly LLMMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []);
}

describe("withholdImagesForModel", () => {
  it("replaces every image for a text-only model, naming model, file, type and size", () => {
    const messages = [userImage(REMOTE_URL), toolImage(TINY_PNG_URL)];
    const result = withholdImagesForModel(
      messages,
      { imageInput: "unsupported", modelLabel: "deepseek/deepseek-v4-pro", route: "deepseek/deepseek-v4-pro" },
      undefined,
    );
    expect(requestImageUrls(result.messages)).toEqual([]);
    expect(result).toMatchObject({ unsupported: 2, rejected: 0 });
    expect(texts(result.messages)).toContain(
      "[Image not shown: deepseek/deepseek-v4-pro cannot view images, so the PNG image shot.png (image/png, 67 bytes) returned by FileRead was left out.]",
    );
    expect(texts(result.messages)).toContain(
      `[Image not shown: deepseek/deepseek-v4-pro cannot view images, so the image at ${REMOTE_URL} attached to this message was left out.]`,
    );
    // The input is untouched: this is a projection.
    expect(requestImageUrls(messages)).toEqual([REMOTE_URL, TINY_PNG_URL]);
  });

  it.each(["supported", "unknown"] as const)(
    "keeps every image when support is %s",
    (imageInput) => {
      const messages = [userImage(REMOTE_URL), toolImage(TINY_PNG_URL)];
      const result = withholdImagesForModel(
        messages,
        { imageInput, modelLabel: "deepseek/deepseek-flash", route: FLASH_ROUTE },
        undefined,
      );
      expect(result.messages).toEqual(messages);
      expect(result).toMatchObject({ unsupported: 0, rejected: 0 });
    },
  );

  it("replaces only the images a provider refused", () => {
    const session = {};
    const other = `data:image/png;base64,${"A".repeat(8)}`;
    recordRejectedImages(session, FLASH_ROUTE, [TINY_PNG_URL], {
      provider: "deepseek",
      reason: "unsupported image",
    });
    const result = withholdImagesForModel(
      [toolImage(TINY_PNG_URL), toolImage(other, "call_2")],
      { imageInput: "supported", modelLabel: "deepseek/deepseek-flash", route: FLASH_ROUTE },
      rejectedImagesFor(session, FLASH_ROUTE),
    );
    expect(requestImageUrls(result.messages)).toEqual([other]);
    expect(result.rejected).toBe(1);
    expect(texts(result.messages)).toContain(
      "[Image not shown: deepseek refused the PNG image shot.png (image/png, 67 bytes) returned by FileRead in an earlier request, so it was left out. Provider message: unsupported image]",
    );
  });
});

describe("refusals stay with the route that made them", () => {
  it("withholds a refused image from that route only", () => {
    // Review finding: a refusal was stored for the whole session, so a vision
    // model the user switched to still got a note instead of the image.
    const session = {};
    recordRejectedImages(session, imageRoute("deepseek", "deepseek-flash"), [TINY_PNG_URL], {
      provider: "deepseek",
      reason: "unsupported image",
    });
    const messages = [toolImage(TINY_PNG_URL)];
    const sameRoute = withholdImagesForModel(
      messages,
      { imageInput: "supported", modelLabel: "deepseek/deepseek-flash", route: FLASH_ROUTE },
      rejectedImagesFor(session, imageRoute("DeepSeek", "deepseek-flash")),
    );
    expect(requestImageUrls(sameRoute.messages)).toEqual([]);
    const claudeRoute = imageRoute("anthropic", "claude-sonnet-5");
    expect(rejectedImagesFor(session, claudeRoute)).toBeUndefined();
    const otherRoute = withholdImagesForModel(
      messages,
      { imageInput: "supported", modelLabel: "anthropic/claude-sonnet-5", route: claudeRoute },
      rejectedImagesFor(session, claudeRoute),
    );
    expect(requestImageUrls(otherRoute.messages)).toEqual([TINY_PNG_URL]);
  });
});

describe("withholdUndecodableToolImages", () => {
  it("replaces an undecodable tool-result image and keeps valid and remote ones", () => {
    const messages = [
      toolImage(FAKE_PNG_URL, "fake"),
      toolImage(TINY_PNG_URL, "tiny"),
      toolImage(REMOTE_URL, "remote"),
    ];
    const result = withholdUndecodableToolImages(messages);
    expect(result.undecodable).toBe(1);
    expect(requestImageUrls(result.messages)).toEqual([TINY_PNG_URL, REMOTE_URL]);
    expect(texts(result.messages)).toContain(
      "[Image not shown: the PNG image shot.png (image/png, 16 bytes) returned by FileRead is not a valid PNG image (the data ends before its header (IHDR) chunk is complete), so it was left out.]",
    );
  });

  it("leaves user images to the provider", () => {
    const messages = [userImage(FAKE_PNG_URL)];
    expect(withholdUndecodableToolImages(messages)).toEqual({
      messages,
      undecodable: 0,
    });
  });
});

describe("rejected image bookkeeping", () => {
  it("counts only images not already recorded", () => {
    const session = {};
    const rejection = { provider: "deepseek", reason: "unsupported image" };
    expect(recordRejectedImages(session, FLASH_ROUTE, [TINY_PNG_URL, TINY_PNG_URL], rejection)).toBe(1);
    expect(recordRejectedImages(session, FLASH_ROUTE, [TINY_PNG_URL, FAKE_PNG_URL], rejection)).toBe(1);
    expect(rejectedImagesFor(session, FLASH_ROUTE)?.has(imageContentIdentity(FAKE_PNG_URL))).toBe(true);
    expect(rejectedImagesFor({}, FLASH_ROUTE)).toBeUndefined();
  });

  it("forgets refusals whose images left history, on every route", () => {
    // Review finding: refusals were never forgotten, so a long session kept
    // one per refused image for its whole life.
    const session = {};
    const rejection = { provider: "deepseek", reason: "unsupported image" };
    const claudeRoute = imageRoute("anthropic", "claude-sonnet-5");
    recordRejectedImages(session, FLASH_ROUTE, [TINY_PNG_URL, FAKE_PNG_URL, REMOTE_URL], rejection);
    recordRejectedImages(session, claudeRoute, [FAKE_PNG_URL], rejection);

    // An image in history or in the request keeps its refusal.
    expect(
      pruneRejectedImages(session, [[toolImage(TINY_PNG_URL)], [userImage(REMOTE_URL)]]),
    ).toBe(2);
    expect([...(rejectedImagesFor(session, FLASH_ROUTE)?.keys() ?? [])]).toEqual([
      imageContentIdentity(TINY_PNG_URL),
      imageContentIdentity(REMOTE_URL),
    ]);
    expect(rejectedImagesFor(session, claudeRoute)).toBeUndefined();

    expect(pruneRejectedImages(session, [[{ role: "user", content: "text" }]])).toBe(2);
    expect(rejectedImagesFor(session, FLASH_ROUTE)).toBeUndefined();
    expect(pruneRejectedImages(session, [])).toBe(0);
  });

  it("finds the images a request added after the last assistant message", () => {
    const messages: LLMMessage[] = [
      userImage(REMOTE_URL),
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "FileRead", arguments: "{}" }] },
      toolImage(TINY_PNG_URL, "c"),
    ];
    expect(requestImageUrls(messages, { newestOnly: true })).toEqual([TINY_PNG_URL]);
    expect(requestImageUrls(messages)).toEqual([REMOTE_URL, TINY_PNG_URL]);
  });
});
