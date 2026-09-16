import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { redactSecrets, REDACTED_SECRET } from "../../src/secrets/sanitizer.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
  llmMessageToReplacementResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { parseRolloutLine, serializeRolloutItem } from "../../src/session/rollout-item.js";

// A generated one-pixel PNG. The private ancillary chunk contains harmless
// synthetic bytes whose BASE64 encoding happens to match the base58 heuristic.
// There are no real credentials, benchmark images, or provider calls here.
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

function syntheticPng(withCollision: boolean): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  // After signature + IHDR + chunk header, one byte aligns the collision
  // with a base64 quantum. The zero characters delimit the base58-only run.
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

function isCanonicalBase64Image(url: string): boolean {
  const body = url.slice("data:image/png;base64,".length);
  return url.startsWith("data:image/png;base64,") &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body) &&
    Buffer.from(body, "base64").toString("base64") === body;
}

const projections = [
  ["durable", llmMessageToDurableResponseItem],
  ["checkpoint", llmMessageToCheckpointResponseItem],
  ["replacement", llmMessageToReplacementResponseItem],
] as const;

function roundTrip(source: LLMMessage, project: typeof llmMessageToDurableResponseItem) {
  const parsed = parseRolloutLine(serializeRolloutItem({
    type: "response_item", payload: project(source),
  }));
  if (parsed?.type !== "response_item") throw new Error("Wrong durable record type");
  return responseItemToLlmMessage(parsed.payload);
}

function assertNoBrokenInlineImages(message: LLMMessage) {
  expect(Array.isArray(message.content)).toBe(true);
  if (!Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type === "image_url") {
      expect(isCanonicalBase64Image(part.image_url.url)).toBe(true);
    }
  }
  expect(JSON.stringify(message.content)).toContain("synthetic thumbnail");
}

describe("independent durable image projection", () => {
  test("the synthetic PNG is valid base64 and triggers the existing heuristic", () => {
    const url = syntheticPng(true);
    expect(isCanonicalBase64Image(url)).toBe(true);
    expect(redactSecrets(url)).toContain(REDACTED_SECRET);
    expect(isCanonicalBase64Image(redactSecrets(url))).toBe(false);
  });

  test.each(projections)("%s never replays partially redacted image bytes", (_name, project) => {
    const message = roundTrip({
      role: "user",
      content: [
        { type: "text", text: "synthetic thumbnail" },
        { type: "image_url", image_url: { url: syntheticPng(true) } },
      ],
    }, project);
    // A safe implementation may preserve validated binary or replace the
    // altered carrier with an omission. It must never transmit damaged base64.
    assertNoBrokenInlineImages(message);
  });

  test.each(projections)("%s keeps an ordinary unchanged PNG", (_name, project) => {
    const url = syntheticPng(false);
    expect(redactSecrets(url)).toBe(url);
    const message = roundTrip({
      role: "user",
      content: [
        { type: "text", text: "synthetic thumbnail" },
        { type: "image_url", image_url: { url } },
      ],
    }, project);
    assertNoBrokenInlineImages(message);
    expect(JSON.stringify(message.content)).toContain(url);
  });

  test.each(projections)("%s still redacts a fake credential outside binary data", (_name, project) => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    const message = roundTrip({
      role: "user", content: `synthetic thumbnail credential ${fakeCredential}`,
    }, project);
    expect(message.content).toContain(REDACTED_SECRET);
    expect(message.content).not.toContain(fakeCredential);
  });

  test.each(projections)("%s does not trust a binary label around fake plaintext credentials", (_name, project) => {
    const fakeCredential = `sk-${"x".repeat(36)}`;
    const source: LLMMessage = {
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: `data:image/png;base64,${fakeCredential}` },
      }],
    };
    expect(JSON.stringify(project(source))).not.toContain(fakeCredential);
    expect(JSON.stringify(roundTrip(source, project))).not.toContain(fakeCredential);
  });
});
