// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { randomUUID } from "node:crypto";
import { useEffect, useMemo, useReducer } from "react";

import type { LLMMessage, StreamingToolUse } from "../llm/types.js";
import type { Event } from "../session/event-log.js";
import type {
  HistoryReplacedEvent,
  RuntimeTranscriptMessage,
} from "../session/transcript-replacement.js";
import type { AgenCBridgeSession } from "./session-types.js";
import { formatRealtimeItemSummary } from "./realtime/state.js";

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
   * Mid-stream tool input accumulator that mirrors the upstream
   * `streamingToolUses` state from `screens/REPL.tsx:853`.
   * Each entry tracks an `input_json_delta`-driven tool-use block
   * whose JSON arguments are still arriving. Consumed by the upstream
   * `<Messages>` component (`components/Messages.tsx:222`) to render
   * synthetic streaming-tool-use cells while the model emits partial
   * arguments. Populated by row R5 of the streaming-tool-use parity
   * contract. Empty until R5 lands.
   */
  readonly streamingToolUses: readonly StreamingToolUse[];
  /**
   * Mid-stream extended-thinking accumulator. Mirrors `StreamingThinking`
   * from `runtime/src/utils/messages.ts:2923`. Populated by the
   * `assistant_thinking_*` event family emitted by `phases/stream-model.ts`.
   * Consumed by `<Messages>` (`components/Messages.tsx:122`) which renders
   * `<AssistantThinkingMessage>` while `isStreaming` or up to 30 s after
   * `streamingEndedAt` per the donor visibility rule. `null` when no
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
}

const SYNTHETIC_MODEL = "agenc";
const GLOB_NO_FILES_TEXT = "No files found";
const GLOB_TRUNCATION_PREFIX = "(Results are truncated.";

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

export function makeUserMessage(content: unknown): any {
  return {
    type: "user",
    message: {
      role: "user",
      content: textFromContent(content) || "(empty)",
    },
    uuid: randomUUID(),
    timestamp: timestamp(),
  };
}

export function makeAssistantTextMessage(content: string): any {
  return {
    type: "assistant",
    uuid: randomUUID(),
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
): any {
  return {
    type: "assistant",
    uuid: randomUUID(),
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
): any {
  return {
    ...makeAssistantTextMessage(""),
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
): any {
  const resultContent = isStructuredContentBlocks(content)
    ? content
    : stringResult(content);
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
    isMeta: true,
    uuid: randomUUID(),
    timestamp: timestamp(),
    toolUseResult: typeof resultContent === "string"
      ? resultContent
      : resultContent.map((b) => b.text).join("\n"),
  };
}

export function makeSystemMessage(
  content: string,
  level: "info" | "warning" | "error" = "info",
): any {
  return {
    type: "system",
    subtype: "informational",
    content,
    isMeta: false,
    timestamp: timestamp(),
    uuid: randomUUID(),
    level,
  };
}

function eventKey(event: SessionTranscriptEvent): string {
  if ("seq" in event && typeof event.seq === "number") return `seq:${event.seq}`;
  if ("id" in event && typeof event.id === "string") return `id:${event.id}`;
  try {
    return JSON.stringify(event);
  } catch {
    return `${event.type}:${Math.random()}`;
  }
}

function unwrap(event: SessionTranscriptEvent): {
  readonly type: string;
  readonly payload: unknown;
  readonly key: string;
} {
  if ("msg" in event && event.msg && typeof event.msg === "object") {
    const msg = event.msg as { readonly type?: unknown; readonly payload?: unknown };
    return {
      type: typeof msg.type === "string" ? msg.type : "unknown",
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
): void {
  openTools.add(callId);
  toolNames.add(toolName);
  out.push(makeToolUseMessage(callId, toolName, input));
}

function pushToolResult(
  out: any[],
  openTools: Set<string>,
  callId: string,
  result: unknown,
  isError = false,
): void {
  // Phase 5 #58 + #59: previously this function always pushed a
  // tool_result row, regardless of whether `callId` was actually
  // open in the tool-tracking set. Two real failures fell out:
  //
  //   #58 — collab_agent_spawn_end and collab_agent_interaction_end
  //   (and the close/resume/waiting variants) all called pushToolResult
  //   with the same callId. A normal subagent lifecycle produced two
  //   or three duplicate tool_result rows in the transcript.
  //
  //   #59 — when tool_call_completed arrived without a preceding
  //   tool_call_started (out-of-order events from a flaky daemon
  //   stream, or a duplicate completion event), pushToolResult still
  //   emitted a tool_result row with no matching tool_use. The model
  //   on the next iteration saw an orphan tool message and could
  //   fail wire-format validation downstream.
  //
  // Guard: only emit when the callId is currently open. The
  // `openTools.delete` on first call closes the slot; subsequent
  // calls for the same callId become no-ops.
  if (!openTools.has(callId)) return;
  openTools.delete(callId);
  out.push(makeToolResultMessage(callId, result, isError));
}

function formatAgentStatus(status: unknown): string {
  if (!status || typeof status !== "object") return String(status ?? "unknown");
  if ("status" in status && typeof status.status === "string") {
    if ("error" in status && typeof status.error === "string") {
      return `${status.status}: ${status.error}`;
    }
    return status.status;
  }
  return stringResult(status);
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
 * blocks the upstream renderer can dispatch on; falls back to a
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
    // Wrap in upstream's `<bash-stdout>...</bash-stdout>` /
    // `<bash-stderr>...</bash-stderr>` envelope so the Bash renderer
    // can hand the joined text directly to the upstream
    // `UserBashOutputMessage` component, which extracts these tags via
    // `extractTag(content, "bash-stdout")`. The exit_code / duration_ms
    // metadata block is appended outside the tags so it remains
    // human-readable in fallback paths.
    const blocks: { type: "text"; text: string }[] = [];
    blocks.push({ type: "text", text: `<bash-stdout>${stdout}</bash-stdout>` });
    if (stderr.length > 0) {
      blocks.push({ type: "text", text: `<bash-stderr>${stderr}</bash-stderr>` });
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
  const out: any[] = startupMessages.map((message) => makeUserMessage(message.content));
  const seen = new Set<string>();
  const openTools = new Set<string>();
  const toolNames = new Set<string>();
  const runningToolNames = new Map<string, string>();
  const streamingToolUses: StreamingToolUse[] = [];
  let streamingText = "";
  let realtimeStreamingText = "";
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

  for (const raw of events) {
    const event = unwrap(raw);
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    const payload = payloadRecord(event.payload);

    switch (event.type) {
      case "history_cleared":
        out.length = 0;
        seen.clear();
        seen.add(event.key);
        openTools.clear();
        toolNames.clear();
        runningToolNames.clear();
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
        currentTurnId =
          typeof payload.turnId === "string" ? payload.turnId : currentTurnId;
        // Mirrors upstream REPL.tsx:1609 / :2940 setStreamingToolUses([]) on
        // a new turn boundary — any partially-streamed tool inputs from the
        // previous turn are abandoned because they will never receive a
        // matching completion event in this turn.
        streamingToolUses.length = 0;
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
        if (content.trim().length > 0 && content !== lastAssistantText) {
          out.push(makeAssistantTextMessage(content));
          lastAssistantText = content;
        }
        streamingText = "";
        isStreaming = false;
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
        if (streamingText.trim().length > 0 && streamingText !== lastAssistantText) {
          out.push(makeAssistantTextMessage(streamingText));
          lastAssistantText = streamingText;
        }
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
            makeAssistantThinkingMessage(streamingThinking.thinking, false),
          );
          lastThinkingText = streamingThinking.thinking;
        }
        streamingText = "";
        streamingThinking = null;
        isStreaming = false;
        // Mirrors upstream REPL.tsx:1609 setStreamingToolUses([]) on
        // stream cancellation — any partially-streamed tool inputs are
        // abandoned because their completion events will never arrive
        // for this turn.
        streamingToolUses.length = 0;
        out.push(makeSystemMessage(`Turn aborted: ${stringResult(payload.reason)}`, "warning"));
        break;
      case "user_message":
        out.push(makeUserMessage(payload.displayText ?? payload.message));
        break;
      case "request_user_input":
      case "mcp_elicitation_request":
        out.push(makeSystemMessage(formatElicitationSummary(event.type, payload), "info"));
        break;
      case "assistant_text":
        if (typeof payload.content === "string") {
          streamingText += payload.content;
        }
        break;
      case "agent_message_delta":
        if (typeof payload.delta === "string") {
          streamingText += payload.delta;
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
        out.push(makeAssistantThinkingMessage(text, redacted));
        lastThinkingText = text;
        break;
      }
      case "realtime_started":
        out.push(makeSystemMessage("Realtime voice started", "info"));
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
            out.push(makeUserMessage(payload.text));
          } else if (payload.text !== lastAssistantText) {
            out.push(makeAssistantTextMessage(payload.text));
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
          ),
        );
        realtimeStreamingText = "";
        break;
      case "realtime_closed":
        out.push(makeSystemMessage(formatRealtimeClosed(payload), "info"));
        realtimeStreamingText = "";
        break;
      case "agent_message":
        if (typeof payload.message === "string" && payload.message !== lastAssistantText) {
          out.push(makeAssistantTextMessage(payload.message));
          lastAssistantText = payload.message;
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
            toolCall.id ?? randomUUID(),
            "result" in raw ? raw.result : "",
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
        const toolName =
          typeof payload.toolName === "string"
            ? payload.toolName
            : event.type === "exec_command_begin"
              ? "Bash"
              : "MCP";
        pushToolUse(out, openTools, toolNames, callId, toolName, toolInput(payload));
        runningToolNames.set(callId, toolName);
        break;
      }
      case "tool_input_block_start": {
        // Provider-emitted (R6) when a tool_use content
        // block begins streaming. Mirrors the upstream content_block_start
        // case in messages.ts:3024-3037 that appends a new element to the
        // streamingToolUses array. The upstream Messages.tsx:446 filter
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
        }
        break;
      }
      case "tool_input_delta": {
        // Provider-emitted (R6) for each input_json_delta. Mirrors
        // messages.ts:3062-3079: locate the element with the matching index
        // and append the partial JSON; if no element is found, return the
        // array unchanged (the upstream `if (!element) return _` early
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
        const slot = streamingToolUses.findIndex(
          (entry) => entry.index === indexCandidate,
        );
        if (slot === -1) break;
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
        const isError =
          typeof payload.isError === "boolean"
            ? payload.isError
            : typeof payload.exitCode === "number" && payload.exitCode !== 0;
        const toolName =
          runningToolNames.get(callId) ??
          (event.type === "exec_command_end"
            ? "Bash"
            : event.type === "mcp_tool_call_end"
              ? "MCP"
              : "tool");
        const result = formatStructuredToolResult(toolName, event.type, payload);
        pushToolResult(out, openTools, callId, result, isError);
        runningToolNames.delete(callId);
        // Remove the matching streaming-tool-use element so the upstream
        // <Messages> consumer stops rendering a synthetic streaming cell
        // for a tool that has already settled. Upstream relies on the
        // Messages.tsx:446 filter (drop ids in inProgressToolUseIDs or
        // normalizedToolUseIDs) to do this; we drop here on completion
        // because AgenC moves the call out of openTools at the same step.
        const slot = streamingToolUses.findIndex(
          (entry) => entry.contentBlock.id === callId,
        );
        if (slot !== -1) {
          streamingToolUses.splice(slot, 1);
        }
        break;
      }
      case "context_compacted":
        out.push(makeSystemMessage("Context compacted", "info"));
        break;
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
        out.push(makeSystemMessage(stringResult(payload.message), "warning"));
        break;
      }
      case "error":
      case "stream_error":
        out.push(makeSystemMessage(stringResult(payload.message), "error"));
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
            out.push(makeSystemMessage(text, "info"));
          }
          break;
        }
        if (kind === "error") {
          const msg = candidate.message;
          out.push(
            makeSystemMessage(
              `Error: ${typeof msg === "string" ? msg : stringResult(msg)}`,
              "error",
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
        // Unknown kind — fall back to the original behaviour so we
        // still surface SOMETHING rather than swallowing it silently.
        out.push(makeSystemMessage(stringResult(candidate), "info"));
        break;
      }
      case "collab_agent_spawn_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        pushToolUse(out, openTools, toolNames, callId, "Task", {
          description: payload.newAgentNickname ?? payload.agentRole ?? "agent",
          prompt: payload.prompt,
          subagent_type: payload.agentRole,
          model: payload.model,
        });
        break;
      }
      case "collab_agent_spawn_end":
      case "collab_agent_interaction_end":
      case "collab_waiting_end":
      case "collab_close_end":
      case "collab_resume_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        pushToolResult(out, openTools, callId, formatAgentStatus(payload.status ?? payload.statuses));
        break;
      }
      case "plan_started":
        out.push(makeSystemMessage(`Plan started: ${stringResult(payload.title)}`, "info"));
        break;
      case "plan_item_completed":
        out.push(makeAssistantTextMessage(stringResult(payload.finalText)));
        break;
      case "deprecation_notice":
        out.push(makeSystemMessage(stringResult(payload.reason), "warning"));
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
  };
}

interface TranscriptState {
  readonly events: readonly SessionTranscriptEvent[];
  readonly keys: ReadonlySet<string>;
}

type TranscriptAction =
  | { readonly kind: "reset"; readonly events: readonly SessionTranscriptEvent[] }
  | { readonly kind: "append"; readonly event: SessionTranscriptEvent };

function reducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.kind) {
    case "reset": {
      const keys = new Set<string>();
      const events: SessionTranscriptEvent[] = [];
      for (const event of action.events) {
        const key = eventKey(event);
        if (isTranscriptResetEvent(event)) {
          keys.clear();
          events.length = 0;
          keys.add(key);
          events.push(event);
          continue;
        }
        if (keys.has(key)) continue;
        keys.add(key);
        events.push(event);
      }
      return { events, keys };
    }
    case "append": {
      const key = eventKey(action.event);
      if (isTranscriptResetEvent(action.event)) {
        if (state.keys.has(key)) return state;
        return {
          events: [action.event],
          keys: new Set([key]),
        };
      }
      if (state.keys.has(key)) return state;
      return {
        events: [...state.events, action.event],
        keys: new Set([...state.keys, key]),
      };
    }
  }
}

export function createSessionTranscriptStateForTesting(
  events: readonly SessionTranscriptEvent[],
): TranscriptState {
  return reducer({ events: [], keys: new Set() }, { kind: "reset", events });
}

export function appendSessionTranscriptEventForTesting(
  state: TranscriptState,
  event: SessionTranscriptEvent,
): TranscriptState {
  return reducer(state, { kind: "append", event });
}

function initialEvents(session: AgenCBridgeSession): readonly SessionTranscriptEvent[] {
  const fromGetter = session.getInitialTranscriptEvents?.();
  const fromProperty = session.initialTranscriptEvents;
  return [...((fromGetter ?? fromProperty ?? []) as readonly SessionTranscriptEvent[])];
}

export function useSessionTranscript(
  session: AgenCBridgeSession,
  startupMessages: readonly LLMMessage[] = [],
) {
  const [state, dispatch] = useReducer(reducer, { events: [], keys: new Set() });

  useEffect(() => {
    dispatch({ kind: "reset", events: initialEvents(session) });
  }, [session]);

  useEffect(() => {
    const unsubscribeLog = session.eventLog?.subscribe((event) => {
      dispatch({ kind: "append", event });
    });
    const unsubscribePhase = session.subscribeToEvents?.((event) => {
      if (event && typeof event === "object" && "type" in event) {
        dispatch({ kind: "append", event: event as SessionTranscriptEvent });
      }
    });
    return () => {
      unsubscribeLog?.();
      unsubscribePhase?.();
    };
  }, [session]);

  return useMemo(
    () => adaptTranscriptEvents(state.events, startupMessages),
    [state.events, startupMessages],
  );
}
