import { isCanonicalEventPayload } from "./recovery-journal-schema.js";
import { MAX_RECOVERY_CANONICAL_LINE_BYTES } from "./recovery-contract.js";

// Legacy resume writers embedded the display transcript here. Keep its bytes
// and checkpoint hashes intact under a separate finite cache ceiling. This
// event is not model history or execution authority.
export const MAX_LEGACY_SESSION_CONFIGURED_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_PREFIX = /^\{"type":"event_msg","payload":\{"id":"(?:[^"\\]|\\.)*","msg":\{"type":"session_configured","payload":/u;

export function recoveryPendingLineCeiling(prefix: Buffer | readonly Buffer[], ordinary: number): number {
  let bytes: Buffer;
  if (Buffer.isBuffer(prefix)) bytes = prefix.subarray(0, 4096);
  else {
    const parts: Buffer[] = [];
    let remaining = 4096;
    for (const part of prefix) {
      parts.push(part.subarray(0, remaining));
      remaining -= Math.min(part.byteLength, remaining);
      if (remaining === 0) break;
    }
    bytes = Buffer.concat(parts);
  }
  return ordinary === MAX_RECOVERY_CANONICAL_LINE_BYTES &&
    CACHE_PREFIX.test(bytes.toString("utf8"))
    ? MAX_LEGACY_SESSION_CONFIGURED_CACHE_BYTES
    : ordinary;
}

export function isLegacyConfiguredCacheWithinCeiling(content: Buffer, ordinary: number): boolean {
  if (ordinary !== MAX_RECOVERY_CANONICAL_LINE_BYTES ||
    content.byteLength > MAX_LEGACY_SESSION_CONFIGURED_CACHE_BYTES ||
    recoveryPendingLineCeiling(content, ordinary) === ordinary) return false;
  try {
    const item = JSON.parse(content.toString("utf8"));
    const event = item.payload;
    const msg = event.msg;
    if (item.type !== "event_msg" || msg.type !== "session_configured" ||
      !isCanonicalEventPayload("session_configured", msg.payload)) return false;
    // Only the redundant display cache may exceed the ordinary ceiling.
    const withoutCache = { ...item, payload: { ...event, msg: {
      ...msg, payload: { ...msg.payload, initialMessages: [] },
    } } };
    return Buffer.byteLength(JSON.stringify(withoutCache), "utf8") <= ordinary;
  } catch {
    return false;
  }
}
