import { randomUUID } from "node:crypto";
import { useEffect, useMemo, useReducer } from "react";

import type { LLMMessage, StreamingToolUse } from "../llm/types.js";
import {
  DEFAULT_MODEL_COSTS,
  computeUsdCostWithResolution,
  formatTokenCount,
  formatUsdCost,
  type ModelUsage,
} from "../session/cost.js";
import type { Event } from "../session/event-log.js";
import type {
  HistoryReplacedEvent,
  RuntimeTranscriptMessage,
} from "../session/transcript-replacement.js";
import type { AgenCBridgeSession } from "./session-types.js";
import { nonEmptyString } from "../utils/stringUtils.js";
import { formatRealtimeItemSummary } from "./realtime/state.js";
import {
  isPermissionDeniedToolResult,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGE,
} from "./tool-result-denial.js";
import { escapeXml } from "../utils/xml.js";

/**
 * Hardcoded copy of `FILE_EDIT_TOOL_NAME` from
 * `runtime/src/tools/system/file-edit.ts`. Kept in sync by hand
 * because importing the live constant pulls `tools/system/file-edit.ts`
 * → `tools/result-metadata.ts` → the `diff` npm package into this
 * module's resolution chain, which breaks focused transcript tests
 * that should not depend on the diff library. If the live constant
 * ever changes, update this value in lockstep.
 */
const FILE_EDIT_TOOL_NAME = "Edit";

export type SessionTranscriptEvent =
  | Event
  | { readonly type: string; readonly payload?: unknown; readonly [key: string]: unknown };

export interface AdaptedTranscript {
  readonly messages: readonly any[];
  readonly streamingText: string | null;
  readonly inProgressToolUseIDs: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly currentTurnId: string | null;
  /**
   * Mid-stream tool input accumulator that mirrors the `streamingToolUses`
   * state from the live TUI transcript surface. Each entry tracks an
   * `input_json_delta`-driven tool-use block whose JSON arguments are still
   * arriving. Consumed by `<Messages>` (`components/Messages.tsx:222`) to
   * render synthetic streaming-tool-use cells while the model emits partial
   * arguments. Populated by row R5 of the streaming-tool-use parity contract.
   * Empty until R5 lands.
   */
  readonly streamingToolUses: readonly StreamingToolUse[];
  /**
   * Mid-stream extended-thinking accumulator. Mirrors `StreamingThinking`
   * from `runtime/src/utils/messages.ts:2923`. Populated by the
   * `assistant_thinking_*` event family emitted by `phases/stream-model.ts`.
   * Consumed by `<Messages>` (`components/Messages.tsx:122`) which renders
   * `<AssistantThinkingMessage>` while `isStreaming` or up to 30 s after
   * `streamingEndedAt` per the streaming visibility rule. `null` when no
   * thinking block is open and no recent block is within the visibility
   * window.
   */
  readonly streamingThinking:
    | {
        readonly thinking: string;
        readonly isStreaming: boolean;
        readonly streamingEndedAt?: number;
        readonly redacted: boolean;
        readonly kind: "thinking" | "reasoning_summary";
      }
    | null;
  /**
   * Cumulative streamed characters for the CURRENT turn: visible text +
   * thinking/reasoning deltas + tool-argument JSON deltas. Unlike the live
   * buffers above, this never resets mid-turn (buffers reset per
   * message/thinking block, which made the spinner's chars/4 token estimate
   * collapse repeatedly and read out absurd tok/s averages). Resets on
   * `turn_start`.
   */
  readonly turnStreamedChars: number;
  /**
   * Most recent provider-reported usage from a `token_count` event, in the
   * assistant-message usage-block shape the context-percentage derivation
   * consumes. Daemon-bridge transcripts synthesize assistant messages with
   * zero usage (and a synthetic model that getTokenUsage skips), so without
   * this the workbench ctx% reads 0 forever. `null` until the first
   * token_count of the session.
   */
  readonly latestUsage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  } | null;
}

const SYNTHETIC_MODEL = "agenc";
const GLOB_NO_FILES_TEXT = "No files found";
const GLOB_TRUNCATION_PREFIX = "(Results are truncated.";
const fallbackEventKeys = new WeakMap<SessionTranscriptEvent, string>();
let fallbackEventKeyCounter = 0;

/**
 * Memory bounds for the TUI transcript store.
 *
 * The transcript store retains the full session in memory. Without bounds a
 * long session with large tool outputs (file reads, big greps, command logs)
 * grows the heap without limit — every event holds its full result content and
 * `adaptTranscriptEvents` re-derives a second full copy of that content into
 * the rendered message list. On multi-hour sessions this reaches gigabytes and
 * OOMs the daemon.
 *
 * These bounds keep retention bounded while staying visually safe: the Ink
 * renderer is already virtualized to ~300 rows, so evicting the OLDEST events
 * is invisible on screen, and the complete, untruncated output still lives in
 * the native terminal scrollback and the on-disk session transcript.
 *
 *   - `MAX_TOOL_RESULT_BYTES` caps the bytes persisted for a single
 *     tool-result's content (the megabyte-per-tool-call driver).
 *   - `MAX_TRANSCRIPT_EVENTS` caps how many events the store retains; older
 *     events past this ring-buffer window are dropped together with their
 *     dedup keys.
 */
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_EVENTS = 4000;

/**
 * Clamp a tool-result content string to `MAX_TOOL_RESULT_BYTES`, replacing the
 * dropped middle/tail with a `[N bytes truncated]` marker. Keeps the head of
 * the content (the part the user most often needs) and records exactly how many
 * bytes were removed. Strings already within the cap are returned unchanged
 * (referentially identical) so callers can cheaply detect "no truncation".
 */
function clampResultText(text: string): string {
  // Measure in UTF-8 bytes so the cap reflects real memory/heap cost rather
  // than JS UTF-16 code-unit count.
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= MAX_TOOL_RESULT_BYTES) return text;
  // Envelope-wrapped tool results (`<bash-stdout>…</bash-stdout>`,
  // `<edit-diff>…</edit-diff>`, `<read-content>…`, `<grep-matches>…`) are a
  // SINGLE block whose body is the payload. A blind head-clamp would keep the
  // first bytes and drop the closing tag, after which the renderers'
  // `extractToolTag` returns null and the whole output collapses to an empty
  // state ("(No output)" / "(empty file)" / "(No changes)" / "No matches").
  // Clamp the INNER body instead and re-wrap, so the closing tag always
  // survives and the kept head stays visible.
  const enveloped = clampEnvelopeBody(text);
  if (enveloped !== null) return enveloped;
  // Keep the head at the BYTE cap. A char-count slice is wrong here: a JS
  // string character can encode to up to 4 UTF-8 bytes, so slicing by
  // MAX_TOOL_RESULT_BYTES *characters* would retain up to ~4x the byte cap for
  // multi-byte (CJK/emoji) content — defeating the memory bound. Slice the
  // UTF-8 byte buffer instead, backing off any trailing partial multi-byte
  // sequence so the kept head is always valid UTF-8 at or under the cap.
  const head = sliceUtf8Bytes(text, MAX_TOOL_RESULT_BYTES);
  const truncated = byteLength - Buffer.byteLength(head, "utf8");
  return `${head}\n[${truncated} bytes truncated]`;
}

/**
 * Tags produced by `formatStructuredToolResult` whose body is extracted by the
 * tool renderers via `extractToolTag(content, tag)` (which needs BOTH the open
 * and close tag present). For these, an over-cap block must keep its closing
 * tag, so we clamp the body and re-wrap rather than head-clamping the whole
 * block.
 */
const EXTRACTED_ENVELOPE_TAGS = [
  "bash-stdout",
  "bash-stderr",
  "edit-diff",
  "read-content",
  "grep-matches",
] as const;

/**
 * If `text` is exactly one `<tag>BODY</tag>` envelope (for a tag whose body is
 * later extracted by the renderers), clamp BODY so the whole re-wrapped block
 * fits within `MAX_TOOL_RESULT_BYTES`, keeping the closing tag intact. Returns
 * the re-wrapped string, or `null` when `text` is not such an envelope (so the
 * caller can fall back to the generic head-clamp).
 */
function clampEnvelopeBody(text: string): string | null {
  for (const tag of EXTRACTED_ENVELOPE_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (!text.startsWith(open) || !text.endsWith(close)) continue;
    // Reject anything that isn't a single self-contained envelope (e.g. a
    // closing tag appearing mid-body) so we never mis-detect concatenated text.
    const body = text.slice(open.length, text.length - close.length);
    if (body.includes(close)) continue;
    // Budget for the body = cap minus the open/close tags and the truncation
    // marker we append inside the envelope. Keep the marker matching the
    // generic path's wording so byte accounting stays consistent.
    const marker = (n: number) => `\n[${n} bytes truncated]`;
    const overhead =
      Buffer.byteLength(open, "utf8") + Buffer.byteLength(close, "utf8");
    const bodyBytes = Buffer.byteLength(body, "utf8");
    // Reserve room for the largest possible marker (its byte count grows with
    // the digit count of the dropped total, which is bounded by bodyBytes).
    const markerReserve = Buffer.byteLength(marker(bodyBytes), "utf8");
    const bodyBudget = MAX_TOOL_RESULT_BYTES - overhead - markerReserve;
    if (bodyBudget <= 0) {
      // Degenerate: tags + marker alone exceed the cap. Drop the whole body but
      // still keep a well-formed, extractable envelope.
      return `${open}${marker(bodyBytes)}${close}`;
    }
    const head = sliceUtf8Bytes(body, bodyBudget);
    const truncated = bodyBytes - Buffer.byteLength(head, "utf8");
    return `${open}${head}${marker(truncated)}${close}`;
  }
  return null;
}

/**
 * Return the longest UTF-8-valid prefix of `text` whose encoded length does not
 * exceed `maxBytes`. Slices the UTF-8 buffer at `maxBytes`, then walks back off
 * any trailing partial multi-byte sequence so decoding never yields a U+FFFD
 * replacement char or an over-cap result.
 */
function sliceUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // A UTF-8 continuation byte matches 0b10xxxxxx (0x80–0xBF). If the byte at the
  // cut starts mid-sequence, back up to the start of that code point so we never
  // split a character.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.toString("utf8", 0, end);
}

/**
 * Structure-preserving clamp of any tool-result content value. Truncates long
 * string content (bare strings and the `.text` of structured text blocks) while
 * leaving the value's shape, types, and non-text fields untouched so that event
 * ordering and dedup keys (which key on `seq`/`id`, never on content) are
 * unaffected. Returns the input unchanged when nothing needed clamping.
 */
function clampResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    return clampResultText(content);
  }
  if (isStructuredContentBlocks(content)) {
    let mutated = false;
    const next = content.map((block) => {
      const clamped = clampResultText(block.text);
      if (clamped === block.text) return block;
      mutated = true;
      return { ...block, text: clamped };
    });
    return mutated ? next : content;
  }
  return content;
}

/**
 * Allow-list of `warning` event causes that are surfaced to the
 * user's chat transcript. Every other cause stays in the daemon log
 * and observability sinks only.
 *
 * Adding a new entry here must clear the bar: the user can act on
 * the warning OR it materially explains a turn-level outcome the
 * user just observed. Internal recovery (`recovery_loop`,
 * `retry_after_ambiguous`, ...), telemetry (`llm_request_metadata`,
 * `capability_drift_detected`, ...), and background liveness ticks
 * (`background_agent_status`) belong in the daemon log only.
 *
 * Categories:
 *   - User action required: auth / hook decisions the user can fix.
 *   - Turn-outcome explanation: surfaces WHY a turn ended early so
 *     the user understands what they're seeing in the transcript.
 *   - Input mutation notice: informs the user that something they
 *     submitted was modified or dropped before being sent.
 */
const USER_VISIBLE_WARNING_CAUSES: ReadonlySet<string> = new Set([
  // User action / configuration
  "mcp_auth_required",
  "model_token_limit_config",
  "user_prompt_submit_hook_blocked",
  "user_prompt_submit_hook_stopped",
  "user_prompt_submit_hook_threw",
  "pre_hook_denied",
  // Turn-outcome explanation
  "mid_turn_compact_failed",
  "pre_sampling_compact_failed",
  "auto_compact_failed",
  "max_output_tokens_exhausted",
  "prompt_too_long_exhausted",
  "stop_hook_loop",
  // Provider / mode change the user just observed
  "provider_switched",
  "provider_switch_rejected",
  "mode_changed",
  "resumed_with_different_model",
  // Input mutation
  "file_mention_attachment_dropped",
  "image_error",
  "invalid_args",
  "schema_validation_failed",
  "malformed_tool_call",
  "daemon_connection_state",
]);

/**
 * Collab v2 agent tools that produce their own structured transcript
 * rows via `collab_agent_spawn_*`, `collab_agent_interaction_*`,
 * `collab_waiting_*`, and `collab_close_*` events. The raw
 * `tool_call_started`/`tool_call_completed` rows for these names are
 * suppressed so the transcript shows a single structured collab-agent row
 * per call, matching `CollabAgentToolCall` ThreadItem routing where the
 * generic function-call ThreadItem variant is never produced for these tools.
 */
const COLLAB_V2_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "assign_task",
  "send_message",
  // followup_task (a deleted assign_task alias) stays here so historical
  // transcripts that recorded it still render a single structured row.
  "followup_task",
]);

function timestamp(): string {
  return new Date().toISOString();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "image"
        ) {
          return "[Image]";
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

function safeJson(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}

function isStructuredContentBlocks(
  value: unknown,
): value is readonly { readonly type: "text"; readonly text: string }[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function stringResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringResult).join("\n");
  if (value && typeof value === "object") {
    if ("content" in value && typeof value.content === "string") {
      return value.content;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? "" : String(value);
}

function orphanResultText(value: unknown): string {
  if (isStructuredContentBlocks(value)) {
    return value.map((block) => block.text).join("\n");
  }
  return stringResult(value);
}

function isLineNumberedFileReadResult(value: unknown): boolean {
  const text = orphanResultText(value).trimStart();
  return /^\d+→/.test(text);
}

function metadataRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata = payload.metadata;
  return metadata && typeof metadata === "object"
    ? metadata as Record<string, unknown>
    : {};
}

function plainGlobProjection(result: string): {
  readonly paths: readonly string[];
  readonly truncated: boolean;
} {
  if (result.trim() === GLOB_NO_FILES_TEXT) {
    return { paths: [], truncated: false };
  }
  const paths: string[] = [];
  let truncated = false;
  for (const line of result.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(GLOB_TRUNCATION_PREFIX)) {
      truncated = true;
      continue;
    }
    paths.push(line);
  }
  return { paths, truncated };
}

/**
 * Message makers mint a fresh `randomUUID()` by default, which is correct for
 * one-shot callers (permission previews, tests). The transcript projection
 * (`adaptTranscriptEvents`) instead passes a deterministic uuid derived from
 * the source event key + a per-event block index (`${eventKey}:${blockIndex}`)
 * so re-projecting the same events on every streaming delta re-mints identical
 * uuids for already-projected messages. Without that, every delta changed
 * every React key in the transcript, remounting all rows and invalidating the
 * virtual list's height cache (M-TUI-1). The optional `uuid` param keeps
 * external callers unchanged.
 */
export function makeUserMessage(content: unknown, uuid: string = randomUUID()): any {
  return {
    type: "user",
    message: {
      role: "user",
      content: textFromContent(content) || "(empty)",
    },
    uuid,
    timestamp: timestamp(),
  };
}

export function makeAssistantTextMessage(
  content: string,
  uuid: string = randomUUID(),
): any {
  return {
    type: "assistant",
    uuid,
    timestamp: timestamp(),
    message: {
      id: randomUUID(),
      container: null,
      model: SYNTHETIC_MODEL,
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: "text", text: content.length > 0 ? content : "(no content)" }],
      context_management: null,
    },
    requestId: undefined,
  };
}

export function makeAssistantThinkingMessage(
  thinking: string,
  redacted: boolean = false,
  uuid: string = randomUUID(),
): any {
  return {
    type: "assistant",
    uuid,
    timestamp: timestamp(),
    message: {
      id: randomUUID(),
      container: null,
      model: SYNTHETIC_MODEL,
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: redacted
        ? [{ type: "redacted_thinking", data: thinking }]
        : [{ type: "thinking", thinking }],
      context_management: null,
    },
    requestId: undefined,
  };
}

export function makeToolUseMessage(
  toolUseID: string,
  name: string,
  input: unknown,
  uuid: string = randomUUID(),
): any {
  return {
    ...makeAssistantTextMessage(""),
    uuid,
    message: {
      ...makeAssistantTextMessage("").message,
      content: [{ type: "tool_use", id: toolUseID, name, input }],
    },
  };
}

export function makeToolResultMessage(
  toolUseID: string,
  content: unknown,
  isError = false,
  uuid: string = randomUUID(),
): any {
  const resultContent = clampResultContent(
    isStructuredContentBlocks(content) ? content : stringResult(content),
  );
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseID,
          content: resultContent,
          is_error: isError,
        },
      ],
    },
    // Tool-result messages must NOT be isMeta: shouldShowUserMessage drops
    // isMeta user messages in live (non-transcript) mode, which would filter
    // out every tool result before it can render under its call row. The
    // in-process path (session/turn-compat.ts) builds the equivalent message
    // without isMeta, so results render there; match that here.
    uuid,
    timestamp: timestamp(),
    toolUseResult: typeof resultContent === "string"
      ? resultContent
      : resultContent.map((b) => b.text).join("\n"),
  };
}

export function makeSystemMessage(
  content: string,
  level: "info" | "warning" | "error" = "info",
  uuid: string = randomUUID(),
): any {
  return {
    type: "system",
    subtype: "informational",
    content,
    isMeta: false,
    timestamp: timestamp(),
    uuid,
    level,
  };
}

export type CollabAgentMessageState = "running" | "success" | "error" | "info";

export function makeCollabAgentMessage(
  title: string,
  details: readonly string[] = [],
  state: CollabAgentMessageState = "info",
  uuid: string = randomUUID(),
): any {
  return {
    ...makeSystemMessage(
      [title, ...details.map((detail) => `  ${detail}`)].join("\n"),
      state === "error" ? "error" : "info",
      uuid,
    ),
    subtype: "collab_agent",
    title,
    details,
    state,
  };
}

type ProtocolTranscriptKind = "claim" | "settle" | "slash" | "stake";

type ProtocolBadgeVariant = "worker" | "success" | "error";

interface ProtocolTranscriptMessageOptions {
  readonly kind: ProtocolTranscriptKind;
  readonly title: string;
  readonly content: string;
  readonly details: readonly string[];
  readonly badgeVariant: ProtocolBadgeVariant;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

function makeProtocolEventMessage(
  {
    kind,
    title,
    content,
    details,
    badgeVariant,
    facts,
  }: ProtocolTranscriptMessageOptions,
  uuid: string = randomUUID(),
): any {
  return {
    ...makeSystemMessage(content, badgeVariant === "error" ? "error" : "info", uuid),
    subtype: "protocol_event",
    protocolKind: kind,
    title,
    details,
    badgeVariant,
    facts,
    state:
      badgeVariant === "success"
        ? "success"
        : badgeVariant === "error"
          ? "error"
          : "info",
  };
}

function eventKey(event: SessionTranscriptEvent): string {
  if ("seq" in event && typeof event.seq === "number") return `seq:${event.seq}`;
  if ("id" in event && typeof event.id === "string") return `id:${event.id}`;
  try {
    return JSON.stringify(event);
  } catch {
    const existing = fallbackEventKeys.get(event);
    if (existing !== undefined) return existing;
    const fallback = `${event.type}:object:${fallbackEventKeyCounter}`;
    fallbackEventKeyCounter += 1;
    fallbackEventKeys.set(event, fallback);
    return fallback;
  }
}

function eventSeq(event: SessionTranscriptEvent): number | null {
  if (
    "seq" in event &&
    typeof event.seq === "number" &&
    Number.isFinite(event.seq)
  ) {
    return event.seq;
  }
  return null;
}

function maxEventSeq(
  current: number | null,
  event: SessionTranscriptEvent,
): number | null {
  const seq = eventSeq(event);
  if (seq === null) return current;
  return current === null ? seq : Math.max(current, seq);
}

function orderSequencedEvents(
  events: readonly SessionTranscriptEvent[],
): readonly SessionTranscriptEvent[] {
  if (events.length < 2) return events;

  const sequenced: Array<{
    readonly event: SessionTranscriptEvent;
    readonly index: number;
    readonly seq: number;
  }> = [];
  const positions: number[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const seq = eventSeq(event);
    if (seq === null) continue;
    positions.push(index);
    sequenced.push({ event, index, seq });
  }

  if (sequenced.length < 2) return events;

  const sorted = [...sequenced].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.index - right.index;
  });
  if (sorted.every((entry, index) => entry.index === sequenced[index]?.index)) {
    return events;
  }

  const ordered = [...events];
  for (let index = 0; index < positions.length; index += 1) {
    ordered[positions[index]!] = sorted[index]!.event;
  }
  return ordered;
}

function unwrap(event: SessionTranscriptEvent): {
  readonly type: string;
  readonly payload: unknown;
  readonly key: string;
} {
  if ("msg" in event && event.msg && typeof event.msg === "object") {
    const msg = event.msg as { readonly type?: unknown; readonly payload?: unknown };
    return {
      type: typeof msg.type === "string" ? msg.type : "unavailable",
      payload: msg.payload,
      key: eventKey(event),
    };
  }
  return {
    type: event.type,
    payload: "payload" in event ? event.payload : event,
    key: eventKey(event),
  };
}

function isHistoryClearedEvent(event: SessionTranscriptEvent): boolean {
  return unwrap(event).type === "history_cleared";
}

function isHistoryReplacedEvent(event: SessionTranscriptEvent): boolean {
  return unwrap(event).type === "history_replaced";
}

function isTranscriptResetEvent(event: SessionTranscriptEvent): boolean {
  return isHistoryClearedEvent(event) || isHistoryReplacedEvent(event);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function toolInput(payload: Record<string, unknown>): unknown {
  if ("args" in payload && typeof payload.args === "string") {
    return safeJson(payload.args);
  }
  if ("command" in payload && typeof payload.command === "string") {
    return { command: payload.command, cwd: payload.cwd };
  }
  return payload;
}

function pushToolUse(
  out: any[],
  openTools: Set<string>,
  toolNames: Set<string>,
  callId: string,
  toolName: string,
  input: unknown,
  nextUuid: () => string,
): void {
  openTools.add(callId);
  toolNames.add(toolName);
  out.push(makeToolUseMessage(callId, toolName, input, nextUuid()));
}

function pushToolResult(
  out: any[],
  openTools: Set<string>,
  settledToolCallIds: Set<string>,
  callId: string,
  result: unknown,
  nextUuid: () => string,
  isError = false,
  rawResult: unknown = result,
): void {
  if (!openTools.has(callId)) {
    settledToolCallIds.add(callId);
    if (isPermissionDeniedToolResult(rawResult) || isPermissionDeniedToolResult(result)) {
      out.push(makeSystemMessage(PERMISSION_DENIED_TOOL_RESULT_MESSAGE, "warning", nextUuid()));
      return;
    }
    if (!isError && isLineNumberedFileReadResult(rawResult)) {
      return;
    }
    if (isStructuredContentBlocks(rawResult)) {
      // Operator-readable: the raw internal correlation id (call_…) is
      // meaningless to a user, so it is omitted from the visible prose rather
      // than surfaced. The recovered result payload below is the meaningful
      // part; these structured-block branches carry no extra payload here.
      out.push(
        makeSystemMessage(
          isError
            ? "A tool failed and its result arrived before its start event; recovered."
            : "A tool result arrived before its start event and was recovered.",
          isError ? "error" : "warning",
          nextUuid(),
        ),
      );
      return;
    }
    // Keep the recovered RESULT payload visible (that's what the operator needs)
    // but drop the opaque call_… correlation id and the framework-internal
    // "without matching start" phrasing from the user-facing lead-in.
    out.push(
      makeSystemMessage(
        `A tool result arrived out of order and was recovered: ${stringResult(rawResult)}`,
        isError ? "error" : "warning",
        nextUuid(),
      ),
    );
    return;
  }
  openTools.delete(callId);
  settledToolCallIds.add(callId);
  out.push(makeToolResultMessage(callId, result, isError, nextUuid()));
}

function streamedToolInput(entry: StreamingToolUse): unknown {
  if (entry.unparsedToolInput.trim().length > 0) {
    return safeJson(entry.unparsedToolInput);
  }
  return entry.contentBlock.input ?? {};
}

function formatAgentStatus(status: unknown): string {
  if (!status || typeof status !== "object") return String(status ?? "unavailable");
  if ("status" in status && typeof status.status === "string") {
    if ("error" in status && typeof status.error === "string") {
      return `${status.status}: ${status.error}`;
    }
    return status.status;
  }
  return stringResult(status);
}

interface CollabAgentDisplay {
  threadId: string;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  agentRoleDisplayName?: string;
}

function formatLamports(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const sol = value / 1_000_000_000;
  const formatted = sol >= 10
    ? sol.toFixed(2)
    : sol >= 1
      ? sol.toFixed(3)
      : sol.toFixed(6);
  return `${formatted.replace(/\.?0+$/u, "")} ◎`;
}

function protocolFact(label: string, value: unknown): { readonly label: string; readonly value: string } | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.trim().length > 0 ? { label, value: text } : null;
}

function protocolPayloadFacts(
  payload: Record<string, unknown>,
): readonly { readonly label: string; readonly value: string }[] {
  if (!Array.isArray(payload.facts)) return [];
  return payload.facts.flatMap((fact) => {
    if (!fact || typeof fact !== "object") return [];
    const record = fact as Record<string, unknown>;
    const label = nonEmptyString(record.label);
    if (!label) return [];
    const value = record.value;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return [];
    }
    return [{ label, value: String(value) }];
  });
}

function formatProtocolEvent(
  type: string,
  payload: Record<string, unknown>,
): ProtocolTranscriptMessageOptions | null {
  const taskPda = nonEmptyString(payload.taskPda);
  const signature = nonEmptyString(payload.signature);
  const message = nonEmptyString(payload.message);
  const baseFacts = protocolPayloadFacts(payload);

  if (type === "protocol_claim") {
    const escrow = formatLamports(payload.escrowLamports);
    const stake = formatLamports(payload.stakeLamports);
    const facts = [
      protocolFact("task", taskPda),
      protocolFact("claimant", payload.claimant),
      protocolFact("escrow", escrow),
      protocolFact("stake", stake),
      protocolFact("deadline", payload.deadline),
      protocolFact("tx", signature),
      ...baseFacts,
    ].filter((fact): fact is { readonly label: string; readonly value: string } => fact !== null);
    const content = message ?? `Task ${taskPda ?? "unknown"} claimed${escrow ? ` · escrow ${escrow}` : ""}.`;
    return {
      kind: "claim",
      title: "protocol · claim",
      content,
      details: facts.map((fact) => `${fact.label}: ${fact.value}`),
      badgeVariant: "worker",
      facts,
    };
  }

  if (type === "protocol_settle") {
    const escrow = formatLamports(payload.escrowLamports);
    const bonus = formatLamports(payload.bonusLamports);
    const facts = [
      protocolFact("task", taskPda),
      protocolFact("recipient", payload.recipient),
      protocolFact("escrow", escrow),
      protocolFact("bonus", bonus),
      protocolFact("rep", payload.reputationDelta),
      protocolFact("tx", signature),
      ...baseFacts,
    ].filter((fact): fact is { readonly label: string; readonly value: string } => fact !== null);
    const content = message ?? `Task ${taskPda ?? "unknown"} settled${escrow ? ` · escrow ${escrow} released` : ""}.`;
    return {
      kind: "settle",
      title: "protocol · settle",
      content,
      details: facts.map((fact) => `${fact.label}: ${fact.value}`),
      badgeVariant: "success",
      facts,
    };
  }

  if (type === "protocol_slash") {
    const stakeDelta = formatLamports(payload.stakeDeltaLamports);
    const facts = [
      protocolFact("task", taskPda),
      protocolFact("agent", payload.slashedAgent),
      protocolFact("stake delta", stakeDelta),
      protocolFact("rep", payload.reputationDelta),
      protocolFact("tx", signature),
      ...baseFacts,
    ].filter((fact): fact is { readonly label: string; readonly value: string } => fact !== null);
    const reason = nonEmptyString(payload.reason) ?? "protocol slashing event";
    const content = message ?? reason;
    return {
      kind: "slash",
      title: "protocol · slash",
      content,
      details: [`reason: ${reason}`, ...facts.map((fact) => `${fact.label}: ${fact.value}`)],
      badgeVariant: "error",
      facts,
    };
  }

  if (type === "protocol_stake") {
    const stake = formatLamports(payload.stakeLamports);
    const stakeDelta = formatLamports(payload.stakeDeltaLamports);
    const facts = [
      protocolFact("wallet", payload.wallet),
      protocolFact("task", taskPda),
      protocolFact("stake", stake),
      protocolFact("stake delta", stakeDelta),
      protocolFact("rep", payload.reputationDelta),
      protocolFact("tx", signature),
      ...baseFacts,
    ].filter((fact): fact is { readonly label: string; readonly value: string } => fact !== null);
    const content = message ?? `Stake updated${stakeDelta ? ` · ${stakeDelta}` : ""}.`;
    return {
      kind: "stake",
      title: "protocol · stake",
      content,
      details: facts.map((fact) => `${fact.label}: ${fact.value}`),
      badgeVariant: "worker",
      facts,
    };
  }

  return null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function usageFromTokenCountPayload(payload: Record<string, unknown>): ModelUsage {
  const inputTokens = nonNegativeInteger(payload.promptTokens);
  const outputTokens = nonNegativeInteger(payload.completionTokens);
  const cachedInputTokens = nonNegativeInteger(payload.cachedInputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(payload.cacheCreationInputTokens);
  const reasoningOutputTokens = nonNegativeInteger(payload.reasoningOutputTokens);
  const webSearchRequests = nonNegativeInteger(payload.webSearchRequests);
  // Fallback mirrors coerceUsage's own totalTokens fallback (prompt +
  // completion). The old fallback also re-added cached/cache-creation/
  // reasoning tokens — for the OpenAI/xAI convention cached is a SUBSET of
  // promptTokens (and reasoning a subset of completion on the Responses
  // API), so a missing provider total nearly doubled the displayed ledger
  // total and its cost estimate.
  const totalTokens =
    nonNegativeInteger(payload.totalTokens) || inputTokens + outputTokens;

  return {
    model: nonEmptyString(payload.model) ?? "unknown",
    ...(nonEmptyString(payload.provider)
      ? { provider: nonEmptyString(payload.provider) }
      : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    webSearchRequests,
    totalTokens,
    turns: 1,
  };
}

function formatTokenCountUpdate(payload: Record<string, unknown>): string {
  const usage = usageFromTokenCountPayload(payload);
  const cost = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
  const modelLabel =
    usage.model === "unknown"
      ? null
      : usage.provider
        ? `${usage.provider}/${usage.model}`
        : usage.model;
  const details = [
    `${formatTokenCount(usage.inputTokens)} in`,
    `${formatTokenCount(usage.outputTokens)} out`,
    `${formatTokenCount(usage.totalTokens)} total`,
  ];
  if (usage.cachedInputTokens > 0) {
    details.push(`${formatTokenCount(usage.cachedInputTokens)} cache read`);
  }
  if (usage.cacheCreationInputTokens > 0) {
    details.push(`${formatTokenCount(usage.cacheCreationInputTokens)} cache write`);
  }
  if (usage.reasoningOutputTokens > 0) {
    details.push(`${formatTokenCount(usage.reasoningOutputTokens)} reasoning`);
  }
  if (usage.webSearchRequests > 0) {
    details.push(`${formatTokenCount(usage.webSearchRequests)} web search`);
  }
  details.push(
    cost.known
      ? formatUsdCost(cost.costUsd)
      : `${formatUsdCost(cost.costUsd)} est.`,
  );
  if (modelLabel !== null) {
    details.push(modelLabel);
  }

  return `Token ledger update: ${details.join(" · ")}`;
}

function compactWhitespace(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

function truncatePreview(value: string, max = 180): string {
  const compact = compactWhitespace(value);
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function shortThreadId(threadId: string): string {
  const compact = threadId.trim();
  if (compact.length <= 12) return compact || "agent";
  return `${compact.slice(0, 8)}…`;
}

function updateCollabAgent(
  agents: Map<string, CollabAgentDisplay>,
  threadId: unknown,
  metadata: Partial<CollabAgentDisplay> = {},
): void {
  const id = nonEmptyString(threadId);
  if (!id) return;
  const previous = agents.get(id);
  const next: CollabAgentDisplay = {
    threadId: id,
    ...(previous ?? {}),
  };
  for (const key of ["agentPath", "agentNickname", "agentRole", "agentRoleDisplayName"] as const) {
    const value = nonEmptyString(metadata[key]);
    if (value !== undefined) {
      next[key] = value;
    }
  }
  agents.set(id, next);
}

function updateCollabAgentFromPayload(
  agents: Map<string, CollabAgentDisplay>,
  payload: Record<string, unknown>,
  threadKey: string,
  keys: {
    readonly path?: string;
    readonly nickname?: string;
    readonly role?: string;
    readonly roleDisplayName?: string;
  },
): void {
  updateCollabAgent(agents, payload[threadKey], {
    agentPath: keys.path ? nonEmptyString(payload[keys.path]) : undefined,
    agentNickname: keys.nickname ? nonEmptyString(payload[keys.nickname]) : undefined,
    agentRole: keys.role ? nonEmptyString(payload[keys.role]) : undefined,
    agentRoleDisplayName: keys.roleDisplayName
      ? nonEmptyString(payload[keys.roleDisplayName])
      : undefined,
  });
}

function updateCollabAgentFromRef(
  agents: Map<string, CollabAgentDisplay>,
  value: unknown,
): void {
  if (!value || typeof value !== "object") return;
  const ref = value as Record<string, unknown>;
  updateCollabAgent(agents, ref.threadId, {
    agentPath: nonEmptyString(ref.agentPath),
    agentNickname: nonEmptyString(ref.agentNickname),
    agentRole: nonEmptyString(ref.agentRole),
    agentRoleDisplayName: nonEmptyString(ref.agentRoleDisplayName),
  });
}

function collabAgentLabel(
  agents: Map<string, CollabAgentDisplay>,
  threadId: unknown,
): string {
  const id = nonEmptyString(threadId);
  if (!id) return "agent";
  const metadata = agents.get(id);
  return (
    metadata?.agentNickname ??
    metadata?.agentRoleDisplayName ??
    metadata?.agentRole ??
    shortThreadId(id)
  );
}

function promptDetail(prompt: unknown): string | null {
  const value = nonEmptyString(prompt);
  return value ? truncatePreview(value) : null;
}

function spawnTaskDetail(payload: Record<string, unknown>): string | null {
  const path = nonEmptyString(payload.newAgentPath);
  if (path) return `agent ${path}`;
  const taskName = nonEmptyString(payload.taskName);
  return taskName ? `task ${taskName}` : null;
}

function agentInteractionHint(
  agents: Map<string, CollabAgentDisplay>,
  threadId: unknown,
  payload: Record<string, unknown>,
): string | null {
  const id = nonEmptyString(threadId);
  const path =
    (id ? agents.get(id)?.agentPath : undefined) ??
    nonEmptyString(payload.newAgentPath);
  if (!path) {
    return "manage: wait_agent, send_message, or close_agent";
  }
  return `manage: wait_agent, send_message, or close_agent ${path}`;
}

function spawnRequestDetail(payload: Record<string, unknown>): string | null {
  const model = nonEmptyString(payload.model);
  const effort = nonEmptyString(payload.reasoningEffort);
  const parts = [
    model ? `model ${model}` : null,
    effort ? `effort ${effort}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function collabSpawnStatusDetail(status: unknown): string | null {
  if (!status || typeof status !== "object") return null;
  const value = (status as { status?: unknown }).status;
  return value === "completed" ||
    value === "errored" ||
    value === "interrupted" ||
    value === "shutdown" ||
    value === "not_found"
    ? `status: ${collabStatusSummary(status)}`
    : null;
}

function collabStatusState(status: unknown): CollabAgentMessageState {
  if (!status || typeof status !== "object") return "info";
  switch ((status as { status?: unknown }).status) {
    case "completed":
      return "success";
    case "errored":
    case "not_found":
      return "error";
    case "running":
    case "pending_init":
    case "interrupted":
      return "running";
    default:
      return "info";
  }
}

function normalizeBackgroundStatus(status: unknown): string {
  if (typeof status !== "string" || status.trim().length === 0) return "idle";
  const value = status.trim().toLowerCase().replaceAll("_", "-");
  switch (value) {
    case "pending":
    case "pending-init":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "blocked":
    case "awaiting-user":
    case "awaiting-permission":
    case "waiting-on-user":
      return "waiting on user";
    case "completing":
      return "completing";
    case "failed":
    case "errored":
      return "failed";
    case "completed":
    case "complete":
      return "completed";
    case "cancelled":
    case "canceled":
    case "killed":
      return "cancelled";
    default:
      return value;
  }
}

function formatBackgroundAgentStatus(payload: Record<string, unknown>): string {
  const status = normalizeBackgroundStatus(payload.status);
  const message = nonEmptyString(payload.message);
  return message
    ? `Background agent ${status}: ${truncatePreview(message, 160)}`
    : `Background agent ${status}`;
}

function shouldRenderBackgroundAgentStatus(
  payload: Record<string, unknown>,
): boolean {
  return normalizeBackgroundStatus(payload.status) !== "idle";
}

function collabStatusSummary(status: unknown): string {
  if (!status || typeof status !== "object") return String(status ?? "unavailable");
  const value = status as Record<string, unknown>;
  switch (value.status) {
    case "pending_init":
      return "Pending init";
    case "running":
      return "Running";
    case "interrupted": {
      const reason = nonEmptyString(value.reason);
      return reason ? `Interrupted - ${truncatePreview(reason, 120)}` : "Interrupted";
    }
    case "completed": {
      const message = nonEmptyString(value.lastMessage);
      return message ? `Completed - ${truncatePreview(message, 160)}` : "Completed";
    }
    case "errored": {
      const error = nonEmptyString(value.error);
      return error ? `Error - ${truncatePreview(error, 160)}` : "Error";
    }
    case "shutdown":
      return "Shutdown";
    case "not_found":
      return "Not found";
    default:
      return formatAgentStatus(status);
  }
}

function parseSubagentNotification(message: string): {
  readonly title: string;
  readonly details: readonly string[];
  readonly state: CollabAgentMessageState;
} | null {
  const match = message.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1] ?? "{}") as Record<string, unknown>;
    const agentPath = nonEmptyString(data.agent_path) ?? "subagent";
    const status = data.status;
    if (typeof status === "string") {
      return {
        title: `Subagent ${shortThreadId(agentPath)} ${collabStatusSummary({ status })}`,
        details: [`status: ${collabStatusSummary({ status })}`],
        state: collabStatusState({ status }),
      };
    }
    if (status && typeof status === "object") {
      const value = status as Record<string, unknown>;
      if ("completed" in value) {
        const lastMessage = nonEmptyString(value.completed);
        return {
          title: `Subagent ${shortThreadId(agentPath)} completed`,
          details: lastMessage ? [truncatePreview(lastMessage, 160)] : [],
          state: "success",
        };
      }
      if ("errored" in value) {
        const error = nonEmptyString(value.errored) ?? "error";
        return {
          title: `Subagent ${shortThreadId(agentPath)} failed`,
          details: [truncatePreview(error, 160)],
          state: "error",
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function collabMailboxUpdateDetails(updates: unknown): readonly string[] {
  if (!Array.isArray(updates)) return [];
  return updates.flatMap((entry): readonly string[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const content = nonEmptyString(value.content);
    if (!content) return [];
    const parsed = parseSubagentNotification(content);
    if (parsed) {
      const detail = parsed.details.length > 0
        ? `: ${parsed.details.join(" · ")}`
        : "";
      return [`${parsed.title}${detail}`];
    }
    const role = nonEmptyString(value.role) ?? "message";
    return [`${role}: ${truncatePreview(content, 160)}`];
  });
}

function collectSettledCollabSpawnCallIds(
  events: readonly SessionTranscriptEvent[],
): ReadonlySet<string> {
  const callIds = new Set<string>();
  for (const raw of events) {
    const event = unwrap(raw);
    if (event.type !== "collab_agent_spawn_end") continue;
    const payload = payloadRecord(event.payload);
    const callId = payload.callId;
    if (typeof callId === "string") callIds.add(callId);
  }
  return callIds;
}

function formatElicitationSummary(type: string, payload: Record<string, unknown>): string {
  if (type === "request_user_input") {
    const questions = Array.isArray(payload.questions)
      ? payload.questions
          .map((question) =>
            question &&
            typeof question === "object" &&
            typeof (question as { question?: unknown }).question === "string"
              ? (question as { question: string }).question
              : null,
          )
          .filter((question): question is string => question !== null)
      : [];
    return questions.length > 0
      ? `Input requested: ${questions.join(" ")}`
      : "Input requested";
  }
  if (type === "mcp_elicitation_request") {
    const request = payload.request;
    if (request && typeof request === "object") {
      const message = (request as { message?: unknown }).message;
      return typeof message === "string"
        ? `MCP elicitation requested: ${message}`
        : "MCP elicitation requested";
    }
  }
  return "Elicitation requested";
}

function formatRealtimeClosed(payload: Record<string, unknown>): string {
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  return reason.length > 0 ? `Realtime closed: ${reason}` : "Realtime closed";
}

function isUserRealtimeRole(role: unknown): boolean {
  return typeof role === "string" && role.toLowerCase() === "user";
}

/**
 * Tool-result content formatter. Replaces the previous fallback of
 * always running everything through `stringResult` so that callers
 * who want structured rendering (Bash stdout/stderr, FileEdit diffs)
 * can preserve shape. Returns an array of provider-style content
 * blocks the renderer can dispatch on; falls back to a
 * single `{type:'text', text:stringResult(...)}` block for tools we
 * do not have a structured projection for.
 */
export function formatStructuredToolResult(
  toolName: string,
  eventType: string,
  payload: Record<string, unknown>,
): readonly { readonly type: "text"; readonly text: string }[] {
  if (eventType === "exec_command_end") {
    const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
    const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
    const exitCode =
      typeof payload.exitCode === "number" ? payload.exitCode : null;
    const durationMs =
      typeof payload.durationMs === "number" ? payload.durationMs : null;
    // Wrap in the `<bash-stdout>...</bash-stdout>` /
    // `<bash-stderr>...</bash-stderr>` envelope so the Bash renderer
    // can hand the joined text directly to `UserBashOutputMessage`, which
    // extracts these tags via
    // `extractTag(content, "bash-stdout")`. The exit_code / duration_ms
    // metadata block is appended outside the tags so it remains
    // human-readable in fallback paths.
    const blocks: { type: "text"; text: string }[] = [];
    blocks.push({ type: "text", text: `<bash-stdout>${escapeXml(stdout)}</bash-stdout>` });
    if (stderr.length > 0) {
      blocks.push({ type: "text", text: `<bash-stderr>${escapeXml(stderr)}</bash-stderr>` });
    }
    const meta: string[] = [];
    if (exitCode !== null) meta.push(`exit_code=${exitCode}`);
    if (durationMs !== null) meta.push(`duration_ms=${durationMs}`);
    if (meta.length > 0) blocks.push({ type: "text", text: `[${meta.join(" ")}]` });
    return blocks;
  }

  if (eventType === "mcp_tool_call_end") {
    const result = payload.result;
    const text = stringResult(result);
    return [{ type: "text", text }];
  }

  // tool_call_completed
  const result = payload.result;
  if (toolName === FILE_EDIT_TOOL_NAME) {
    if (
      result &&
      typeof result === "object" &&
      "diff" in (result as Record<string, unknown>) &&
      typeof (result as { readonly diff?: unknown }).diff === "string"
    ) {
      const diff = (result as { readonly diff: string }).diff;
      const path =
        typeof (result as { readonly path?: unknown }).path === "string"
          ? (result as { readonly path: string }).path
          : null;
      // Tagged envelope (same pattern as `<bash-stdout>...</bash-stdout>`)
      // so the tool renderer's `EditDiffView` can pull file path and diff
      // body out of the joined content via `extractToolTag`. Keeps
      // Bash and Edit on the same wire-shape pattern.
      const blocks: { type: "text"; text: string }[] = [];
      if (path !== null) {
        blocks.push({ type: "text", text: `<edit-file>${path}</edit-file>` });
      }
      blocks.push({ type: "text", text: `<edit-diff>${diff}</edit-diff>` });
      return blocks;
    }
  }

  if (toolName === "FileRead") {
    if (
      result &&
      typeof result === "object" &&
      "content" in (result as Record<string, unknown>) &&
      typeof (result as { readonly content?: unknown }).content === "string"
    ) {
      const r = result as {
        readonly content: string;
        readonly path?: unknown;
        readonly startLine?: unknown;
        readonly endLine?: unknown;
      };
      const blocks: { type: "text"; text: string }[] = [];
      if (typeof r.path === "string") {
        blocks.push({ type: "text", text: `<read-file>${r.path}</read-file>` });
      }
      if (typeof r.startLine === "number" && typeof r.endLine === "number") {
        blocks.push({
          type: "text",
          text: `<read-lines>${r.startLine}-${r.endLine}</read-lines>`,
        });
      }
      blocks.push({
        type: "text",
        text: `<read-content>${r.content}</read-content>`,
      });
      return blocks;
    }
  }

  if (toolName === "Write") {
    if (
      result &&
      typeof result === "object" &&
      ("path" in (result as Record<string, unknown>) ||
        "content" in (result as Record<string, unknown>))
    ) {
      const r = result as {
        readonly path?: unknown;
        readonly content?: unknown;
        readonly bytesWritten?: unknown;
      };
      const path = typeof r.path === "string" ? r.path : null;
      const bytes =
        typeof r.bytesWritten === "number"
          ? r.bytesWritten
          : typeof r.content === "string"
            ? r.content.length
            : null;
      const blocks: { type: "text"; text: string }[] = [];
      if (path !== null) {
        blocks.push({ type: "text", text: `<write-file>${path}</write-file>` });
      }
      const summary =
        bytes !== null
          ? `Wrote ${bytes} ${bytes === 1 ? "byte" : "bytes"}${path ? ` to ${path}` : ""}`
          : `Wrote file${path ? ` ${path}` : ""}`;
      blocks.push({
        type: "text",
        text: `<write-summary>${summary}</write-summary>`,
      });
      return blocks;
    }
  }

  if (toolName === "Grep") {
    if (
      result &&
      typeof result === "object" &&
      ("matches" in (result as Record<string, unknown>) ||
        "results" in (result as Record<string, unknown>))
    ) {
      const r = result as {
        readonly matches?: unknown;
        readonly results?: unknown;
        readonly pattern?: unknown;
      };
      const list = Array.isArray(r.matches)
        ? r.matches
        : Array.isArray(r.results)
          ? r.results
          : [];
      const lines: string[] = [];
      for (const match of list) {
        if (typeof match === "string") {
          lines.push(match);
        } else if (match && typeof match === "object") {
          const m = match as {
            readonly file?: unknown;
            readonly line?: unknown;
            readonly content?: unknown;
            readonly text?: unknown;
          };
          const file = typeof m.file === "string" ? m.file : "";
          const line =
            typeof m.line === "number"
              ? m.line
              : typeof m.line === "string"
                ? m.line
                : "";
          const text =
            typeof m.content === "string"
              ? m.content
              : typeof m.text === "string"
                ? m.text
                : "";
          lines.push(`${file}:${line}:${text}`);
        }
      }
      const blocks: { type: "text"; text: string }[] = [];
      if (typeof r.pattern === "string") {
        blocks.push({
          type: "text",
          text: `<grep-pattern>${r.pattern}</grep-pattern>`,
        });
      }
      blocks.push({
        type: "text",
        text: `<grep-matches>${lines.join("\n")}</grep-matches>`,
      });
      return blocks;
    }
  }

  if (toolName === "Glob") {
    if (
      result &&
      typeof result === "object" &&
      ("paths" in (result as Record<string, unknown>) ||
        "files" in (result as Record<string, unknown>) ||
        Array.isArray(result))
    ) {
      const r = result as {
        readonly paths?: unknown;
        readonly files?: unknown;
        readonly pattern?: unknown;
        readonly truncated?: unknown;
      };
      const list = Array.isArray(result)
        ? result
        : Array.isArray(r.paths)
          ? r.paths
          : Array.isArray(r.files)
            ? r.files
            : [];
      const paths = list.filter(
        (item): item is string => typeof item === "string",
      );
      const blocks: { type: "text"; text: string }[] = [];
      if (typeof r.pattern === "string") {
        blocks.push({
          type: "text",
          text: `<glob-pattern>${r.pattern}</glob-pattern>`,
        });
      }
      blocks.push({
        type: "text",
        text: `<glob-paths>${paths.join("\n")}</glob-paths>`,
      });
      if (r.truncated === true || metadataRecord(payload).truncated === true) {
        blocks.push({
          type: "text",
          text: "<glob-truncated>true</glob-truncated>",
        });
      }
      return blocks;
    }
    if (typeof result === "string" && payload.isError !== true) {
      const metadata = metadataRecord(payload);
      const pattern = typeof metadata.pattern === "string" ? metadata.pattern : null;
      const projection = plainGlobProjection(result);
      const blocks: { type: "text"; text: string }[] = [];
      if (pattern !== null) {
        blocks.push({
          type: "text",
          text: `<glob-pattern>${pattern}</glob-pattern>`,
        });
      }
      blocks.push({
        type: "text",
        text: `<glob-paths>${projection.paths.join("\n")}</glob-paths>`,
      });
      if (projection.truncated || metadata.truncated === true) {
        blocks.push({
          type: "text",
          text: "<glob-truncated>true</glob-truncated>",
        });
      }
      return blocks;
    }
  }

  return [{ type: "text", text: stringResult(result) }];
}

/**
 * Tool-error content formatter. Wraps an error message and an
 * optional tool name in a `<tool-error>` envelope so the cross-cutting
 * error renderer can dispatch on it regardless of which tool emitted
 * the error. `pickToolResultDispatch`
 * checks for this envelope BEFORE per-tool routing, so any tool that
 * surfaces a result through the error channel renders consistently.
 */
export function formatStructuredToolError(
  toolName: string,
  message: string,
): readonly { readonly type: "text"; readonly text: string }[] {
  const blocks: { type: "text"; text: string }[] = [];
  if (toolName.length > 0) {
    blocks.push({
      type: "text",
      text: `<tool-error-name>${toolName}</tool-error-name>`,
    });
  }
  blocks.push({
    type: "text",
    text: `<tool-error>${message}</tool-error>`,
  });
  return blocks;
}

export function adaptTranscriptEvents(
  events: readonly SessionTranscriptEvent[],
  startupMessages: readonly LLMMessage[] = [],
): AdaptedTranscript {
  const orderedEvents = orderSequencedEvents(events);
  const settledCollabSpawnCallIds = collectSettledCollabSpawnCallIds(orderedEvents);
  const out: any[] = startupMessages.map((message, index) =>
    // Startup messages have no source event; key them by position so their
    // uuids are also stable across re-projections.
    makeUserMessage(message.content, `startup:${index}`));
  const seen = new Set<string>();
  const openTools = new Set<string>();
  const toolNames = new Set<string>();
  const runningToolNames = new Map<string, string>();
  const settledToolCallIds = new Set<string>();
  const suppressedToolResults = new Set<string>();
  const pendingToolInputDeltas = new Map<number, string[]>();
  const durableQueuedPromptUuids = new Set<string>();
  const collabAgents = new Map<string, CollabAgentDisplay>();
  const streamingToolUses: StreamingToolUse[] = [];
  let streamingText = "";
  let realtimeStreamingText = "";
  let turnStreamedChars = 0;
  let latestUsage: AdaptedTranscript["latestUsage"] = null;
  let streamingThinking:
    | {
        thinking: string;
        isStreaming: boolean;
        streamingEndedAt?: number;
        redacted: boolean;
        kind: "thinking" | "reasoning_summary";
      }
    | null = null;
  let lastThinkingText = "";
  let currentTurnId: string | null = null;
  let lastAssistantText = "";
  let isStreaming = false;

  const persistAssistantText = (content: string, nextUuid: () => string): void => {
    if (content.trim().length === 0 || content === lastAssistantText) {
      return;
    }
    out.push(makeAssistantTextMessage(content, nextUuid()));
    lastAssistantText = content;
  };

  const flushStreamingText = (nextUuid: () => string): void => {
    persistAssistantText(streamingText, nextUuid);
    streamingText = "";
  };

  for (const raw of orderedEvents) {
    const event = unwrap(raw);
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    const payload = payloadRecord(event.payload);
    // Stable row identity (M-TUI-1): each message projected from this event
    // gets a uuid of `${event.key}:${blockIndex}` from a per-event counter, so
    // re-projecting the same event list (every streaming delta) yields the
    // same uuids for already-projected messages. The counter is shared across
    // every message type exactly so one event fanning out to several messages
    // (assistant text + thinking + tool rows) can never hand the same uuid to
    // two rows. The projection is deterministic given the same ordered events,
    // so block indices line up across re-runs.
    let blockIndex = 0;
    const nextUuid = (): string => `${event.key}:${blockIndex++}`;

    switch (event.type) {
      case "history_cleared":
        out.length = 0;
        seen.clear();
        seen.add(event.key);
        openTools.clear();
        toolNames.clear();
        runningToolNames.clear();
        settledToolCallIds.clear();
        suppressedToolResults.clear();
        pendingToolInputDeltas.clear();
        collabAgents.clear();
        streamingToolUses.length = 0;
        streamingText = "";
        realtimeStreamingText = "";
        streamingThinking = null;
        lastThinkingText = "";
        currentTurnId = null;
        lastAssistantText = "";
        isStreaming = false;
        break;
      case "history_replaced": {
        out.length = 0;
        seen.clear();
        seen.add(event.key);
        openTools.clear();
        toolNames.clear();
        runningToolNames.clear();
        settledToolCallIds.clear();
        suppressedToolResults.clear();
        pendingToolInputDeltas.clear();
        collabAgents.clear();
        streamingToolUses.length = 0;
        streamingText = "";
        realtimeStreamingText = "";
        streamingThinking = null;
        lastThinkingText = "";
        currentTurnId = null;
        lastAssistantText = "";
        isStreaming = false;
        const replacement = (payload as HistoryReplacedEvent["payload"]).messages;
        if (Array.isArray(replacement)) {
          out.push(...(replacement as readonly RuntimeTranscriptMessage[]));
        }
        break;
      }
      case "turn_start":
      case "turn_started":
        isStreaming = true;
        streamingText = "";
        turnStreamedChars = 0;
        currentTurnId =
          typeof payload.turnId === "string" ? payload.turnId : currentTurnId;
        // Clear streaming tool state when a new turn boundary arrives. Any
        // partially-streamed tool inputs from the previous turn are abandoned
        // because they will never receive a matching completion event in this
        // turn.
        streamingToolUses.length = 0;
        pendingToolInputDeltas.clear();
        // Drop any thinking accumulator from a previous turn so the live
        // visibility window resets cleanly. Persisted `agent_thinking`
        // rows from the prior turn are already in `out`.
        streamingThinking = null;
        lastThinkingText = "";
        break;
      case "turn_complete": {
        const content =
          typeof payload.lastAgentMessage === "string"
            ? payload.lastAgentMessage
            : typeof payload.content === "string"
              ? payload.content
              : streamingText;
        persistAssistantText(content, nextUuid);
        streamingText = "";
        streamingToolUses.length = 0;
        pendingToolInputDeltas.clear();
        isStreaming = false;
        if (
          typeof payload.turnId !== "string" ||
          currentTurnId === null ||
          payload.turnId === currentTurnId
        ) {
          currentTurnId = null;
        }
        break;
      }
      case "turn_aborted":
        // Phase 5 #56: previously this case cleared `streamingText`
        // unconditionally, so any text the model had already
        // produced before the user pressed ESC was silently dropped
        // from the transcript. Preserve the partial text as an
        // assistant message so the user retains the context they
        // were watching get generated. Skip when nothing is buffered
        // to avoid emitting empty assistant rows.
        persistAssistantText(streamingText, nextUuid);
        // Same preservation rule for partially-streamed thinking text.
        // Without this, an Esc during the thinking phase silently dropped
        // the visible chain-of-thought the user was reading.
        if (
          streamingThinking !== null &&
          !streamingThinking.redacted &&
          streamingThinking.thinking.trim().length > 0 &&
          streamingThinking.thinking !== lastThinkingText
        ) {
          out.push(
            makeAssistantThinkingMessage(streamingThinking.thinking, false, nextUuid()),
          );
          lastThinkingText = streamingThinking.thinking;
        }
        streamingText = "";
        streamingThinking = null;
        isStreaming = false;
        if (
          typeof payload.turnId !== "string" ||
          currentTurnId === null ||
          payload.turnId === currentTurnId
        ) {
          currentTurnId = null;
        }
        // Clear streaming tool state on cancellation.
        // stream cancellation — any partially-streamed tool inputs are
        // abandoned because their completion events will never arrive
        // for this turn.
        streamingToolUses.length = 0;
        pendingToolInputDeltas.clear();
        out.push(makeSystemMessage(`Turn aborted: ${stringResult(payload.reason)}`, "warning", nextUuid()));
        break;
      case "user_message":
        // A submitted user message is a hard visible turn boundary. Some
        // daemon streams can miss or de-dupe lifecycle events between prompts,
        // so close any live assistant text here before accumulating the next
        // response.
        flushStreamingText(nextUuid);
        if (typeof payload.queuedCommandUuid === "string") {
          durableQueuedPromptUuids.add(payload.queuedCommandUuid);
        }
        out.push(makeUserMessage(payload.displayText ?? payload.message, nextUuid()));
        break;
      case "queued_command":
        if (
          typeof payload.uuid === "string" &&
          durableQueuedPromptUuids.has(payload.uuid)
        ) {
          break;
        }
        if (
          payload.commandMode === "prompt" &&
          payload.isMeta !== true &&
          (payload.originKind === undefined || payload.originKind === "human")
        ) {
          const displayText =
            typeof payload.displayText === "string"
              ? payload.displayText
              : typeof payload.content === "string"
                ? payload.content
                : "";
          flushStreamingText(nextUuid);
          out.push(makeUserMessage(displayText, nextUuid()));
        }
        break;
      case "request_user_input":
      case "mcp_elicitation_request":
        out.push(makeSystemMessage(formatElicitationSummary(event.type, payload), "info", nextUuid()));
        break;
      case "assistant_text":
        if (typeof payload.content === "string") {
          streamingText += payload.content;
          turnStreamedChars += payload.content.length;
        }
        break;
      case "agent_message_delta":
        if (typeof payload.delta === "string") {
          streamingText += payload.delta;
          turnStreamedChars += payload.delta.length;
        }
        break;
      case "assistant_thinking_block_start": {
        const redacted = payload.redacted === true;
        const kind: "thinking" | "reasoning_summary" =
          payload.kind === "reasoning_summary" ? "reasoning_summary" : "thinking";
        // The provider may emit multiple thinking blocks per turn
        // (interleaved with tool_use). Each block_start resets the live
        // accumulator — the previous block's text is already persisted via
        // `agent_thinking` (or, for an in-flight block, dropped because
        // the model decided to open a new one).
        streamingThinking = {
          thinking: "",
          isStreaming: true,
          redacted,
          kind,
        };
        break;
      }
      case "assistant_thinking_delta": {
        const delta =
          typeof payload.delta === "string" ? payload.delta : "";
        if (delta.length === 0) break;
        turnStreamedChars += delta.length;
        const kind: "thinking" | "reasoning_summary" =
          payload.kind === "reasoning_summary" ? "reasoning_summary" : "thinking";
        if (streamingThinking === null) {
          // Provider sent a delta without a preceding block_start. Synthesise
          // the shell so the renderer has somewhere to append.
          streamingThinking = {
            thinking: delta,
            isStreaming: true,
            redacted: false,
            kind,
          };
        } else if (!streamingThinking.redacted) {
          streamingThinking = {
            ...streamingThinking,
            thinking: streamingThinking.thinking + delta,
            isStreaming: true,
          };
        }
        break;
      }
      case "assistant_thinking_block_stop":
        if (streamingThinking !== null) {
          streamingThinking = {
            ...streamingThinking,
            isStreaming: false,
            streamingEndedAt: Date.now(),
          };
        }
        break;
      case "agent_thinking": {
        const text = typeof payload.text === "string" ? payload.text : "";
        const redacted = payload.redacted === true;
        if (text.length === 0 && !redacted) break;
        if (text === lastThinkingText) break;
        out.push(makeAssistantThinkingMessage(text, redacted, nextUuid()));
        lastThinkingText = text;
        break;
      }
      case "realtime_started":
        out.push(makeSystemMessage("Realtime voice started", "info", nextUuid()));
        break;
      case "realtime_transcript_delta":
        if (
          !isUserRealtimeRole(payload.role) &&
          typeof payload.delta === "string"
        ) {
          realtimeStreamingText += payload.delta;
        }
        break;
      case "realtime_transcript_done":
        if (typeof payload.text === "string") {
          if (isUserRealtimeRole(payload.role)) {
            out.push(makeUserMessage(payload.text, nextUuid()));
          } else if (payload.text !== lastAssistantText) {
            out.push(makeAssistantTextMessage(payload.text, nextUuid()));
            lastAssistantText = payload.text;
          }
          realtimeStreamingText = "";
        }
        break;
      case "realtime_item_added":
        out.push(
          makeSystemMessage(
            `Realtime item: ${formatRealtimeItemSummary(payload.item as never)}`,
            "info",
            nextUuid(),
          ),
        );
        break;
      case "realtime_error":
        out.push(
          makeSystemMessage(
            typeof payload.message === "string"
              ? payload.message
              : "Realtime error",
            "error",
            nextUuid(),
          ),
        );
        realtimeStreamingText = "";
        break;
      case "realtime_closed":
        out.push(makeSystemMessage(formatRealtimeClosed(payload), "info", nextUuid()));
        realtimeStreamingText = "";
        break;
      case "agent_message":
        if (typeof payload.message === "string" && payload.message !== lastAssistantText) {
          const subagent = parseSubagentNotification(payload.message);
          if (subagent !== null) {
            out.push(
              makeCollabAgentMessage(
                subagent.title,
                subagent.details,
                subagent.state,
                nextUuid(),
              ),
            );
          } else {
            out.push(makeAssistantTextMessage(payload.message, nextUuid()));
            lastAssistantText = payload.message;
          }
        }
        streamingText = "";
        break;
      case "tool_call":
        if (
          "toolCall" in raw &&
          raw.toolCall &&
          typeof raw.toolCall === "object"
        ) {
          const toolCall = raw.toolCall as {
            readonly id?: string;
            readonly name?: string;
            readonly arguments?: string;
          };
          pushToolUse(
            out,
            openTools,
            toolNames,
            toolCall.id ?? randomUUID(),
            toolCall.name ?? "Tool",
            safeJson(toolCall.arguments),
            nextUuid,
          );
        }
        break;
      case "tool_result":
        if (
          "toolCall" in raw &&
          raw.toolCall &&
          typeof raw.toolCall === "object"
        ) {
          const toolCall = raw.toolCall as { readonly id?: string };
          pushToolResult(
            out,
            openTools,
            settledToolCallIds,
            toolCall.id ?? randomUUID(),
            "result" in raw ? raw.result : "",
            nextUuid,
            false,
          );
        }
        break;
      case "tool_call_started":
      case "mcp_tool_call_begin":
      case "exec_command_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        if (settledToolCallIds.has(callId)) {
          break;
        }
        const toolName =
          typeof payload.toolName === "string"
            ? payload.toolName
            : event.type === "exec_command_begin"
              ? "Bash"
              : "MCP";
        // Collab v2 agent tools emit their own
        // `collab_agent_spawn_*`, `collab_agent_interaction_*`,
        // `collab_waiting_*`, and `collab_close_*` events that the
        // transcript renders as structured collab-agent rows. Skipping the
        // raw `tool_call_started`/`tool_call_completed` row here keeps
        // a single row per spawn/wait/close/send-input call instead of
        // duplicating the structured row with a generic
        // `spawn_agent({...})` row that drowns the task_name in JSON.
        // `pushToolResult` already no-ops when the callId is not open,
        // so the matching `tool_call_completed` row drops naturally.
        if (COLLAB_V2_TOOL_NAMES.has(toolName)) {
          suppressedToolResults.add(callId);
          break;
        }
        pushToolUse(out, openTools, toolNames, callId, toolName, toolInput(payload), nextUuid);
        runningToolNames.set(callId, toolName);
        break;
      }
      case "tool_input_block_start": {
        // Provider-emitted (R6) when a tool_use content
        // block begins streaming. Matches the content_block_start case in
        // messages.ts:3024-3037 that appends a new element to the
        // streamingToolUses array. The Messages.tsx:446 filter
        // removes the element again once the same callId/id appears in
        // inProgressToolUseIDs (which our `tool_call_started` handler
        // already populates via openTools).
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        const indexCandidate =
          typeof payload.index === "number" ? payload.index : null;
        if (indexCandidate === null) break;
        const contentBlockRaw = payload.contentBlock;
        const contentBlock =
          contentBlockRaw &&
          typeof contentBlockRaw === "object" &&
          (contentBlockRaw as Record<string, unknown>).type === "tool_use"
            ? (contentBlockRaw as StreamingToolUse["contentBlock"])
            : ({
                type: "tool_use",
                id: callId,
                name:
                  typeof payload.toolName === "string" ? payload.toolName : "tool",
                input: {},
              } as StreamingToolUse["contentBlock"]);
        // De-dupe on (index, contentBlock.id): if the same block_start fires
        // twice (e.g. retried stream), reuse the existing slot rather than
        // appending a duplicate that would confuse the Messages filter.
        const existing = streamingToolUses.findIndex(
          (entry) =>
            entry.index === indexCandidate &&
            entry.contentBlock.id === contentBlock.id,
        );
        if (existing === -1) {
          streamingToolUses.push({
            index: indexCandidate,
            contentBlock,
            unparsedToolInput: "",
          });
          const pending = pendingToolInputDeltas.get(indexCandidate);
          if (pending && pending.length > 0) {
            const slot = streamingToolUses.findIndex(
              (entry) => entry.index === indexCandidate,
            );
            if (slot !== -1) {
              const previous = streamingToolUses[slot]!;
              streamingToolUses[slot] = {
                ...previous,
                unparsedToolInput: previous.unparsedToolInput + pending.join(""),
              };
            }
            pendingToolInputDeltas.delete(indexCandidate);
          }
        }
        break;
      }
      case "tool_input_delta": {
        // Provider-emitted (R6) for each input_json_delta. Matches
        // messages.ts:3062-3079: locate the element with the matching index
        // and append the partial JSON; if no element is found, return the
        // array unchanged (the `if (!element) return _` early
        // return on line 3068-3070).
        const indexCandidate =
          typeof payload.index === "number" ? payload.index : null;
        if (indexCandidate === null) break;
        const partialJson =
          typeof payload.partialJson === "string"
            ? payload.partialJson
            : typeof payload.partial_json === "string"
              ? payload.partial_json
              : null;
        if (partialJson === null) break;
        turnStreamedChars += partialJson.length;
        const slot = streamingToolUses.findIndex(
          (entry) => entry.index === indexCandidate,
        );
        if (slot === -1) {
          const pending = pendingToolInputDeltas.get(indexCandidate) ?? [];
          pending.push(partialJson);
          pendingToolInputDeltas.set(indexCandidate, pending);
          break;
        }
        const previous = streamingToolUses[slot]!;
        streamingToolUses[slot] = {
          ...previous,
          unparsedToolInput: previous.unparsedToolInput + partialJson,
        };
        break;
      }
      case "tool_call_completed":
      case "mcp_tool_call_end":
      case "exec_command_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        if (suppressedToolResults.has(callId)) {
          suppressedToolResults.delete(callId);
          settledToolCallIds.add(callId);
          break;
        }
        const isError =
          typeof payload.isError === "boolean"
            ? payload.isError
            : typeof payload.exitCode === "number" && payload.exitCode !== 0;
        if (!openTools.has(callId) && !settledToolCallIds.has(callId)) {
          const streamedToolUse = streamingToolUses.find(
            (entry) => entry.contentBlock.id === callId,
          );
          if (streamedToolUse !== undefined) {
            pushToolUse(
              out,
              openTools,
              toolNames,
              callId,
              streamedToolUse.contentBlock.name,
              streamedToolInput(streamedToolUse),
              nextUuid,
            );
            runningToolNames.set(callId, streamedToolUse.contentBlock.name);
          }
        }
        const toolName =
          runningToolNames.get(callId) ??
          (event.type === "exec_command_end"
            ? "Bash"
            : event.type === "mcp_tool_call_end"
              ? "MCP"
              : "tool");
        const result = formatStructuredToolResult(toolName, event.type, payload);
        // The EnterPlanMode tool result carries the full plan-mode
        // instructions for the MODEL ("In plan mode, you should: … DO NOT
        // write or edit any files except the plan file"). Rendering that
        // agent-internal guidance as a chat message reads like a leaked
        // system prompt — show the state change instead. The model still
        // receives the full text on its own result channel; this only
        // changes what the transcript displays.
        const displayResult =
          toolName === "EnterPlanMode" ? "Entered plan mode" : result;
        pushToolResult(
          out,
          openTools,
          settledToolCallIds,
          callId,
          displayResult,
          nextUuid,
          isError,
          payload.result,
        );
        runningToolNames.delete(callId);
        // Remove the matching streaming-tool-use element so the
        // <Messages> consumer stops rendering a synthetic streaming cell
        // for a tool that has already settled. The message renderer relies on
        // the Messages.tsx:446 filter (drop ids in inProgressToolUseIDs or
        // normalizedToolUseIDs) to do this; we drop here on completion because
        // AgenC moves the call out of openTools at the same step.
        const slot = streamingToolUses.findIndex(
          (entry) => entry.contentBlock.id === callId,
        );
        if (slot !== -1) {
          streamingToolUses.splice(slot, 1);
        }
        break;
      }
      case "context_compacted":
        out.push(makeSystemMessage("Context compacted", "info", nextUuid()));
        break;
      case "token_count":
        latestUsage = {
          input_tokens: nonNegativeInteger(payload.promptTokens),
          output_tokens: nonNegativeInteger(payload.completionTokens),
          cache_creation_input_tokens: nonNegativeInteger(
            payload.cacheCreationInputTokens,
          ),
          cache_read_input_tokens: nonNegativeInteger(payload.cachedInputTokens),
        };
        out.push(makeSystemMessage(formatTokenCountUpdate(payload), "info", nextUuid()));
        break;
      case "protocol_claim":
      case "protocol_settle":
      case "protocol_slash":
      case "protocol_stake": {
        flushStreamingText(nextUuid);
        const message = formatProtocolEvent(event.type, payload);
        if (message !== null) {
          out.push(makeProtocolEventMessage(message, nextUuid()));
        }
        break;
      }
      case "warning": {
        // Allow-list of warning causes that surface to the user's
        // transcript. Every other cause stays in the daemon log and
        // observability sinks only — most of the 89 causes the
        // runtime emits are internal recovery, telemetry, or
        // background liveness events that the user cannot act on
        // and that would only clutter the chat surface.
        //
        // Audit-driven invariant: BLOCKER #50 was "88 of 89 warning
        // causes still leak to transcript" because the prior filter
        // suppressed only `background_agent_status`. Adding a new
        // user-actionable cause requires adding it explicitly here;
        // the allow-list approach also makes the visibility policy
        // grep-able from one source of truth.
        const cause =
          typeof (payload as { cause?: unknown }).cause === "string"
            ? ((payload as { cause: string }).cause)
            : undefined;
        if (!cause || !USER_VISIBLE_WARNING_CAUSES.has(cause)) break;
        out.push(makeSystemMessage(stringResult(payload.message), "warning", nextUuid()));
        break;
      }
      case "background_agent_status":
        if (!shouldRenderBackgroundAgentStatus(payload)) break;
        out.push(makeSystemMessage(formatBackgroundAgentStatus(payload), "info", nextUuid()));
        break;
      case "error":
      case "stream_error":
        out.push(makeSystemMessage(stringResult(payload.message), "error", nextUuid()));
        // Terminal for the turn. An error-terminated daemon turn never
        // arrives as `turn_complete`: run-turn's turn_complete(stopReason:
        // "error") is remapped to run_error → agent_status:error → this
        // `error` event. Without clearing the streaming state here,
        // `isStreaming` latches true and the "Working…" spinner never stops
        // (bug-audit-2026-07-11.md #13) — noteDaemonActivity already treats
        // `error` as turn-ending; this mirrors it in the reducer. Preserve
        // any partial text like `turn_aborted` does.
        persistAssistantText(streamingText, nextUuid);
        streamingText = "";
        streamingThinking = null;
        streamingToolUses.length = 0;
        pendingToolInputDeltas.clear();
        isStreaming = false;
        currentTurnId = null;
        break;
      case "slash_result": {
        // Format SlashCommandResult based on its kind instead of
        // JSON.stringifying the raw object — otherwise the user sees
        // `{ "kind": "error", "message": "..." }` in the transcript
        // (the literal stringified shape) rather than a clean error
        // message. Mirrors the formatter in `App.tsx` `renderResult`.
        const candidate =
          "result" in raw && raw.result !== null && typeof raw.result === "object"
            ? (raw.result as Record<string, unknown>)
            : payload;
        const kind = candidate.kind;
        if (kind === "text" || kind === "compact") {
          const text = candidate.text;
          if (typeof text === "string") {
            out.push(makeSystemMessage(text, "info", nextUuid()));
          }
          break;
        }
        if (kind === "error") {
          const msg = candidate.message;
          const text = typeof msg === "string" ? msg : stringResult(msg);
          // Never render a bare "Error: " row. The dispatcher path
          // populates `message` (e.g.
          // "Unrecognized command: /foo"); fall back to a generic label
          // only if a producer drops it.
          out.push(
            makeSystemMessage(
              `Error: ${text.length > 0 ? text : "slash command failed"}`,
              "error",
              nextUuid(),
            ),
          );
          break;
        }
        if (kind === "skip" || kind === "exit" || kind === "prompt") {
          // skip = handled silently; exit = app teardown elsewhere;
          // prompt = forwarded to the model via session.submit. None
          // need a transcript row.
          break;
        }
        // Unrecognized kind — fall back to the original behaviour so we
        // still surface SOMETHING rather than swallowing it silently.
        out.push(makeSystemMessage(stringResult(candidate), "info", nextUuid()));
        break;
      }
      case "collab_agent_spawn_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        if (settledCollabSpawnCallIds.has(callId)) break;
        openTools.add(callId);
        const details = [
          promptDetail(payload.prompt),
          spawnTaskDetail(payload),
          spawnRequestDetail(payload),
        ].filter((detail): detail is string => detail !== null);
        out.push(makeCollabAgentMessage("Spawning agent", details, "running", nextUuid()));
        break;
      }
      case "collab_agent_spawn_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.delete(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "newThreadId", {
          path: "newAgentPath",
          nickname: "newAgentNickname",
          role: "newAgentRole",
          roleDisplayName: "newAgentRoleDisplayName",
        });
        const label = collabAgentLabel(collabAgents, payload.newThreadId);
        const status = payload.status;
        const details = [
          promptDetail(payload.prompt),
          spawnTaskDetail(payload),
          spawnRequestDetail(payload),
          collabSpawnStatusDetail(status),
          agentInteractionHint(collabAgents, payload.newThreadId, payload),
        ].filter((detail): detail is string => detail !== null);
        out.push(
          makeCollabAgentMessage(
            label === "agent" ? "Agent spawn failed" : `Spawned ${label}`,
            details,
            collabStatusState(status),
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_agent_interaction_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.add(callId);
        const label = collabAgentLabel(collabAgents, payload.receiverThreadId);
        const detail = promptDetail(payload.prompt);
        out.push(
          makeCollabAgentMessage(
            `Sending input to ${label}`,
            detail ? [detail] : [],
            "running",
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_agent_interaction_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.delete(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "receiverThreadId", {
          nickname: "receiverAgentNickname",
          role: "receiverAgentRole",
          roleDisplayName: "receiverAgentRoleDisplayName",
        });
        const label = collabAgentLabel(collabAgents, payload.receiverThreadId);
        const status = payload.status;
        const details = [
          promptDetail(payload.prompt),
          `status: ${collabStatusSummary(status)}`,
        ].filter((detail): detail is string => detail !== null);
        out.push(
          makeCollabAgentMessage(
            `Sent input to ${label}`,
            details,
            collabStatusState(status),
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_waiting_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.add(callId);
        if (Array.isArray(payload.receiverAgents)) {
          for (const agent of payload.receiverAgents) {
            updateCollabAgentFromRef(collabAgents, agent);
          }
        }
        const ids = Array.isArray(payload.receiverThreadIds)
          ? payload.receiverThreadIds.filter((id) => typeof id === "string")
          : [];
        const labels = ids.map((id) => collabAgentLabel(collabAgents, id));
        const title =
          labels.length === 1
            ? `Waiting for ${labels[0]}`
            : labels.length > 1
              ? `Waiting for ${labels.length} agents`
              : "Waiting for agents";
        out.push(makeCollabAgentMessage(title, labels.length > 1 ? labels : [], "running", nextUuid()));
        break;
      }
      case "collab_waiting_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.delete(callId);
        const details: string[] = [];
        const timedOut = payload.timedOut === true || payload.timed_out === true;
        let finalState: CollabAgentMessageState = timedOut ? "info" : "success";
        const noteStatus = (status: unknown): void => {
          if (collabStatusState(status) === "error") finalState = "error";
        };
        const entries = Array.isArray(payload.agentStatuses)
          ? payload.agentStatuses
          : [];
        for (const entry of entries) {
          updateCollabAgentFromRef(collabAgents, entry);
          if (entry && typeof entry === "object") {
            const threadId = (entry as Record<string, unknown>).threadId;
            const status = (entry as Record<string, unknown>).status;
            noteStatus(status);
            details.push(
              `${collabAgentLabel(collabAgents, threadId)}: ${collabStatusSummary(status)}`,
            );
          }
        }
        if (details.length === 0 && payload.statuses && typeof payload.statuses === "object") {
          for (const [threadId, status] of Object.entries(payload.statuses)) {
            noteStatus(status);
            details.push(
              `${collabAgentLabel(collabAgents, threadId)}: ${collabStatusSummary(status)}`,
            );
          }
        }
        details.push(...collabMailboxUpdateDetails(payload.mailboxUpdates));
        out.push(
          makeCollabAgentMessage(
            timedOut ? "Wait call timed out" : "Finished waiting",
            details.length > 0
              ? details
              : [timedOut ? "Agents may still be running" : "No agents completed yet"],
            finalState,
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_close_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.add(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "receiverThreadId", {
          nickname: "receiverAgentNickname",
          role: "receiverAgentRole",
          roleDisplayName: "receiverAgentRoleDisplayName",
        });
        out.push(
          makeCollabAgentMessage(
            `Closing ${collabAgentLabel(collabAgents, payload.receiverThreadId)}`,
            [],
            "running",
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_close_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.delete(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "receiverThreadId", {
          nickname: "receiverAgentNickname",
          role: "receiverAgentRole",
          roleDisplayName: "receiverAgentRoleDisplayName",
        });
        out.push(
          makeCollabAgentMessage(
            `Closed ${collabAgentLabel(collabAgents, payload.receiverThreadId)}`,
            [`previous status: ${collabStatusSummary(payload.status)}`],
            collabStatusState(payload.status) === "error" ? "error" : "success",
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_resume_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.add(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "receiverThreadId", {
          nickname: "receiverAgentNickname",
          role: "receiverAgentRole",
          roleDisplayName: "receiverAgentRoleDisplayName",
        });
        out.push(
          makeCollabAgentMessage(
            `Resuming ${collabAgentLabel(collabAgents, payload.receiverThreadId)}`,
            [],
            "running",
            nextUuid(),
          ),
        );
        break;
      }
      case "collab_resume_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        openTools.delete(callId);
        updateCollabAgentFromPayload(collabAgents, payload, "receiverThreadId", {
          nickname: "receiverAgentNickname",
          role: "receiverAgentRole",
          roleDisplayName: "receiverAgentRoleDisplayName",
        });
        out.push(
          makeCollabAgentMessage(
            `Resumed ${collabAgentLabel(collabAgents, payload.receiverThreadId)}`,
            [`status: ${collabStatusSummary(payload.status)}`],
            collabStatusState(payload.status),
            nextUuid(),
          ),
        );
        break;
      }
      case "plan_started":
        out.push(makeSystemMessage(`Plan started: ${stringResult(payload.title)}`, "info", nextUuid()));
        break;
      case "plan_item_completed":
        out.push(makeAssistantTextMessage(stringResult(payload.finalText), nextUuid()));
        break;
      case "deprecation_notice":
        out.push(makeSystemMessage(stringResult(payload.reason), "warning", nextUuid()));
        break;
      default:
        break;
    }
  }

  return {
    messages: out,
    streamingText:
      streamingText.length > 0
        ? streamingText
        : realtimeStreamingText.length > 0
          ? realtimeStreamingText
          : null,
    inProgressToolUseIDs: openTools,
    toolNames,
    isStreaming,
    currentTurnId,
    streamingToolUses,
    streamingThinking,
    turnStreamedChars,
    latestUsage,
  };
}

interface TranscriptState {
  readonly events: readonly SessionTranscriptEvent[];
  readonly keys: ReadonlySet<string>;
  readonly maxSeq: number | null;
}

type TranscriptAction =
  | { readonly kind: "reset"; readonly events: readonly SessionTranscriptEvent[] }
  | { readonly kind: "append"; readonly event: SessionTranscriptEvent }
  | { readonly kind: "appendBatch"; readonly events: readonly SessionTranscriptEvent[] };

/**
 * Fields on raw transcript events that carry tool-result content. These are the
 * per-tool-call payloads that can each be megabytes (file reads, greps, command
 * output). Reset/replacement events (`history_cleared`/`history_replaced`) are
 * deliberately excluded — their `messages` payload is an authoritative rollout
 * snapshot that must round-trip verbatim, so we never rewrite it.
 */
function clampEventForStorage(
  event: SessionTranscriptEvent,
): SessionTranscriptEvent {
  if (isTranscriptResetEvent(event)) return event;

  // Only clamp events whose dedup key is content-independent (keyed on `seq`
  // or `id`). For keyless events `eventKey` falls back to `JSON.stringify`, so
  // rewriting content would change the key — and eviction (which recomputes the
  // key from the stored, clamped event) could then fail to prune it. Such events
  // never carry large tool-result content in practice, so skipping them is safe.
  const hasStableKey =
    ("seq" in event && typeof event.seq === "number") ||
    ("id" in event && typeof event.id === "string");
  if (!hasStableKey) return event;

  const record = event as Record<string, unknown>;
  let mutated = false;
  const next: Record<string, unknown> = { ...record };

  // `tool_result` events carry the content directly on `result`.
  if ("result" in record) {
    const clamped = clampResultContent(record.result);
    if (clamped !== record.result) {
      next.result = clamped;
      mutated = true;
    }
  }

  // Result content (and command stdout) for `*_completed`/`*_end` events lives
  // under a `payload` object — either at the top level (event-log shape) or
  // nested under `msg` (phase-event shape, mirrored by `unwrap`). Clamp only the
  // known string-bearing fields, preserving the rest of the shape so dedup keys
  // and ordering stay intact.
  const clampPayload = (
    payload: unknown,
  ): Record<string, unknown> | null => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const payloadRecord = payload as Record<string, unknown>;
    let payloadMutated = false;
    const nextPayload: Record<string, unknown> = { ...payloadRecord };
    for (const field of ["result", "content", "stdout"]) {
      if (field in payloadRecord) {
        const clamped = clampResultContent(payloadRecord[field]);
        if (clamped !== payloadRecord[field]) {
          nextPayload[field] = clamped;
          payloadMutated = true;
        }
      }
    }
    return payloadMutated ? nextPayload : null;
  };

  const topPayload = clampPayload(record.payload);
  if (topPayload) {
    next.payload = topPayload;
    mutated = true;
  }

  const msg = record.msg;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const msgRecord = msg as Record<string, unknown>;
    const msgPayload = clampPayload(msgRecord.payload);
    if (msgPayload) {
      next.msg = { ...msgRecord, payload: msgPayload };
      mutated = true;
    }
  }

  return mutated ? (next as SessionTranscriptEvent) : event;
}

/**
 * Ring-buffer the events array in place: if it grew past
 * `MAX_TRANSCRIPT_EVENTS`, drop the oldest events and remove their dedup keys
 * from `keys`. Visually safe — the renderer is virtualized to ~300 rows, so the
 * dropped events are off-screen, and their full content remains in scrollback
 * and the on-disk transcript. Bounds both event count and total retained bytes.
 */
function evictOldestEvents(
  events: SessionTranscriptEvent[],
  keys: Set<string>,
): void {
  if (events.length <= MAX_TRANSCRIPT_EVENTS) return;
  const dropCount = events.length - MAX_TRANSCRIPT_EVENTS;
  const dropped = events.splice(0, dropCount);
  for (const event of dropped) {
    keys.delete(eventKey(event));
  }
}

function buildTranscriptState(
  unorderedEvents: readonly SessionTranscriptEvent[],
): TranscriptState {
  const keys = new Set<string>();
  const events: SessionTranscriptEvent[] = [];
  let maxSeq: number | null = null;

  for (const event of orderSequencedEvents(unorderedEvents)) {
    const key = eventKey(event);
    if (isTranscriptResetEvent(event)) {
      keys.clear();
      events.length = 0;
      maxSeq = null;
      keys.add(key);
      events.push(clampEventForStorage(event));
      maxSeq = maxEventSeq(maxSeq, event);
      continue;
    }
    if (keys.has(key)) continue;
    keys.add(key);
    events.push(clampEventForStorage(event));
    maxSeq = maxEventSeq(maxSeq, event);
  }

  evictOldestEvents(events, keys);

  return { events, keys, maxSeq };
}

function reducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.kind) {
    case "reset":
      return buildTranscriptState(action.events);
    case "append": {
      const key = eventKey(action.event);
      if (state.keys.has(key)) return state;

      const seq = eventSeq(action.event);
      if (
        isTranscriptResetEvent(action.event) ||
        (seq !== null && state.maxSeq !== null && seq < state.maxSeq)
      ) {
        return buildTranscriptState([...state.events, action.event]);
      }

      // Clone the key Set rather than mutating `state.keys` in place: a reducer
      // must be pure. Under React StrictMode's dev double-invoke the reducer runs
      // twice with the same prev state; an in-place `state.keys.add(key)` on the
      // first invoke made the second invoke see the key as already-present and
      // drop the event from the committed render. The clone is O(n) in the Set
      // size, but ring-buffer eviction bounds that Set alongside the events array.
      const events = [...state.events, clampEventForStorage(action.event)];
      const keys = new Set(state.keys);
      keys.add(key);
      evictOldestEvents(events, keys);

      return {
        events,
        keys,
        maxSeq: seq === null ? state.maxSeq : maxEventSeq(state.maxSeq, action.event),
      };
    }
    case "appendBatch": {
      // Apply a whole coalesced batch of events with ONE array copy and ONE
      // re-projection (the caller flushes buffered streaming deltas here). Doing
      // this per-event would be O(n) copy + O(n) projection PER delta — i.e.
      // O(n²) allocation across a streaming turn, which starved the GC and OOM'd
      // the TUI on long responses. A reset or an out-of-order event in the batch
      // is rare and falls back to a full rebuild for correctness.
      if (action.events.length === 0) return state;
      if (
        action.events.some(
          (event) =>
            isTranscriptResetEvent(event) ||
            (() => {
              const seq = eventSeq(event);
              return seq !== null && state.maxSeq !== null && seq < state.maxSeq;
            })(),
        )
      ) {
        return buildTranscriptState([...state.events, ...action.events]);
      }
      const keys = state.keys as Set<string>;
      const pending: SessionTranscriptEvent[] = [];
      let maxSeq = state.maxSeq;
      for (const event of action.events) {
        const key = eventKey(event);
        if (keys.has(key)) continue;
        pending.push(clampEventForStorage(event));
        keys.add(key);
        const seq = eventSeq(event);
        maxSeq = seq === null ? maxSeq : maxEventSeq(maxSeq, event);
      }
      if (pending.length === 0) return state;
      const events = [...state.events, ...pending];
      evictOldestEvents(events, keys);
      return { events, keys, maxSeq };
    }
  }
}

export function createSessionTranscriptStateForTesting(
  events: readonly SessionTranscriptEvent[],
): TranscriptState {
  return reducer(
    { events: [], keys: new Set(), maxSeq: null },
    { kind: "reset", events },
  );
}

export function appendSessionTranscriptEventForTesting(
  state: TranscriptState,
  event: SessionTranscriptEvent,
): TranscriptState {
  return reducer(state, { kind: "append", event });
}

export function appendSessionTranscriptBatchForTesting(
  state: TranscriptState,
  events: readonly SessionTranscriptEvent[],
): TranscriptState {
  return reducer(state, { kind: "appendBatch", events });
}

function initialEvents(session: AgenCBridgeSession): readonly SessionTranscriptEvent[] {
  const fromGetter = session.getInitialTranscriptEvents?.();
  const fromProperty = session.initialTranscriptEvents;
  return [...((fromGetter ?? fromProperty ?? []) as readonly SessionTranscriptEvent[])];
}

/**
 * Coalescing window for streaming events (~30fps). Bounds how often the
 * transcript re-projects + re-renders during a fast streaming turn regardless
 * of delta rate; the ~33ms of added latency on streaming text is imperceptible.
 */
const TRANSCRIPT_COALESCE_MS = 33;

/**
 * True for the high-frequency streaming deltas that are safe to batch. Only the
 * per-token text/thinking deltas coalesce; every structural event (tool calls,
 * results, turn boundaries, user messages) flushes immediately so the UI never
 * lags behind a change in shape.
 */
const COALESCABLE_STREAMING_TYPES: ReadonlySet<string> = new Set([
  "agent_message_delta",
  "assistant_thinking_delta",
  "assistant_text",
  "realtime_transcript_delta",
]);

function isCoalescableStreamingEvent(event: SessionTranscriptEvent): boolean {
  const record = event as { type?: unknown; msg?: { type?: unknown } };
  // Event-log shape carries `.type`; phase-event shape nests it under `.msg`.
  const type =
    typeof record.type === "string"
      ? record.type
      : typeof record.msg?.type === "string"
        ? record.msg.type
        : undefined;
  return type !== undefined && COALESCABLE_STREAMING_TYPES.has(type);
}

export function useSessionTranscript(
  session: AgenCBridgeSession,
  startupMessages: readonly LLMMessage[] = [],
) {
  const [state, dispatch] = useReducer(reducer, {
    events: [],
    keys: new Set(),
    maxSeq: null,
  });

  useEffect(() => {
    dispatch({ kind: "reset", events: initialEvents(session) });
  }, [session]);

  useEffect(() => {
    // Coalesce incoming events into ~30fps batches. High-frequency streaming
    // deltas (agent_message_delta / assistant_thinking_delta) otherwise dispatch
    // once each, and every dispatch re-copies the events array AND re-projects
    // the whole transcript — O(n²) work + garbage across a long streaming turn,
    // which OOM'd the TUI. Buffering flushes them as one `appendBatch`; a
    // non-streaming event (tool result, turn boundary, user message) flushes
    // immediately so the UI stays responsive to structure changes.
    const buffer: SessionTranscriptEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      dispatch(
        batch.length === 1
          ? { kind: "append", event: batch[0]! }
          : { kind: "appendBatch", events: batch },
      );
    };

    const enqueue = (event: SessionTranscriptEvent, immediate: boolean): void => {
      buffer.push(event);
      if (immediate) {
        flush();
        return;
      }
      if (timer === null) {
        timer = setTimeout(flush, TRANSCRIPT_COALESCE_MS);
        if (typeof (timer as { unref?: () => void }).unref === "function") {
          (timer as { unref: () => void }).unref();
        }
      }
    };

    const unsubscribeLog = session.eventLog?.subscribe((event) => {
      enqueue(event, !isCoalescableStreamingEvent(event));
    });
    const unsubscribePhase = session.subscribeToEvents?.((event) => {
      if (
        event &&
        typeof event === "object" &&
        ("type" in event || "msg" in event)
      ) {
        const typed = event as SessionTranscriptEvent;
        enqueue(typed, !isCoalescableStreamingEvent(typed));
      }
    });
    return () => {
      unsubscribeLog?.();
      unsubscribePhase?.();
      flush();
    };
  }, [session]);

  return useMemo(
    () => adaptTranscriptEvents(state.events, startupMessages),
    [state.events, startupMessages],
  );
}
