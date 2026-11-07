import { expect, test, vi } from "vitest";

// sec-rv1 item 6: one durable save redacted each image three to four times, and each time decoded and checked it.
const counted = vi.hoisted(() => ({ inspections: 0 }));
vi.mock("../../src/utils/image-validation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/image-validation.js")>();
  return {
    ...original,
    inspectImageBytes: (bytes: Uint8Array) => {
      counted.inspections += 1;
      return original.inspectImageBytes(bytes);
    },
  };
});

import type { LLMMessage } from "../../src/llm/types.js";
import { REAL_SCREENSHOT_CROP_JPEG } from "../helpers/real-screenshot-crop.js";

/** The crop with a JPEG comment "shotN" after its start marker: a distinct real screenshot per call. */
function screenshot(index: number): string {
  const bytes = Buffer.from(REAL_SCREENSHOT_CROP_JPEG.slice(REAL_SCREENSHOT_CROP_JPEG.indexOf(",") + 1), "base64");
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from(`shot${index}`, "ascii")]);
  return `data:image/jpeg;base64,${Buffer.concat([bytes.subarray(0, 2), comment, bytes.subarray(2)]).toString("base64")}`;
}

test("one durable save checks each image once and keeps it", async () => {
  // The test setup may have loaded the sanitizer already; load the save path afresh so it sees the counter.
  vi.resetModules();
  const { llmMessageToDurableResponseItem } = await import("../../src/session/message-history-conversion.js");
  const { parseRolloutLine, serializeRolloutItem } = await import("../../src/session/rollout-item.js");
  const urls = [screenshot(1), screenshot(2)];
  const message: LLMMessage = { role: "tool", toolCallId: "read", toolName: "FileRead", content: [
    { type: "text", text: "Read image shot-1.jpg and shot-2.jpg" },
    { type: "image_url", image_url: { url: urls[0]! } },
    { type: "image_url", image_url: { url: urls[1]! } },
  ] };
  counted.inspections = 0;
  const line = serializeRolloutItem({ type: "response_item", payload: llmMessageToDurableResponseItem(message) });
  expect(counted.inspections).toBe(2);
  const item = parseRolloutLine(line.trim());
  expect(item?.type === "response_item" ? item.payload.content : undefined).toEqual(message.content);
  // The verdicts belong to that save's objects, not to the body text: a later save of the same images in new
  // objects checks them again, so nothing keeps an image body in memory after a save.
  const again: LLMMessage = structuredClone(message);
  counted.inspections = 0;
  serializeRolloutItem({ type: "response_item", payload: llmMessageToDurableResponseItem(again) });
  expect(counted.inspections).toBe(2);
});
