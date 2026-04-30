import { randomUUID } from "node:crypto";

import type { LLMMessage } from "../../llm/types.js";
import type { Event } from "../../session/event-log.js";

type BridgeEvent =
  | Event
  | { readonly type: string; readonly payload?: unknown; readonly [key: string]: unknown };

export interface AdaptedTranscript {
  readonly messages: readonly any[];
  readonly streamingText: string | null;
  readonly inProgressToolUseIDs: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly currentTurnId: string | null;
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
  const text = stringResult(content);
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseID,
          content: text,
          is_error: isError,
        },
      ],
    },
    isMeta: true,
    uuid: randomUUID(),
    timestamp: timestamp(),
    toolUseResult: text,
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

export function adaptTranscriptEvents(
  events: readonly BridgeEvent[],
  startupMessages: readonly LLMMessage[] = [],
): AdaptedTranscript {
  const out: any[] = startupMessages.map((message) => makeUserMessage(message.content));
  const seen = new Set<string>();
  const openTools = new Set<string>();
  const toolNames = new Set<string>();
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
        const result =
          event.type === "exec_command_end"
            ? [
                typeof payload.stdout === "string" ? payload.stdout : "",
                typeof payload.stderr === "string" ? payload.stderr : "",
              ]
                .filter(Boolean)
                .join("\n")
            : payload.result;
        pushToolResult(out, openTools, callId, result, isError);
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
  };
}
