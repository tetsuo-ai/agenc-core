import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../../src/llm/types.js";
import { applyQwenKimiImageInputContract } from "../../../src/llm/wire/qwen-contract.js";

const CONTRACT_ERROR =
  "Qwen's direct Kimi route requires a public HTTP(S) image URL; inline base64 and file references are unsupported";

function imageMessage(url: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url } },
    ],
  };
}

describe("applyQwenKimiImageInputContract", () => {
  test("forwards text-only history and public HTTP(S) image URLs unchanged", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "hello" },
      imageMessage("https://cdn.example.test/cat.png"),
      imageMessage("http://assets.example.test/dog.jpg"),
    ];

    expect(applyQwenKimiImageInputContract(messages)).toBe(messages);
  });

  test.each([
    "data:image/png;base64,YWJj",
    "file:///tmp/cat.png",
    "ms://files/cat.png",
    "/tmp/cat.png",
    "https://cdn.example.test/cat.png ",
    " https://cdn.example.test/cat.png",
    "https://user:secret@cdn.example.test/cat.png",
    "not a url",
  ])("refuses inline, file, credentialed, or malformed image references: %s", url => {
    expect(() => applyQwenKimiImageInputContract([imageMessage(url)])).toThrow(
      TypeError,
    );
    expect(() => applyQwenKimiImageInputContract([imageMessage(url)])).toThrow(
      CONTRACT_ERROR,
    );
  });

  test("fails the whole batch when any later message violates the contract", () => {
    const messages: LLMMessage[] = [
      imageMessage("https://cdn.example.test/ok.png"),
      imageMessage("data:image/png;base64,YWJj"),
    ];

    expect(() => applyQwenKimiImageInputContract(messages)).toThrow(CONTRACT_ERROR);
  });
});
