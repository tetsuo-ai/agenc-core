import { createHash } from "node:crypto";
import { extractXaiReasoningReplay } from "../../src/llm/wire/responses-xai.js";
// Deterministic pseudorandom bytes keep the sanitizer regression reproducible.
const bytes = Buffer.concat(Array.from({ length: 2400 }, (_, index) =>
  createHash("sha256").update(`grok-replay-${index}`).digest()));
export const encryptedItem = { type: "reasoning", id: "reasoning-large", encrypted_content: bytes.toString("base64"), summary: [] };
export const largeGrokReplay = extractXaiReasoningReplay([encryptedItem], "Grok-4.7");

// Synthetic only: live metadata recorded unpadded standard-base64 lengths 158 and 343.
export const unpaddedGrokReplays = [158, 343].map((length) => {
  const padded = bytes.subarray(0, Math.floor(length * 3 / 4)).toString("base64");
  const paddingStart = padded.indexOf("=");
  const encrypted_content = paddingStart === -1 ? padded : padded.slice(0, paddingStart);
  return { length, encrypted_content, replay: extractXaiReasoningReplay([
    { type: "reasoning", id: "reasoning-synthetic", encrypted_content, summary: [] },
  ], "grok-4.7") };
});
