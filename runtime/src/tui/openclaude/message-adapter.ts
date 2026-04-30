import { randomUUID } from "node:crypto";

import type { LLMMessage } from "../../llm/types.js";
import type { Event } from "../../session/event-log.js";

/**
 * Hardcoded copy of `FILE_EDIT_TOOL_NAME` from
 * `runtime/src/tools/system/file-edit.ts`. Kept in sync by hand
 * because importing the live constant pulls `tools/system/file-edit.ts`
 * → `tools/result-metadata.ts` → the `diff` npm package into this
 * module's resolution chain, which breaks transcript-bridge tests
 * that should not depend on the diff library. If the live constant
 * ever changes, update this value in lockstep.
 */
const FILE_EDIT_TOOL_NAME = "Edit";

type BridgeEvent =
  | Event
  | { readonly type: string; readonly payload?: unknown; readonly [key: string]: unknown };

export interface RunningToolProgress {
  readonly toolName: string;
  readonly latestChunk: string;
  readonly chunkCount: number;
  readonly stream: "stdout" | "stderr" | "status" | undefined;
}

export interface AdaptedTranscript {
  readonly messages: readonly any[];
  readonly streamingText: string | null;
  readonly inProgressToolUseIDs: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly currentTurnId: string | null;
  /**
   * Per-call accumulated `tool_progress` chunks for tools that are
   * currently mid-execution. Populated by `tool_progress` events,
   * cleared when the matching `tool_call_completed` /
   * `exec_command_end` / `mcp_tool_call_end` arrives. Surfaced so the
   * TUI composer can show a live "tool running" indicator.
   */
  readonly runningToolProgress: ReadonlyMap<string, RunningToolProgress>;
}

const SYNTHETIC_MODEL = "agenc";

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

function eventKey(event: BridgeEvent): string {
  if ("seq" in event && typeof event.seq === "number") return `seq:${event.seq}`;
  if ("id" in event && typeof event.id === "string") return `id:${event.id}`;
  try {
    return JSON.stringify(event);
  } catch {
    return `${event.type}:${Math.random()}`;
  }
}

function unwrap(event: BridgeEvent): {
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

/**
 * Tool-result content formatter. Replaces the previous fallback of
 * always running everything through `stringResult` so that callers
 * who want structured rendering (Bash stdout/stderr, FileEdit diffs)
 * can preserve shape. Returns an array of Anthropic-style content
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
    // `<bash-stderr>...</bash-stderr>` envelope so the bridge Bash tool
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
      // so the bridge tool's `EditDiffView` can pull file path and diff
      // body out of the joined content via `extractBridgeTag`. Keeps
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
      return blocks;
    }
  }

  return [{ type: "text", text: stringResult(result) }];
}

/**
 * Tool-error content formatter. Wraps an error message and an
 * optional tool name in a `<tool-error>` envelope so the bridge's
 * cross-cutting error renderer can dispatch on it regardless of
 * which tool emitted the error. The bridge's `pickToolResultDispatch`
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
  events: readonly BridgeEvent[],
  startupMessages: readonly LLMMessage[] = [],
): AdaptedTranscript {
  const out: any[] = startupMessages.map((message) => makeUserMessage(message.content));
  const seen = new Set<string>();
  const openTools = new Set<string>();
  const toolNames = new Set<string>();
  const runningToolNames = new Map<string, string>();
  const runningToolProgress = new Map<string, RunningToolProgress>();
  let streamingText = "";
  let currentTurnId: string | null = null;
  let lastAssistantText = "";
  let isStreaming = false;

  for (const raw of events) {
    const event = unwrap(raw);
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    const payload = payloadRecord(event.payload);

    switch (event.type) {
      case "turn_start":
      case "turn_started":
        isStreaming = true;
        streamingText = "";
        currentTurnId =
          typeof payload.turnId === "string" ? payload.turnId : currentTurnId;
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
        streamingText = "";
        isStreaming = false;
        out.push(makeSystemMessage(`Turn aborted: ${stringResult(payload.reason)}`, "warning"));
        break;
      case "user_message":
        out.push(makeUserMessage(payload.displayText ?? payload.message));
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
          typeof payload.callId === "string" ? payload.callId : randomUUID();
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
      case "tool_progress": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : null;
        if (callId === null) break;
        const toolName =
          typeof payload.toolName === "string"
            ? payload.toolName
            : (runningToolNames.get(callId) ?? "tool");
        const chunk =
          typeof payload.chunk === "string"
            ? payload.chunk
            : stringResult(payload.chunk);
        const stream =
          payload.stream === "stdout" ||
          payload.stream === "stderr" ||
          payload.stream === "status"
            ? payload.stream
            : undefined;
        const previous = runningToolProgress.get(callId);
        runningToolProgress.set(callId, {
          toolName,
          latestChunk: chunk,
          chunkCount: (previous?.chunkCount ?? 0) + 1,
          stream,
        });
        break;
      }
      case "tool_call_completed":
      case "mcp_tool_call_end":
      case "exec_command_end": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : randomUUID();
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
        runningToolProgress.delete(callId);
        break;
      }
      case "context_compacted":
        out.push(makeSystemMessage("Context compacted", "info"));
        break;
      case "warning":
        out.push(makeSystemMessage(stringResult(payload.message), "warning"));
        break;
      case "error":
      case "stream_error":
        out.push(makeSystemMessage(stringResult(payload.message), "error"));
        break;
      case "slash_result":
        out.push(
          makeSystemMessage(
            "result" in raw ? stringResult(raw.result) : stringResult(payload),
            "info",
          ),
        );
        break;
      case "collab_agent_spawn_begin": {
        const callId =
          typeof payload.callId === "string" ? payload.callId : randomUUID();
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
          typeof payload.callId === "string" ? payload.callId : randomUUID();
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
    streamingText: streamingText.length > 0 ? streamingText : null,
    inProgressToolUseIDs: openTools,
    toolNames,
    isStreaming,
    currentTurnId,
    runningToolProgress,
  };
}
