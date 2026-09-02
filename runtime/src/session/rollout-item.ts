/**
 * RolloutItem — the per-line wrapper written to the JSONL rollout
 * file. Port of agenc runtime `protocol/src/protocol.rs` (line 2855) + the
 * 6-variant set listed in `docs/plan/agenc runtime-inventory.md §4`.
 *
 * Serialization: JSONL with `{ "type": "snake_case", "payload": ... }`
 * discriminant (matching agenc runtime's serde `tag="type" content="payload"`
 * shape). One RolloutItem per line.
 *
 * On-disk compatibility aliases accepted for backward compatibility:
 *   - `task_started`  → `turn_started`
 *   - `task_complete` → `turn_complete`
 *
 * @module
 */

import type { Event, EventMsg, SessionMetaLine } from "./event-log.js";
import type { SessionAgentTask } from "./agent-task-lifecycle.js";
import type { ToolResultIntegrity } from "./tool-result-integrity.js";
import type { AgentInvocationChannelMetadata } from "../contracts/agent-invocation-envelope.js";
import type { CompactionHistoryMarkerV1 } from "./compaction-history-marker.js";
import { redactSecretsInValue } from "../secrets/index.js";
import type {
  CompactionCleanupPendingV1,
  CompactionCommittedV1,
  CompactionFailedV1,
  CompactionIntentV1,
  CompactionPayloadChunkV1,
  CompactionRollbackCommittedV1,
  CompactionRetentionExtendedV1,
  CompactionSourceReleaseV1,
} from "../services/compact/transaction-types.js";
import {
  isCompactionRolloutType,
  readCompactionRolloutPayload,
} from "./compaction-event-reader.js";

// ─────────────────────────────────────────────────────────────────────
// Per-variant payloads
// ─────────────────────────────────────────────────────────────────────

/** agenc runtime `SessionStateUpdate` — session-scoped mutable slots. */
export interface SessionStateUpdate {
  readonly agentTask?: SessionAgentTask;
}

/** Port of agenc runtime `ResponseItem` subset used in rollout. Every history
 *  message the model sent/received lives here. */
export interface ResponseItem {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content:
    | string
    | ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
        readonly [k: string]: unknown;
      }>;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  /** Checkpoint-v2 identity for the exact durable tool-result body. */
  readonly toolResultIntegrity?: ToolResultIntegrity;
  /** Durable authority/channel identity for a versioned agent invocation. */
  readonly agentInvocation?: AgentInvocationChannelMetadata;
  /** Authenticated by the enclosing compaction commit digest. */
  readonly compactionHistory?: CompactionHistoryMarkerV1;
  readonly id?: string;
  readonly endTurn?: boolean;
  readonly phase?: string;
}

/** Checkpoint-v2 reader view retained for narrow reader signatures. */
export interface ToolResultIntegrityResponseItem extends ResponseItem {
  readonly toolResultIntegrity?: ToolResultIntegrity;
}

/** agenc runtime `CompactedItem` — when the conversation was compacted, this
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

/**
 * Current RolloutItem schema version. Bumped on breaking shape
 * changes so `eventVersion` on each row lets older readers wrap
 * unknown variants in the I-26 `{type:'unknown'}` shim instead of
 * crashing.
 */
export const ROLLOUT_ITEM_VERSION = 2;
export const LEGACY_ROLLOUT_ITEM_VERSION = 1;

export type RolloutItem =
  | {
      readonly type: "session_meta";
      readonly payload: SessionMetaLine;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "session_state";
      readonly payload: SessionStateUpdate;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "response_item";
      readonly payload: ResponseItem;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compacted";
      readonly payload: CompactedItem;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "turn_context";
      readonly payload: TurnContextItem;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "event_msg";
      readonly payload: Event;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_intent";
      readonly payload: CompactionIntentV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_payload_chunk";
      readonly payload: CompactionPayloadChunkV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_failed";
      readonly payload: CompactionFailedV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_committed";
      readonly payload: CompactionCommittedV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_cleanup_pending";
      readonly payload: CompactionCleanupPendingV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_rollback_committed";
      readonly payload: CompactionRollbackCommittedV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_retention_extended";
      readonly payload: CompactionRetentionExtendedV1;
      readonly eventVersion?: number;
    }
  | {
      readonly type: "compaction_source_release";
      readonly payload: CompactionSourceReleaseV1;
      readonly eventVersion?: number;
    }
  | {
      /** I-26 shim — unknown variant encountered during replay. */
      readonly type: "unknown";
      readonly payload: { readonly raw: string; readonly originalType: string };
      readonly eventVersion?: number;
    };

const KNOWN_ROLLOUT_TYPES = Object.freeze(
  new Set<string>([
    "session_meta",
    "session_state",
    "response_item",
    "compacted",
    "turn_context",
    "event_msg",
    "compaction_intent",
    "compaction_payload_chunk",
    "compaction_failed",
    "compaction_committed",
    "compaction_cleanup_pending",
    "compaction_rollback_committed",
    "compaction_retention_extended",
    "compaction_source_release",
    "unknown",
  ]),
);

/**
 * Compatibility-alias remapping read on deserialization so older rollouts
 * from earlier AgenC versions still parse. agenc runtime retained `task_*`
 * aliases for the same reason.
 */
const ROLLOUT_LEGACY_TYPE_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    task_started: "turn_started",
    task_complete: "turn_complete",
  });

// ─────────────────────────────────────────────────────────────────────
// Serialization — JSONL per line
// ─────────────────────────────────────────────────────────────────────

/**
 * Serialize a RolloutItem to a single JSONL line (trailing `\n`).
 * Stamps `eventVersion` when absent (I-26).
 */
export function serializeRolloutItem(item: RolloutItem): string {
  rejectInlineCompactionWriter(item);
  const defaultEventVersion = isCompactionRolloutType(item.type)
    ? ROLLOUT_ITEM_VERSION
    : LEGACY_ROLLOUT_ITEM_VERSION;
  const stamped =
    item.eventVersion === undefined
      ? { ...item, eventVersion: defaultEventVersion }
      : item;
  return `${JSON.stringify(redactSecretsInValue(stamped))}\n`;
}

function rejectInlineCompactionWriter(item: RolloutItem): void {
  const payload = item.payload as unknown;
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Readonly<Record<string, unknown>>;
  if (item.type === "compaction_intent") {
    const source = record.source;
    if (typeof source === "object" && source !== null &&
        Object.hasOwn(source, "active_history_refs")) {
      throw new Error(
        "inline compaction_intent writers are disabled; persist payload manifests",
      );
    }
  }
  if (item.type === "compaction_committed" &&
      Object.hasOwn(record, "replacement_history")) {
    throw new Error(
      "inline compaction_committed writers are disabled; persist payload manifests",
    );
  }
  if (item.type === "compaction_rollback_committed" &&
      Object.hasOwn(record, "source_history")) {
    throw new Error(
      "inline compaction_rollback_committed writers are disabled; persist payload manifests",
    );
  }
}

/**
 * Parse a single JSONL line into a RolloutItem. Returns `null` on
 * blank lines. Throws on malformed JSON; callers handle with
 * I-24 truncation-on-corrupt-tail logic.
 *
 * Applies compatibility aliases on the embedded event_msg variant
 * (task_started → turn_started, etc).
 *
 * I-26: unknown top-level types are wrapped in the `unknown` shim
 * with the original raw JSON preserved so a newer-AgenC rollout can
 * still load under an older runtime without panic. The reducer
 * ignores `unknown` items + emits a warning per skip.
 */
export function parseRolloutLine(line: string): RolloutItem | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parsed = JSON.parse(trimmed) as RolloutItem;
  const typeTag = (parsed as { type?: string }).type;
  if (typeTag && !isKnownRolloutType(typeTag)) {
    return {
      type: "unknown",
      payload: { raw: trimmed, originalType: typeTag },
      eventVersion:
        (parsed as { eventVersion?: number }).eventVersion ?? undefined,
    };
  }
  if (parsed.type === "event_msg" && parsed.payload?.msg) {
    const inner = parsed.payload.msg as { type?: string };
    if (inner?.type && ROLLOUT_LEGACY_TYPE_ALIASES[inner.type]) {
      const newInner = {
        ...inner,
        type: ROLLOUT_LEGACY_TYPE_ALIASES[inner.type],
      };
      return {
        type: "event_msg",
        payload: {
          ...parsed.payload,
          msg: newInner as unknown as EventMsg,
        },
        eventVersion: parsed.eventVersion,
      };
    }
  }
  if (typeof typeTag === "string" && isCompactionRolloutType(typeTag)) {
    return {
      type: typeTag,
      payload: readCompactionRolloutPayload(typeTag, parsed.payload),
      eventVersion: parsed.eventVersion,
    } as RolloutItem;
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

/**
 * Replacement history as the live session projects it. Compaction commits
 * written before the transaction stopped persisting the runtime uuid carry an
 * `id` on the compaction messages; LLMMessages never do, and the durable
 * checkpoint hash covers `response-id`, so the id must not reach any history
 * a checkpoint is verified against.
 */
export function withoutResponseIds(
  items: ReadonlyArray<ResponseItem>,
): ReadonlyArray<ResponseItem> {
  return items.map((item) => {
    if (item.id === undefined) return item;
    const { id: _id, ...rest } = item;
    return rest;
  });
}
