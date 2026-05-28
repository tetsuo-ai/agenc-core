import type { Tool, ToolResult } from "../../tools/types.js";
import {
  callIdFromArgs,
  currentAgentContext,
  DEFAULT_WAIT_TIMEOUT_MS,
  emit,
  getSessionOrError,
  json,
  MAX_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  numberValue,
  strictArgs,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";

function waitTimeoutMs(
  args: Record<string, unknown>,
  opts: MultiAgentV2Options,
): ToolResult | number {
  const sessionOrError = getSessionOrError(opts);
  if (!("conversationId" in sessionOrError)) return sessionOrError;
  const supplied = numberValue(args.timeout_ms);
  const configuredMin = sessionOrError.config?.multiAgentV2?.minWaitTimeoutMs;
  const minTimeoutMs = Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(1, configuredMin ?? MIN_WAIT_TIMEOUT_MS),
  );
  const maxTimeoutMs = MAX_WAIT_TIMEOUT_MS;
  if (supplied !== undefined && supplied < minTimeoutMs) {
    return json({ error: `timeout_ms must be at least ${minTimeoutMs}` }, true);
  }
  if (supplied !== undefined && supplied > maxTimeoutMs) {
    return json({ error: `timeout_ms must be at most ${maxTimeoutMs}` }, true);
  }
  return supplied ?? DEFAULT_WAIT_TIMEOUT_MS;
}

export function createWaitAgentTool(opts: MultiAgentV2Options): Tool {
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["timeout_ms"]),
    });
    if (strict) return strict;
    if (
      args.timeout_ms !== undefined &&
      (typeof args.timeout_ms !== "number" || !Number.isFinite(args.timeout_ms))
    ) {
      return json({ error: "timeout_ms must be a number" }, true);
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const timeoutMs = waitTimeoutMs(args, opts);
    if (typeof timeoutMs !== "number") return timeoutMs;
    const current = currentAgentContext(sessionOrError, args, opts);
    const waitCallId = callIdFromArgs(args, "wait");
    emit(sessionOrError, {
      type: "collab_waiting_begin",
      payload: {
        senderThreadId: current.threadId,
        receiverThreadIds: [],
        receiverAgents: [],
        callId: waitCallId,
      },
    });
    let mailboxChanged = false;
    try {
      mailboxChanged = await sessionOrError.waitForMailboxChange(timeoutMs);
    } catch (error) {
      emit(sessionOrError, {
        type: "collab_waiting_end",
        payload: {
          senderThreadId: current.threadId,
          callId: waitCallId,
          statuses: {},
          agentStatuses: [],
        },
      });
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    const timedOut = !mailboxChanged;
    emit(sessionOrError, {
      type: "collab_waiting_end",
      payload: {
        senderThreadId: current.threadId,
        callId: waitCallId,
        statuses: {},
        timedOut,
        agentStatuses: [],
      },
    });
    return json({
      message: timedOut ? "Wait timed out." : "Wait completed.",
      timed_out: timedOut,
    });
  };

  return {
    name: "wait_agent",
    description:
      "Wait for a mailbox update from any live agent, including queued messages " +
      "and final-status notifications. Does not return the content; returns either " +
      "a summary of which agents have updates (if any), " +
      "or a timeout summary if no mailbox update arrives before the deadline.",
    metadata: toolMetadata("agent", { keywords: ["agent", "wait", "status"] }),
    isReadOnly: true,
    recoveryCategory: "side-effecting",
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description:
            `Optional timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, ` +
            `min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
        },
      },
      additionalProperties: false,
    },
    execute,
  };
}
