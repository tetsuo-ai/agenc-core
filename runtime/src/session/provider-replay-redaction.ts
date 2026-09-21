import { redactSecretsInValue } from "../secrets/sanitizer.js";

/** Grok replay is opaque encrypted provider state, not plaintext reasoning. */
export function isGrokEncryptedReplay(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const replay = value as Record<string, unknown>;
  if (replay.version !== 2 || replay.provider !== "grok" ||
      typeof replay.content !== "string") return false;
  try {
    const items: unknown = JSON.parse(replay.content);
    return Array.isArray(items) && items.length > 0 && items.every((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item) &&
      item.type === "reasoning" && typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0);
  } catch {
    return false;
  }
}

/** Only durable replay fields are exempt; ordinary message secrets still redact. */
export function redactDurableSecrets<T>(value: T): T {
  return redactSecretsInValue(value, (key, nested) =>
    (key === "providerReasoning" || key === "provider_reasoning") &&
    isGrokEncryptedReplay(nested));
}
