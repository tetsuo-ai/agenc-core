import { isCanonicalBase64Body } from "../llm/content-conversion.js";
import { redactSecretsInValue } from "../secrets/sanitizer.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Base64 proves encoding, not origin; absent padding preserves the strict alphabet check at five explicit assistant positions.
function isEncryptedBase64(body: string): boolean {
  if (body.includes("=")) return isCanonicalBase64Body(body);
  if (body.length % 4 === 1) return false;
  return isCanonicalBase64Body(body.padEnd(Math.ceil(body.length / 4) * 4, "="));
}

function encryptedItems(value: unknown): RecordValue[] | undefined {
  if (!record(value) || value.version !== 2 || value.provider !== "grok" ||
      typeof value.content !== "string") return undefined;
  try {
    const items: unknown = JSON.parse(value.content);
    if (Array.isArray(items) && items.length > 0 && items.every((item) =>
      record(item) && item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      isEncryptedBase64(item.encrypted_content))) return items;
  } catch { /* Malformed replay is not eligible. */ }
  return undefined;
}

export function isGrokEncryptedReplay(value: unknown): boolean {
  return encryptedItems(value) !== undefined;
}

function signedGeminiParts(value: unknown): RecordValue[] | undefined {
  if (!record(value) || value.version !== 2 || value.provider !== "gemini" ||
      typeof value.content !== "string") return undefined;
  try {
    const parts: unknown = JSON.parse(value.content);
    if (Array.isArray(parts) && parts.length > 0 && parts.every((part) =>
      record(part) && (part.thoughtSignature === undefined ||
        (typeof part.thoughtSignature === "string" && isEncryptedBase64(part.thoughtSignature)))) &&
      parts.some((part) => part.thoughtSignature !== undefined)) return parts;
  } catch { /* Malformed replay is not eligible. */ }
  return undefined;
}

/**
 * A signed Gemini replay with its text and call arguments removed: each
 * thought signature stays on its own part and each function call keeps its id
 * and name. Durable persistence keeps this form when secret redaction would
 * alter the full replay, so a resumed or compacted turn still sends every call
 * the signature Google gave it. The text and arguments themselves come back
 * from the durable message. Undefined when nothing signed remains.
 */
export function geminiSignatureOnlyReplayContent(content: string): string | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || !parts.every(record)) return undefined;
  const reduced = parts.flatMap((part): RecordValue[] => {
    const signature = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
      ? part.thoughtSignature
      : undefined;
    const call = record(part.functionCall) ? part.functionCall : undefined;
    if (call !== undefined) {
      if (typeof call.name !== "string") return [];
      return [{
        functionCall: {
          ...(typeof call.id === "string" && call.id.length > 0 ? { id: call.id } : {}),
          name: call.name,
          args: {},
        },
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      }];
    }
    if (signature === undefined) return [];
    return [{ ...(part.thought === true ? { thought: true } : {}), text: "", thoughtSignature: signature }];
  });
  if (!reduced.some((part) => part.thoughtSignature !== undefined)) return undefined;
  return JSON.stringify(reduced);
}

/** Only validated ciphertext escapes ordinary redaction, never sibling fields. */
function redactReplay(
  value: unknown,
  redact: typeof redactSecretsInValue,
): unknown {
  const geminiParts = signedGeminiParts(value);
  const items = geminiParts ?? encryptedItems(value);
  if (!items) return undefined;
  const signatureKey = geminiParts ? "thoughtSignature" : "encrypted_content";
  return {
    ...redact(value as RecordValue),
    content: JSON.stringify(items.map((item) => ({
      ...redact(item),
      ...(item[signatureKey] !== undefined ? { [signatureKey]: item[signatureKey] } : {}),
    }))),
  };
}

// Scopes are supplied by durable callers, never inferred from nested key names.
export type DurableRedactionScope = "response" | "history" | "source_history" | "rollout" | "ordinary";
export function redactDurableSecrets<T>(
  value: T,
  scope: DurableRedactionScope,
  redact: typeof redactSecretsInValue = redactSecretsInValue,
): T {
  const redacted = redact(value);
  const restoreResponse = (original: unknown, target: unknown, key: string): void => {
    if (!record(original) || !record(target) || original.role !== "assistant") return;
    const replay = original[key];
    if (!record(replay) || replay.version !== 2 ||
        (replay.provider !== "grok" && replay.provider !== "gemini")) return;
    const safe = redactReplay(replay, redact);
    if (safe === undefined && replay.provider === "gemini") return;
    if (safe === undefined) delete target[key];
    else target[key] = safe;
  };
  const restoreHistory = (original: unknown, target: unknown, key: string): void => {
    if (!Array.isArray(original) || !Array.isArray(target)) return;
    original.forEach((item, index) => {
      // The ordinary sanitizer preserves shared object identity. Isolate this
      // trusted position before restoring bytes, so aliases in arguments stay redacted.
      if (record(target[index])) target[index] = { ...target[index] };
      restoreResponse(item, target[index], key);
    });
  };
  if (scope === "response") restoreResponse(value, redacted, "providerReasoning");
  if (scope === "history") restoreHistory(value, redacted, "providerReasoning");
  if (scope === "source_history") restoreHistory(value, redacted, "provider_reasoning");
  if (scope === "rollout" && record(value) && record(redacted)) {
    const target: RecordValue = redacted;
    if (value.type === "response_item" && record(target.payload)) {
      target.payload = { ...target.payload };
      restoreResponse(value.payload, target.payload, "providerReasoning");
    }
    if (value.type === "compacted" && record(value.payload) && record(target.payload)) {
      target.payload = { ...target.payload };
      const payload = target.payload as RecordValue;
      if (Array.isArray(payload.replacementHistory)) payload.replacementHistory = [...payload.replacementHistory];
      restoreHistory(value.payload.replacementHistory, payload.replacementHistory, "providerReasoning");
    }
  }
  return redacted;
}
