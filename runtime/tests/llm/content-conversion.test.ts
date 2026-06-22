import { describe, expect, test } from "vitest";
import type { LLMMessage } from "./types.js";

import {
  cloneLlmContent,
  cloneLlmMessageSnapshot,
  fromRuntimeMessageContent,
  toRuntimeMessageContent,
} from "./content-conversion.js";

describe("LLM content conversion", () => {
  test("clones provider-compatible content parts and filters malformed parts", () => {
    const source = [
      { type: "text", text: "hello" },
      {
        type: "image_url",
        image_url: { url: "file:///tmp/screenshot.png", detail: "high" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "ZmFrZS1wZGY=",
        },
        title: "notes.pdf",
        filename: "notes.pdf",
        fallbackText: "document text",
        fallbackTextTruncated: false,
        fallbackTextError: "ocr warning",
      },
      { type: "image_url", image_url: { url: 123 } },
      null,
      { type: "unknown" },
    ];

    const cloned = cloneLlmContent(source);

    expect(cloned).toEqual([
      { type: "text", text: "hello" },
      {
        type: "image_url",
        image_url: { url: "file:///tmp/screenshot.png" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "ZmFrZS1wZGY=",
        },
        title: "notes.pdf",
        filename: "notes.pdf",
        fallbackText: "document text",
        fallbackTextTruncated: false,
        fallbackTextError: "ocr warning",
      },
    ]);
    expect(cloned).not.toBe(source);
    expect(Array.isArray(cloned) ? cloned[1] : undefined).not.toBe(source[1]);
  });

  test("converts provider-compatible image content to runtime image blocks", () => {
    expect(
      toRuntimeMessageContent([
        { type: "text", text: "see this" },
        {
          type: "image_url",
          image_url: { url: "https://example.test/image.png" },
        },
      ]),
    ).toEqual([
      { type: "text", text: "see this" },
      {
        type: "image",
        source: { type: "url", url: "https://example.test/image.png" },
      },
    ]);
  });

  test("clones LLM messages for async snapshots", () => {
    const message: LLMMessage = {
      role: "assistant",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "ZmFrZS1wZGY=",
          },
          fallbackText: "document text",
        },
      ],
      toolCalls: [{ id: "call-1", name: "Read", arguments: "{}" }],
      runtimeOnly: { anchorPreserve: true },
    };

    const cloned = cloneLlmMessageSnapshot(message);

    expect(cloned).toEqual(message);
    expect(cloned).not.toBe(message);
    expect(cloned.content).not.toBe(message.content);
    expect(Array.isArray(cloned.content) ? cloned.content[0] : undefined)
      .not.toBe(message.content[0]);
    const clonedDocument = Array.isArray(cloned.content)
      ? cloned.content[0]
      : undefined;
    expect(clonedDocument?.type).toBe("document");
    if (clonedDocument?.type === "document") {
      const originalDocument = Array.isArray(message.content)
        ? message.content[0]
        : undefined;
      expect(originalDocument?.type).toBe("document");
      if (originalDocument?.type === "document") {
        expect(clonedDocument.source).not.toBe(originalDocument.source);
      }
    }
    expect(cloned.toolCalls).not.toBe(message.toolCalls);
    expect(cloned.runtimeOnly).not.toBe(message.runtimeOnly);
  });

  test("converts runtime content back to LLM content", () => {
    expect(
      fromRuntimeMessageContent([
        { type: "text", text: "see this" },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image.png" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "ZmFrZS1wZGY=",
          },
          fallbackText: "document text",
          fallbackTextTruncated: true,
        },
      ]),
    ).toEqual([
      { type: "text", text: "see this" },
      {
        type: "image_url",
        image_url: { url: "https://example.test/image.png" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "ZmFrZS1wZGY=",
        },
        fallbackText: "document text",
        fallbackTextTruncated: true,
      },
    ]);
  });

  test("collapses runtime text-only arrays back to string content", () => {
    expect(
      fromRuntimeMessageContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("preserves existing fallback behavior for empty and non-array content", () => {
    expect(cloneLlmContent(123)).toBe("");
    expect(cloneLlmContent([{ type: "unknown" }])).toEqual([]);
    expect(toRuntimeMessageContent(123)).toEqual([]);
    expect(fromRuntimeMessageContent(123)).toBe("");
  });
});
