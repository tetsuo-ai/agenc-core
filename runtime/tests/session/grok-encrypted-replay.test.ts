import { describe, expect, it } from "vitest";

import { isGrokEncryptedReplay } from "../../src/session/provider-replay-redaction.js";

const CIPHERTEXT = Buffer.from("opaque encrypted bytes").toString("base64");

function replay(content: unknown): Record<string, unknown> {
  return {
    version: 2,
    provider: "grok",
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

function item(encrypted_content: string): Record<string, unknown> {
  return { type: "reasoning", encrypted_content };
}

describe("isGrokEncryptedReplay", () => {
  it("accepts version-2 Grok reasoning with canonical ciphertext", () => {
    expect(isGrokEncryptedReplay(replay([item(CIPHERTEXT)]))).toBe(true);
  });

  it("accepts unpadded standard base64 whose length is not 1 mod 4", () => {
    const padded = Buffer.from("xy").toString("base64");
    const unpadded = padded.replace(/=+$/, "");
    expect(unpadded).toMatch(/^[A-Za-z0-9+/]+$/);
    expect(unpadded.length % 4).not.toBe(1);
    expect(isGrokEncryptedReplay(replay([item(unpadded)]))).toBe(true);
  });

  it.each([
    ["empty items", []],
    ["non-reasoning type", [{ type: "message", encrypted_content: CIPHERTEXT }]],
    ["mixed invalid item", [item(CIPHERTEXT), { type: "reasoning", encrypted_content: "not base64" }]],
    ["plaintext masquerading as ciphertext", [item("password = hunter2")]],
    ["length 1 mod 4", [item("A")]],
    ["url-safe alphabet", [item("AA-_")]],
  ])("rejects %s", (_label, items) => {
    expect(isGrokEncryptedReplay(replay(items))).toBe(false);
  });

  it.each([
    ["not an object", "grok"],
    ["wrong version", { version: 1, provider: "grok", content: JSON.stringify([item(CIPHERTEXT)]) }],
    ["other provider", { version: 2, provider: "openai", content: JSON.stringify([item(CIPHERTEXT)]) }],
    ["malformed JSON", { version: 2, provider: "grok", content: "[" }],
    ["non-string content", { version: 2, provider: "grok", content: [item(CIPHERTEXT)] }],
  ])("rejects %s", (_label, value) => {
    expect(isGrokEncryptedReplay(value)).toBe(false);
  });
});
