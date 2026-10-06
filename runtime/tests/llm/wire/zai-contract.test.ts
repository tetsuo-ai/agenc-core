import { Buffer } from "node:buffer";

import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../../src/llm/types.js";
import { applyZaiImageInputContract } from "../../../src/llm/wire/zai-contract.js";

const USER_IMAGE_ERROR =
  "Z.AI image input must be a JPEG or PNG under 5 MiB with dimensions " +
  "no larger than 6000x6000";
const ROLE_ERROR = "Z.AI image input is supported only in user messages";

function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpegWithDimensions(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

function dataUri(mime: "png" | "jpeg", bytes: Buffer): string {
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

const VALID_PNG = dataUri("png", pngWithDimensions(1, 1));
const VALID_JPEG = dataUri("jpeg", jpegWithDimensions(1, 1));

function imageMessage(
  url: string,
  role: LLMMessage["role"] = "user",
): LLMMessage {
  return {
    role,
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url } },
    ],
  };
}

describe("applyZaiImageInputContract", () => {
  test("forwards text-only history and valid user JPEG/PNG or remote URLs", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "hello" },
      imageMessage(VALID_PNG),
      imageMessage(VALID_JPEG),
      imageMessage("https://cdn.example.test/cat.png"),
      imageMessage("http://assets.example.test/dog.jpg"),
      imageMessage("https://cdn.example.test/uploads/no-extension"),
    ];

    expect(applyZaiImageInputContract(messages)).toEqual(messages);
  });

  test.each([
    dataUri("png", pngWithDimensions(6001, 1)),
    dataUri("jpeg", jpegWithDimensions(1, 6001)),
    dataUri("png", pngWithDimensions(0, 1)),
    "data:image/webp;base64,YWJj",
    "data:image/png;base64,",
    "data:image/png;base64,Y",
    "file:///tmp/cat.png",
    "https://cdn.example.test/cat.webp",
    "https://cdn.example.test/cat.gif",
    "not a url",
  ])("rejects invalid user image input: %s", (url) => {
    expect(() => applyZaiImageInputContract([imageMessage(url)])).toThrow(
      TypeError,
    );
    expect(() => applyZaiImageInputContract([imageMessage(url)])).toThrow(
      USER_IMAGE_ERROR,
    );
  });

  test("refuses images on assistant or system messages", () => {
    expect(() =>
      applyZaiImageInputContract([imageMessage(VALID_PNG, "assistant")]),
    ).toThrow(ROLE_ERROR);
    expect(() =>
      applyZaiImageInputContract([imageMessage(VALID_PNG, "system")]),
    ).toThrow(ROLE_ERROR);
  });

  test("strips invalid tool images and keeps valid ones", () => {
    const validTool = imageMessage(VALID_PNG, "tool");
    const invalidTool = imageMessage("https://cdn.example.test/cat.webp", "tool");
    const mixedTool: LLMMessage = {
      role: "tool",
      content: [
        { type: "text", text: "result" },
        { type: "image_url", image_url: { url: VALID_JPEG } },
        { type: "image_url", image_url: { url: "file:///tmp/cat.png" } },
      ],
    };

    expect(applyZaiImageInputContract([validTool])).toEqual([validTool]);
    expect(applyZaiImageInputContract([invalidTool])).toEqual([
      { role: "tool", content: [{ type: "text", text: "describe" }] },
    ]);
    expect(applyZaiImageInputContract([mixedTool])).toEqual([
      {
        role: "tool",
        content: [
          { type: "text", text: "result" },
          { type: "image_url", image_url: { url: VALID_JPEG } },
        ],
      },
    ]);
  });
});
