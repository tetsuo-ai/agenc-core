import { describe, expect, test } from "vitest";
import {
  FallbackTriggeredError,
  getPromptTooLongTokenGap,
  isFallbackTriggeredError,
  isMediaSizeError,
  isMediaTooLargeMessage,
  isPromptTooLongMessage,
  isTransientProviderError,
  isWithheld413Message,
  isWithheldMaxOutputTokens,
  parsePromptTooLongTokenCounts,
} from "./api-errors.js";
import type { AssistantMessage } from "../session/turn-state.js";

function mkMsg(
  text: string,
  extras: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    uuid: crypto.randomUUID(),
    role: "assistant",
    text,
    toolCalls: [],
    ...extras,
  };
}

describe("FallbackTriggeredError", () => {
  test("isFallbackTriggeredError detects instance + duck-typed", () => {
    const err = new FallbackTriggeredError("grok-4", "grok-4-fast");
    expect(isFallbackTriggeredError(err)).toBe(true);
    expect(err.fromModel).toBe("grok-4");
    expect(err.toModel).toBe("grok-4-fast");
  });
  test("isFallbackTriggeredError negative cases", () => {
    expect(isFallbackTriggeredError(new Error("boom"))).toBe(false);
    expect(isFallbackTriggeredError(null)).toBe(false);
  });
});

describe("Prompt-too-long helpers", () => {
  test("isPromptTooLongMessage + parse", () => {
    const msg = mkMsg("Prompt is too long: 137500 tokens > 135000 maximum");
    expect(isPromptTooLongMessage(msg)).toBe(true);
    const counts = parsePromptTooLongTokenCounts(msg.text!);
    expect(counts.actualTokens).toBe(137500);
    expect(counts.limitTokens).toBe(135000);
  });
  test("getPromptTooLongTokenGap with errorDetails", () => {
    const msg = {
      ...mkMsg("Prompt is too long"),
      errorDetails: "prompt is too long: 137500 tokens > 135000 maximum",
    } as AssistantMessage & { errorDetails: string };
    expect(getPromptTooLongTokenGap(msg)).toBe(2500);
  });
  test("non-PTL message → undefined", () => {
    expect(
      getPromptTooLongTokenGap(mkMsg("all good")),
    ).toBeUndefined();
  });
});

describe("Media / max-output-tokens / withhold helpers", () => {
  test("isMediaSizeError detects image/PDF patterns", () => {
    expect(isMediaSizeError("image exceeds 5MB maximum size limit")).toBe(true);
    expect(isMediaSizeError("image dimensions exceed the many-image limit")).toBe(
      true,
    );
    expect(isMediaSizeError("maximum of 50 PDF pages allowed")).toBe(true);
    expect(isMediaSizeError("some unrelated error")).toBe(false);
  });

  test("isMediaTooLargeMessage uses text + errorDetails", () => {
    const direct = mkMsg("image exceeds 5MB maximum");
    expect(isMediaTooLargeMessage(direct)).toBe(true);
    const viaDetails = {
      ...mkMsg(""),
      errorDetails: "image exceeds maximum",
    } as AssistantMessage & { errorDetails: string };
    expect(isMediaTooLargeMessage(viaDetails)).toBe(true);
  });

  test("isWithheldMaxOutputTokens matches apiError flag", () => {
    expect(
      isWithheldMaxOutputTokens(mkMsg("", { apiError: "max_output_tokens" })),
    ).toBe(true);
    expect(isWithheldMaxOutputTokens(mkMsg("hello"))).toBe(false);
  });

  test("isWithheld413Message matches apiError + PTL text", () => {
    expect(
      isWithheld413Message(mkMsg("", { apiError: "context_window_exceeded" })),
    ).toBe(true);
    expect(isWithheld413Message(mkMsg("Prompt is too long"))).toBe(true);
  });
});

describe("isTransientProviderError", () => {
  test("ECONNRESET + 502 + stream_idle → transient", () => {
    expect(isTransientProviderError(new Error("ECONNRESET"))).toBe(true);
    const err502 = new Error("bad gateway");
    (err502 as unknown as { status: number }).status = 502;
    expect(isTransientProviderError(err502)).toBe(true);
    expect(isTransientProviderError(new Error("stream_idle"))).toBe(true);
  });
  test("401 + generic syntax → not transient", () => {
    const err401 = new Error("unauthorized");
    (err401 as unknown as { status: number }).status = 401;
    expect(isTransientProviderError(err401)).toBe(false);
    expect(isTransientProviderError(new Error("syntax error"))).toBe(false);
  });
});
