import { createHash } from "node:crypto";
import { extractXaiReasoningReplay } from "../../src/llm/wire/responses-xai.js";
// Deterministic pseudorandom bytes keep the sanitizer regression reproducible.
const bytes = Buffer.concat(Array.from({ length: 2400 }, (_, index) =>
  createHash("sha256").update(`grok-replay-${index}`).digest()));
export const encryptedItem = { type: "reasoning", id: "reasoning-large", encrypted_content: bytes.toString("base64"), summary: [] };
export const largeGrokReplay = extractXaiReasoningReplay([encryptedItem], "Grok-4.7");
