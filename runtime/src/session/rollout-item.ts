/**
 * RolloutItem — the per-line wrapper written to the JSONL rollout
 * file. Port of codex `protocol/src/protocol.rs` (line 2855) + the
 * 6-variant set listed in `docs/plan/codex-inventory.md §4`.
 *
 * Serialization: JSONL with `{ "type": "snake_case", "payload": ... }`
 * discriminant (matching codex's serde `tag="type" content="payload"`
 * shape). One RolloutItem per line.
 *
 * On-disk legacy aliases accepted for backward compatibility:
 *   - `task_started`  → `turn_started`
 *   - `task_complete` → `turn_complete`
 *
 * @module
 */

import type { Event, EventMsg, SessionMetaLine } from "./event-log.js";
import type { SessionAgentTask } from "./agent-task-lifecycle.js";

// ─────────────────────────────────────────────────────────────────────
// Per-variant payloads
// ─────────────────────────────────────────────────────────────────────

/** Codex `SessionStateUpdate` — session-scoped mutable slots. */
export interface SessionStateUpdate {
  readonly agentTask?: SessionAgentTask;
}

/** Port of codex `ResponseItem` subset used in rollout. Every history
 *  message the model sent/received lives here. */
export interface ResponseItem {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string; readonly [k: string]: unknown }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly id?: string;
  readonly endTurn?: boolean;
  readonly phase?: string;
}

/** Codex `CompactedItem` — when the conversation was compacted, this
 *  captures the summary + (optional) the replacement history that
 *  rebuilds the conversation up to the compaction boundary. The
 *  reconstruction algorithm uses `replacementHistory` as a snapshot
 *  shortcut. */
export interface CompactedItem {
  readonly message: string;
  readonly replacementHistory?: ReadonlyArray<ResponseItem>;
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}

/** Re-exported for callers that import the event-log envelope. */
export type { Event, EventMsg, SessionMetaLine };

// Re-export TurnContextItem from event-log.ts so a caller importing
// only this module has the full RolloutItem surface.
export type { TurnContextItem } from "./event-log.js";

// ─────────────────────────────────────────────────────────────────────
// RolloutItem — 6 variants
// ─────────────────────────────────────────────────────────────────────

import type { TurnContextItem } from "./event-log.js";

export type RolloutItem =
  | { readonly type: "session_meta"; readonly payload: SessionMetaLine }
  | { readonly type: "session_state"; readonly payload: SessionStateUpdate }
  | { readonly type: "response_item"; readonly payload: ResponseItem }
  | { readonly type: "compacted"; readonly payload: CompactedItem }
  | { readonly type: "turn_context"; readonly payload: TurnContextItem }
  | { readonly type: "event_msg"; readonly payload: Event };

export const KNOWN_ROLLOUT_TYPES = Object.freeze(
  new Set<string>([
    "session_meta",
    "session_state",
    "response_item",
    "compacted",
    "turn_context",
    "event_msg",
  ]),
);

/**
 * Legacy-alias remapping read on deserialization so older rollouts
 * from earlier AgenC versions still parse. Codex retained `task_*`
 * aliases for the same reason.
 */
export const ROLLOUT_LEGACY_TYPE_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    task_started: "turn_started",
    task_complete: "turn_complete",
  });

// ─────────────────────────────────────────────────────────────────────
// Serialization — JSONL per line
// ─────────────────────────────────────────────────────────────────────

/**
 * Serialize a RolloutItem to a single JSONL line (trailing `\n`).
 */
export function serializeRolloutItem(item: RolloutItem): string {
  return `${JSON.stringify(item)}\n`;
}

/**
 * Parse a single JSONL line into a RolloutItem. Returns `null` on
 * blank lines. Throws on malformed JSON; callers handle with
 * I-24 truncation-on-corrupt-tail logic.
 *
 * Applies legacy aliases on the embedded event_msg variant
 * (task_started → turn_started, etc).
 */
export function parseRolloutLine(line: string): RolloutItem | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parsed = JSON.parse(trimmed) as RolloutItem;
  if (parsed.type === "event_msg" && parsed.payload?.msg) {
    const inner = parsed.payload.msg as { type?: string };
    if (inner?.type && ROLLOUT_LEGACY_TYPE_ALIASES[inner.type]) {
      const newInner = { ...inner, type: ROLLOUT_LEGACY_TYPE_ALIASES[inner.type] };
      return {
        type: "event_msg",
        payload: {
          ...parsed.payload,
          msg: newInner as unknown as EventMsg,
        },
      };
    }
  }
  return parsed;
}

/**
 * Whether a type string is recognised by the current reducer. Used
 * by the reducer's I-26 forward-compat shim.
 */
export function isKnownRolloutType(type: string): boolean {
  return KNOWN_ROLLOUT_TYPES.has(type);
}
