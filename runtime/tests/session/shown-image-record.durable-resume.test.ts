import { expect, test, vi } from "vitest";

import { OMITTED_BINARY_CARRIER_TEXT } from "../../src/llm/content-conversion.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { DEEPSEEK_MODELS } from "../../src/llm/registry/deepseek-models.js";
import type { LLMContentPart, LLMMessage } from "../../src/llm/types.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { capturePromptCacheState, restorePromptCacheState } from "../../src/session/prompt-cache-state.js";
import {
  boundContextImagesForProvider,
  contextImageShownBefore,
  rememberSentContextImages,
} from "../../src/session/query-image-budget.js";
import { parseRolloutLine, serializeRolloutItem } from "../../src/session/rollout-item.js";
import { frameUntrustedToolResultContent } from "../../src/tools/untrusted-tool-result-framing.js";
import { createSuccessfulChatResponse } from "../llm/providers/openai-compatible-test-helpers.js";
import { REAL_SCREENSHOT_CROP_JPEG } from "../helpers/real-screenshot-crop.js";

// img32 item 2: 0.19.31 saves the shown-image record with the prompt cache state (fx31). These cases take the
// conversation through the durable record the way a daemon restart does (each message written as a rollout line and
// read back), restore the saved record into a new session object, and compare the native DeepSeek request bodies
// before and after.

const cacheProvider = new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna" });

/** A canonical base64 body of `length` characters with no base58 run longer than one character. */
const plainBody = (seed: number, length: number) => `${String(seed).padStart(4, "0")}${"A0".repeat(length / 2)}`.slice(0, length);
/** The same, with an 85-character base58 run between two slashes: canonical base64, but no image. */
const base58RunBody = (seed: number, length: number) => `${String(seed).padStart(4, "0")}///${"B".repeat(85)}////${"A0".repeat(length / 2)}`.slice(0, length);

/**
 * Six distinct real screenshots: the crop with a JPEG comment segment "shotN" after its start marker. The
 * nine-byte segment keeps the rest of the base64 aligned, so each one still holds the crop's base58 run.
 */
function screenshot(index: number): string {
  const bytes = Buffer.from(REAL_SCREENSHOT_CROP_JPEG.slice(REAL_SCREENSHOT_CROP_JPEG.indexOf(",") + 1), "base64");
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from(`shot${index}`, "ascii")]);
  return Buffer.concat([bytes.subarray(0, 2), comment, bytes.subarray(2)]).toString("base64");
}

function readImage(index: number, body: string, mediaType = "image/png"): LLMMessage[] {
  const id = `call_${index}`;
  const content: LLMContentPart[] = [
    { type: "text", text: `Read image cache-reference-${index}.png (1.0KB, ${mediaType})` },
    { type: "image_url", image_url: { url: `data:${mediaType};base64,${body}` } },
  ];
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "FileRead", arguments: JSON.stringify({ file_path: `cache-reference-${index}.png` }) }] },
    { role: "tool", toolCallId: id, toolName: "FileRead", content: frameUntrustedToolResultContent("FileRead", content, "workspace", true) },
  ];
}

/** Six reads, one request each, as the live session sends them; returns the history and the live session's last request. */
function liveSession(body: (index: number) => string, budget: number, mediaType?: string) {
  const live = {};
  const history: LLMMessage[] = [{ role: "user", content: "Read the six images one at a time." }];
  let last: LLMMessage[] = [];
  for (let index = 1; index <= 6; index++) {
    history.push(...readImage(index, body(index), mediaType));
    last = boundContextImagesForProvider(history, budget, "deepseek", contextImageShownBefore(live)).messages;
    rememberSentContextImages(live, last, history);
  }
  history.push({ role: "assistant", content: "Read all six images." });
  return { live, history, last };
}

/** A message written to the rollout and read back, as a restarted session reads it. */
function throughRollout(message: LLMMessage): LLMMessage {
  const line = parseRolloutLine(serializeRolloutItem({ type: "response_item", payload: llmMessageToDurableResponseItem(message) }));
  if (line?.type !== "response_item") throw new Error("not a response item");
  return responseItemToLlmMessage(line.payload);
}

/** The resumed session: history read back from its durable record, shown record restored from its saved state line. */
function resumed(live: object, history: readonly LLMMessage[]) {
  const durable = history.map(throughRollout);
  const cache = capturePromptCacheState(live, cacheProvider);
  const line = parseRolloutLine(serializeRolloutItem({ type: "session_state", payload: { promptCache: cache } }).trim());
  const session = {};
  restorePromptCacheState(session, cacheProvider, [line!]);
  return { session, durable, digests: cache.shownImageDigests ?? [] };
}

async function wire(messages: readonly LLMMessage[]): Promise<Array<{ role: string; content?: unknown }>> {
  const model = DEEPSEEK_MODELS[0]!.model;
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(createSuccessfulChatResponse("img32-resume")(model));
  await new DeepSeekProvider({ apiKey: "deepseek-test", model, fetchImpl }).chat([...messages]);
  return JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).messages as Array<{ role: string; content?: unknown }>;
}

const sentImages = (messages: ReadonlyArray<{ content?: unknown }>) =>
  messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "image_url") : []).length;

test("after a restart the first request repeats the last live one for images the durable record keeps", async () => {
  const { live, history, last } = liveSession((index) => plainBody(index, 1200), 6000);
  const { session, durable, digests } = resumed(live, history);
  expect(digests).toHaveLength(6);
  // The durable record keeps every image.
  expect(sentImages(durable)).toBe(6);
  const first = boundContextImagesForProvider([...durable, { role: "user", content: "Continue." }], 6000, "deepseek", contextImageShownBefore(session)).messages;
  const before = await wire(last);
  const after = await wire(first);
  // Byte for byte up to the end of the last live request: the same notes, the same images, nothing sent again.
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  expect(sentImages(after)).toBe(sentImages(before));
  expect(sentImages(before)).toBeGreaterThan(0);
  expect(JSON.stringify(before)).not.toContain("an earlier screenshot is no longer in context");
});

test("real screenshots stay in the durable record and resume as shown, with the cached prefix", async () => {
  // img32: on 0.19.31 the base58 wallet-key rule matched a run in almost every real screenshot's base64 (all 40
  // budget-full screenshots, 17 of 17 MPV captures), so durable persistence stored OMITTED_BINARY_CARRIER_TEXT and a
  // restarted session lost them. The rule now skips the body of an image block that validates as an image.
  const { live, history, last } = liveSession(screenshot, 15_000, "image/jpeg");
  const { session, durable, digests } = resumed(live, history);
  expect(digests).toHaveLength(6);
  expect(sentImages(durable)).toBe(6);
  expect(JSON.stringify(durable)).not.toContain(OMITTED_BINARY_CARRIER_TEXT);
  const first = boundContextImagesForProvider([...durable, { role: "user", content: "Continue." }], 15_000, "deepseek", contextImageShownBefore(session)).messages;
  const before = await wire(last);
  const after = await wire(first);
  expect(sentImages(before)).toBe(3);
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
  expect(sentImages(after)).toBe(3);
  // Three results carry the shown note before and after the restart; none reads as unseen.
  expect(JSON.stringify(before)).not.toContain("an earlier screenshot is no longer in context");
});

test("a body that does not validate as an image keeps the base58 rule, so the durable record leaves it out", async () => {
  // Canonical base64 with an 85-character base58 run that is no image: durable persistence stores
  // OMITTED_BINARY_CARRIER_TEXT instead of it, and a restarted session cannot show it again.
  const { live, history, last } = liveSession((index) => base58RunBody(index, 1200), 6000);
  const { session, durable, digests } = resumed(live, history);
  expect(digests).toHaveLength(6);
  expect(sentImages(durable)).toBe(0);
  const first = boundContextImagesForProvider([...durable, { role: "user", content: "Continue." }], 6000, "deepseek", contextImageShownBefore(session)).messages;
  const before = await wire(last);
  const after = await wire(first);
  // Nothing is sent again, but every result now carries the persistence note, the images still in view are gone,
  // and the request differs from the last live one at the first image.
  expect(sentImages(before)).toBeGreaterThan(0);
  expect(sentImages(after)).toBe(0);
  const tools = after.filter((message) => message.role === "tool").map((message) => String(message.content));
  expect(tools).toHaveLength(6);
  for (const text of tools) expect(text).toContain(OMITTED_BINARY_CARRIER_TEXT);
  const firstDifference = after.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(before[index]));
  expect(after[firstDifference]).toMatchObject({ role: "tool" });
  expect(String(after[firstDifference]!.content)).toContain("cache-reference-1.png");
});
