import type { SessionLike as StatusLineSessionLike } from "./cockpit/StatusLineConfig.js";
import type { TranscriptSourceEvent } from "./state/events-to-messages.js";

export function deriveBannerPhase(
  events: readonly TranscriptSourceEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    switch (event.type) {
      case "assistant_text":
      case "agent_message_delta":
        return "stream_model";
      case "tool_call":
      case "tool_call_started":
      case "tool_progress":
        return "tool";
      case "tool_result":
      case "tool_call_completed":
        return "tool_result";
      case "exec_command_begin":
        return "exec";
      case "exec_command_end":
        return "exec_done";
      case "plan_started":
      case "plan_delta":
      case "plan_item_completed":
      case "plan_exited":
        return "plan";
      case "context_compacted":
        return "compact";
      case "turn_start":
      case "turn_started":
        return "turn";
      case "turn_complete":
        return "complete";
      case "turn_aborted":
        return "aborted";
      case "warning":
        return "warning";
      case "error":
        return "error";
      case "stream_error":
        return "stream_error";
      case "deprecation_notice":
        return "notice";
      case "slash_result":
        return "command";
      case "user_message":
        return "user";
      case "agent_message":
        return "assistant";
      case "session_configured":
        return "ready";
      default:
        break;
    }
  }
  return undefined;
}

export function deriveActiveToolCount(
  events: readonly TranscriptSourceEvent[],
): number {
  const active = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "tool_call":
        active.add(event.toolCall.id);
        break;
      case "tool_result":
        active.delete(event.toolCall.id);
        break;
      case "tool_call_started":
        active.add(event.payload.callId);
        break;
      case "tool_call_completed":
        active.delete(event.payload.callId);
        break;
      case "turn_start":
      case "turn_started":
      case "turn_complete":
      case "turn_aborted":
        active.clear();
        break;
      default:
        break;
    }
  }

  return active.size;
}

function readInitialTokenTotal(session: object): number | undefined {
  const state = (
    session as {
      readonly state?: { unsafePeek?: () => unknown };
    }
  ).state;
  if (typeof state?.unsafePeek !== "function") {
    return undefined;
  }
  try {
    const snapshot = state.unsafePeek() as {
      readonly initialTokenUsage?: { readonly totalTokens?: unknown };
    } | null;
    return typeof snapshot?.initialTokenUsage?.totalTokens === "number"
      ? snapshot.initialTokenUsage.totalTokens
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildStatusLineSession(
  session: object,
  mode: string,
  model: string | undefined,
): StatusLineSessionLike {
  const raw = session as {
    readonly conversationId?: unknown;
    readonly model?: unknown;
  };
  return {
    model:
      model ??
      (typeof raw.model === "string" && raw.model.length > 0
        ? raw.model
        : undefined),
    mode,
    sessionId:
      typeof raw.conversationId === "string" &&
      raw.conversationId.length > 0
        ? raw.conversationId
        : undefined,
    tokensUsed: readInitialTokenTotal(session),
  };
}
