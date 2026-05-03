/**
 * Ports upstream Rust `rollout/src/policy.rs` retention and persistence
 * decisions into AgenC's rollout store. The event-type filter is intentionally
 * generic because AgenC rollout rows carry JSON payloads, not Rust enums.
 */

import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonValue } from "../app-server/protocol/index.js";
import {
  AGENC_ROLLOUT_SESSIONS_DIR,
  AGENC_ROLLOUT_TRACE_DIR,
} from "./metadata.js";
import type { AgenCRolloutSessionMetadata } from "./types.js";

export type AgenCRolloutPersistenceMode = "limited" | "extended";

export interface AgenCRolloutRetentionPolicy {
  readonly maxSessions?: number;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
}

export interface AgenCRolloutRetentionPlan {
  readonly keep: readonly AgenCRolloutSessionMetadata[];
  readonly remove: readonly AgenCRolloutSessionMetadata[];
}

const LIMITED_EVENT_TYPES = new Set([
  "compacted",
  "turn_context",
  "session_meta",
  "user_message",
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "patch_apply_end",
  "token_count",
  "thread_name_updated",
  "context_compacted",
  "entered_review_mode",
  "exited_review_mode",
  "thread_rolled_back",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "image_generation_end",
]);

const LIMITED_RESPONSE_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "local_shell_call",
  "function_call",
  "tool_search_call",
  "function_call_output",
  "tool_search_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
  "image_generation_call",
  "compaction",
]);

const EXTENDED_EVENT_TYPES = new Set([
  "error",
  "guardian_assessment",
  "web_search_end",
  "exec_command_end",
  "mcp_tool_call_end",
  "view_image_tool_call",
  "collab_agent_spawn_end",
  "collab_agent_interaction_end",
  "collab_waiting_end",
  "collab_close_end",
  "collab_resume_end",
  "dynamic_tool_call_request",
  "dynamic_tool_call_response",
]);

export function shouldPersistRolloutItem(
  item: JsonValue,
  mode: AgenCRolloutPersistenceMode = "limited",
): boolean {
  const object = asJsonRecord(item);
  if (object === undefined) return false;

  const rolloutType = readString(object.type);
  if (rolloutType === "response_item") {
    return shouldPersistResponseItem(object.item ?? object.payload);
  }
  if (rolloutType === "event_msg") {
    return shouldPersistEventObject(object.event ?? object.payload, mode);
  }
  if (
    rolloutType === "compacted" ||
    rolloutType === "turn_context" ||
    rolloutType === "session_meta"
  ) {
    return true;
  }

  return shouldPersistEventObject(object, mode) ||
    shouldPersistResponseItem(object);
}

export function planRolloutRetention(
  sessions: readonly AgenCRolloutSessionMetadata[],
  policy: AgenCRolloutRetentionPolicy,
  options: { readonly nowMs?: number } = {},
): AgenCRolloutRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const ordered = [...sessions]
    .filter((session) => session.deleted !== true)
    .sort(compareNewestFirst);
  const keep = new Set<string>();
  const remove = new Map<string, AgenCRolloutSessionMetadata>();
  let keptBytes = 0;

  ordered.forEach((session, index) => {
    const ageMs = nowMs - Date.parse(session.updatedAt);
    const tooOld =
      policy.maxAgeMs !== undefined && Number.isFinite(ageMs) &&
      ageMs > policy.maxAgeMs;
    const overCount =
      policy.maxSessions !== undefined && index >= policy.maxSessions;
    const overBytes =
      policy.maxBytes !== undefined && keep.size > 0 &&
      keptBytes + session.byteLength > policy.maxBytes;
    if (tooOld || overCount || overBytes) {
      remove.set(session.sessionId, session);
      return;
    }
    keep.add(session.sessionId);
    keptBytes += session.byteLength;
  });

  return {
    keep: ordered.filter((session) => keep.has(session.sessionId)),
    remove: [...remove.values()],
  };
}

export function deleteRolloutFiles(
  rootDir: string,
  sessions: readonly AgenCRolloutSessionMetadata[],
): void {
  for (const session of sessions) {
    deleteIfUnder(rootDir, AGENC_ROLLOUT_SESSIONS_DIR, session.rolloutPath, false);
    if (session.traceBundlePath !== undefined) {
      deleteIfUnder(rootDir, AGENC_ROLLOUT_TRACE_DIR, session.traceBundlePath, true);
    }
  }
}

function compareNewestFirst(
  left: AgenCRolloutSessionMetadata,
  right: AgenCRolloutSessionMetadata,
): number {
  const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return right.sessionId.localeCompare(left.sessionId);
}

function shouldPersistResponseItem(item: JsonValue | undefined): boolean {
  const object = asJsonRecord(item);
  if (object === undefined) return false;
  const type = readString(object.type) ?? readString(object.response_item_type);
  if (type === undefined) {
    const role = readString(object.role);
    return role === "system" ||
      role === "user" ||
      role === "assistant" ||
      role === "tool";
  }
  return type !== undefined && LIMITED_RESPONSE_ITEM_TYPES.has(type);
}

function shouldPersistEventObject(
  event: JsonValue | undefined,
  mode: AgenCRolloutPersistenceMode,
): boolean {
  const envelope = asJsonRecord(event);
  const object = asJsonRecord(envelope?.msg) ?? envelope;
  if (object === undefined) return false;
  const type = readString(object.type) ?? readString(object.event_type);
  if (type === undefined) return false;
  if (type === "item_completed") {
    const item = asJsonRecord(object.item);
    return readString(item?.type) === "plan" || readString(item?.kind) === "plan";
  }
  if (LIMITED_EVENT_TYPES.has(type)) return true;
  return mode === "extended" && EXTENDED_EVENT_TYPES.has(type);
}

function asJsonRecord(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deleteIfUnder(
  rootDir: string,
  expectedDir: string,
  targetPath: string,
  recursive: boolean,
): void {
  const base = resolve(rootDir, expectedDir);
  const target = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(rootDir, targetPath);
  if (!isPathInside(base, target)) return;
  rmSync(target, { force: true, recursive });
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
