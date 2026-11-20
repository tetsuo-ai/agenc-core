/**
 * Whether a canonical session rollout records any input.
 *
 * The TUI provisions its daemon session before the first prompt. When that
 * session is never used, its rollout holds only the session header and
 * bookkeeping events. The daemon archives such a thread when the TUI retires
 * it, and `--continue` skips one the TUI could not retire (a crash, SIGKILL),
 * so an untouched session is never the one a user gets back.
 *
 * @module
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

import { isRecord } from "../utils/record.js";
import { isPromptEnvironment } from "./prompt-environment.js";

/** An untouched rollout is a few KB; anything larger is never treated as one. */
const MAX_UNTOUCHED_ROLLOUT_BYTES = 1024 * 1024;

/** Canonical events that mean someone used the session. */
const SESSION_INPUT_EVENT_TYPES = new Set([
  "message_submission",
  "user_message",
  "turn_started",
]);

/** A session state line that holds only the conversation's recorded date and branch. */
function isPromptEnvironmentOnly(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const keys = Object.keys(payload);
  return keys.length === 1 && keys[0] === "promptEnvironment" && isPromptEnvironment(payload.promptEnvironment);
}

/**
 * Whether a canonical rollout records no input: only the session header, the
 * date and branch recorded at creation, and events, none of them a
 * submission, a user message or a turn. A larger file, an unreadable one, an
 * unparsable line or any other record kind counts as input, so only a
 * provably untouched thread qualifies.
 */
export function canonicalRolloutHoldsNoInput(rolloutPath: string): boolean {
  let raw: string;
  try {
    const fd = openSync(rolloutPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const size = fstatSync(fd).size;
      if (size > MAX_UNTOUCHED_ROLLOUT_BYTES) return false;
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = readSync(fd, bytes, offset, size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      raw = bytes.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(record)) return false;
    if (record.type === "session_meta") continue;
    // The date and branch a conversation records when it is created
    // (prompt-environment.ts) come before any input.
    if (record.type === "session_state" && isPromptEnvironmentOnly(record.payload)) continue;
    if (record.type !== "event_msg" || !isRecord(record.payload)) return false;
    const msg = record.payload.msg;
    if (!isRecord(msg) || typeof msg.type !== "string") return false;
    if (SESSION_INPUT_EVENT_TYPES.has(msg.type)) return false;
  }
  return true;
}
