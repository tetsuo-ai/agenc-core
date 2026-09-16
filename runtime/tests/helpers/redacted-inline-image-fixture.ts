import { expect } from "vitest";
import { deflateSync } from "node:zlib";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
  llmMessageToReplacementResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { parseRolloutLine, serializeRolloutItem } from "../../src/session/rollout-item.js";

// Generated one-pixel PNG with harmless bytes chosen to collide with the
// base58 secret heuristic. Never uses benchmark data or real credentials.
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}

export function syntheticPng(withCollision: boolean): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const collision = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(`00${"A".repeat(80)}00`, "base64"),
  ]);
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...(withCollision ? [pngChunk("raNd", collision)] : []),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

export function isCanonicalBase64Image(url: string): boolean {
  const body = url.slice("data:image/png;base64,".length);
  return url.startsWith("data:image/png;base64,") &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body) &&
    Buffer.from(body, "base64").toString("base64") === body;
}


export const projections = [
  ["durable", llmMessageToDurableResponseItem],
  ["checkpoint", llmMessageToCheckpointResponseItem],
  ["replacement", llmMessageToReplacementResponseItem],
] as const;

/** Persist a message through one projection and read it back, as a session would. */
export function roundTrip(
  source: LLMMessage,
  project: typeof llmMessageToDurableResponseItem,
): LLMMessage {
  const parsed = parseRolloutLine(serializeRolloutItem({
    type: "response_item", payload: project(source),
  }));
  if (parsed?.type !== "response_item") throw new Error("Wrong durable record type");
  return responseItemToLlmMessage(parsed.payload);
}

/**
 * Every surviving inline carrier must still be canonical, and the message must
 * keep its sibling text. A safe implementation may preserve validated binary or
 * replace an altered carrier with an omission; it must never transmit damaged
 * base64.
 */
export function assertNoBrokenInlineImages(message: LLMMessage): void {
  expect(Array.isArray(message.content)).toBe(true);
  if (!Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type === "image_url") {
      expect(isCanonicalBase64Image(part.image_url.url)).toBe(true);
    }
  }
  expect(JSON.stringify(message.content)).toContain("synthetic thumbnail");
}
