import { describe, expect, it } from "vitest";

import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMProviderError,
  LLMServerError,
} from "../../src/llm/errors.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { isProviderImageRejection } from "../../src/recovery/api-errors.js";
import {
  isRecoverableImageRejection,
  rejectImagesForRetry,
} from "../../src/recovery/image-rejection.js";
import {
  buildDefaultTriggerOrder,
  type TriggerActions,
  type TriggerOutcome,
} from "../../src/recovery/triggers.js";
import { rejectedImagesFor } from "../../src/session/query-image-safety.js";
import type { Session } from "../../src/session/session.js";
import { buildInitialTurnState, type ToolUseBlock } from "../../src/session/turn-state.js";
import { postSampleRecovery } from "../../src/phases/post-sample-recovery.js";
import { mkCtx, mkSession } from "../fixtures.js";

// The refusal DeepSeek returned for FileRead's fake.png (conv-mucyox5d).
const deepseekRefusal = () =>
  new LLMProviderError(
    "deepseek",
    ".messages[25].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif. [openai_category=unknown]",
    400,
  );

const OLD_IMAGE = "data:image/png;base64,T0xE";
const FLASH_ROUTE = "deepseek/deepseek-flash";
const NEW_IMAGE = "data:image/png;base64,TkVX";

function requestWithImages(): LLMMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: OLD_IMAGE } }] },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "FileRead", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", toolName: "FileRead", content: [{ type: "image_url", image_url: { url: NEW_IMAGE } }] },
  ];
}

function stateFor(messages: LLMMessage[], toolUseBlocks: ToolUseBlock[] = []) {
  const state = buildInitialTurnState(mkCtx(), { role: "user", content: "go" });
  state.messagesForQuery = messages;
  state.toolUseBlocks = toolUseBlocks;
  return state;
}

function fakeSession(): Session {
  return { services: { provider: { name: "deepseek" } } } as unknown as Session;
}

describe("isProviderImageRejection", () => {
  it.each([
    ["DeepSeek unsupported image", deepseekRefusal()],
    ["Anthropic invalid image", new LLMProviderError("anthropic", "messages.1.content.0.image.source.base64: The image was specified using the image/png media type, but does not appear to be a valid png image", 400)],
    ["Anthropic size limit", new LLMProviderError("anthropic", "messages.3.content.1.image.source.base64: image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes", 400)],
    ["Gemini", new LLMProviderError("gemini", "Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting", 400)],
    ["wire contract", new TypeError("The selected provider model does not support image input")],
    ["image in a 422", new LLMProviderError("openrouter", "Image URLs are only allowed for messages with role 'user'", 422)],
  ])("recognizes %s", (_label, error) => {
    expect(isProviderImageRejection(error)).toBe(true);
  });

  it.each([
    ["context overflow", new LLMContextWindowExceededError("deepseek", "images count toward the maximum context length")],
    ["server error", new LLMServerError("deepseek", 503, "image service unavailable")],
    ["authentication", new LLMAuthenticationError("deepseek", 401, "invalid image api key")],
    ["a 400 about something else", new LLMProviderError("deepseek", "Invalid parameter: tools[0].function.name", 400)],
    ["a 404 that mentions an image", new LLMProviderError("deepseek", "model deepseek-image not found", 404)],
    ["a partial response", Object.assign(deepseekRefusal(), { response: { finishReason: "error", partial: true } })],
    ["no error", undefined],
  ])("ignores %s", (_label, error) => {
    expect(isProviderImageRejection(error)).toBe(false);
  });

  it("finds the refusal under a wrapper", () => {
    expect(isProviderImageRejection(new Error("stream failed", { cause: deepseekRefusal() }))).toBe(true);
  });
});

describe("the media trigger takes provider image refusals", () => {
  const actions: TriggerActions = {
    async on413(): Promise<TriggerOutcome> { return { kind: "pass" }; },
    async onMedia(): Promise<TriggerOutcome> { return { kind: "pass" }; },
    async onMaxOutputTokens(): Promise<TriggerOutcome> { return { kind: "pass" }; },
    async onStopHookBlocking(): Promise<TriggerOutcome> { return { kind: "pass" }; },
    async onStreamingFallback(): Promise<TriggerOutcome> { return { kind: "pass" }; },
    async onFallbackError(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  };
  const firstMatch = (state: ReturnType<typeof stateFor>, streamError: unknown) =>
    buildDefaultTriggerOrder(actions).find((trigger) =>
      trigger.match({ session: {} as Session, state, lastMessage: undefined, streamError }))?.name;

  it("matches a refusal while the request carries an image", () => {
    expect(firstMatch(stateFor(requestWithImages()), deepseekRefusal())).toBe("isWithheldMedia");
  });

  it("does not match once the request carries no image", () => {
    expect(firstMatch(stateFor([{ role: "user", content: "go" }]), deepseekRefusal())).toBeUndefined();
  });

  it("does not match after a tool call streamed", () => {
    const streamed: ToolUseBlock[] = [{ type: "tool_use", id: "t", name: "Write", input: {} }];
    expect(isRecoverableImageRejection(stateFor(requestWithImages(), streamed), deepseekRefusal())).toBe(false);
    expect(firstMatch(stateFor(requestWithImages(), streamed), deepseekRefusal())).toBeUndefined();
  });
});

describe("rejectImagesForRetry", () => {
  it("leaves out the newest images first, then every image, then gives up", () => {
    const session = fakeSession();
    const state = stateFor(requestWithImages());

    expect(rejectImagesForRetry(session, state, deepseekRefusal(), FLASH_ROUTE)).toMatchObject({
      rejected: 1,
      scope: "newest",
      reason: expect.stringContaining("You have uploaded an unsupported image"),
    });
    expect(rejectedImagesFor(session, FLASH_ROUTE)?.size).toBe(1);

    // The same request refused again: nothing new is left among the newest.
    expect(rejectImagesForRetry(session, state, deepseekRefusal(), FLASH_ROUTE)).toMatchObject({
      rejected: 1,
      scope: "all",
    });
    expect(rejectedImagesFor(session, FLASH_ROUTE)?.size).toBe(2);

    expect(rejectImagesForRetry(session, state, deepseekRefusal(), FLASH_ROUTE)).toBeUndefined();
  });
});

describe("the media trigger retries only a classified image refusal", () => {
  // Review finding: the trigger also matches a withheld media-size message
  // such as a PDF page limit, and the retry then dropped unrelated images,
  // even after a tool call had streamed.
  const route = "stub-provider/test-model";

  function withheldMedia(text: string, streamError?: unknown, streamed: ToolUseBlock[] = []) {
    const ctx = mkCtx();
    const { session, events } = mkSession();
    const state = stateFor(requestWithImages(), streamed);
    state.assistantMessages = [
      { uuid: "withheld-media", role: "assistant", text, toolCalls: [] },
    ];
    if (streamError !== undefined) {
      (state as typeof state & { lastStreamError?: unknown }).lastStreamError = streamError;
    }
    return { ctx, session, events, state };
  }

  it("leaves images alone for a PDF page-limit message", async () => {
    const { ctx, session, events, state } = withheldMedia(
      "A maximum of 100 PDF pages may be provided.",
    );

    await postSampleRecovery(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(rejectedImagesFor(session, route)).toBeUndefined();
    expect(events.some((event) =>
      event.msg.type === "error" &&
      (event.msg.payload as { cause?: string }).cause === "image_error")).toBe(true);
  });

  it("samples again for an image refusal only before any tool call streamed", async () => {
    const sizeMessage =
      "messages.3.content.1.image.source.base64: image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes";
    const before = withheldMedia(sizeMessage, deepseekRefusal());
    await postSampleRecovery(before.state, before.ctx, before.session);
    expect(before.state.transition).toEqual({ reason: "image_rejection_retry" });
    expect(rejectedImagesFor(before.session, route)?.size).toBe(1);

    const after = withheldMedia(sizeMessage, deepseekRefusal(), [
      { type: "tool_use", id: "t-streamed", name: "Write", input: {} },
    ]);
    await postSampleRecovery(after.state, after.ctx, after.session);
    expect(after.state.transition).toBeUndefined();
    expect(rejectedImagesFor(after.session, route)).toBeUndefined();
  });
});
