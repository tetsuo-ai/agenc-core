import { describe, expect, test } from "vitest";

import type { LLMMessage } from "../../../src/llm/types.js";
import {
  applyKimiImageInputContract,
  assertKimiRequestPayloadSize,
  kimiCacheWriteUsage,
} from "../../../src/llm/wire/kimi-contract.js";

const CONTRACT_ERROR =
  "Kimi does not support public image URLs; provide inline base64 JPG, PNG, WebP, GIF, BMP, HEIC, or HEIF image data, or an ms:// file reference";

function imageMessage(url: string): LLMMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url } },
    ],
  };
}

describe("applyKimiImageInputContract", () => {
  test("forwards text-only history, inline images, and ms:// references unchanged", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "hello" },
      imageMessage("data:image/png;base64,YWJj"),
      imageMessage("data:image/jpeg;base64,YWJj"),
      imageMessage("data:image/webp;base64,YWJj"),
      imageMessage("ms://files/cat.png"),
    ];

    expect(applyKimiImageInputContract(messages)).toBe(messages);
  });

  test.each([
    "https://cdn.example.test/cat.png",
    "http://assets.example.test/dog.jpg",
    "file:///tmp/cat.png",
    "/tmp/cat.png",
    "data:image/png;base64,",
    "data:image/png;base64,Y",
    "data:image/svg+xml;base64,YWJj",
    "data:image/png;base64,YWJj ",
    " data:image/png;base64,YWJj",
    "https://user:secret@cdn.example.test/cat.png",
    "ms://",
    "not a url",
  ])("refuses public, file, padded, or malformed image references: %s", (url) => {
    expect(() => applyKimiImageInputContract([imageMessage(url)])).toThrow(
      TypeError,
    );
    expect(() => applyKimiImageInputContract([imageMessage(url)])).toThrow(
      CONTRACT_ERROR,
    );
  });

  test("fails the whole batch when any later message violates the contract", () => {
    const messages: LLMMessage[] = [
      imageMessage("data:image/png;base64,YWJj"),
      imageMessage("https://cdn.example.test/cat.png"),
    ];

    expect(() => applyKimiImageInputContract(messages)).toThrow(CONTRACT_ERROR);
  });
});

describe("assertKimiRequestPayloadSize", () => {
  test("accepts a typical encoded request", () => {
    expect(() =>
      assertKimiRequestPayloadSize({ model: "kimi-k2", messages: [] }),
    ).not.toThrow();
  });
});

// Cache TTL is locked at first write. The response, not the request, owns billing.
describe("Kimi cache write accounting", () => {
  test("uses header totals when the JSON breakdown is absent", () => {
    expect(kimiCacheWriteUsage(undefined, new Headers({
      "Msh-Usage-Cache-Write-Tokens-5m": "10", "Msh-Usage-Cache-Write-Tokens-1h": "20",
    }))).toEqual({ cacheCreationInputTokens: 30, cacheCreation1hInputTokens: 20 });
  });
  test("keeps missing writes unknown and rejects invalid counts", () => {
    expect(kimiCacheWriteUsage(undefined)).toEqual({});
    for (const value of [-1, NaN, Infinity, 1.5, "30"]) expect(kimiCacheWriteUsage(value)).toEqual({});
    expect(kimiCacheWriteUsage(30, new Headers({ "Msh-Usage-Cache-Write-Tokens-1h": "NaN" })))
      .toEqual({ cacheCreationInputTokens: 30 });
  });
  test("never lets the TTL subset exceed reported total writes", () => {
    expect(kimiCacheWriteUsage(10, new Headers({ "Msh-Usage-Cache-Write-Tokens-1h": "20" })))
      .toEqual({ cacheCreationInputTokens: 10, cacheCreation1hInputTokens: 10 });
  });
});
