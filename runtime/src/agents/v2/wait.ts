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
  if (supplied !== undefined && supplied <= 0) {
    return json({ error: "timeout_ms must be greater than zero" }, true);
  }
  const configuredMin = sessionOrError.config?.multiAgentV2?.minWaitTimeoutMs;
  const minTimeoutMs = Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(1, configuredMin ?? MIN_WAIT_TIMEOUT_MS),
  );
  return Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(minTimeoutMs, supplied ?? DEFAULT_WAIT_TIMEOUT_MS),
  );
}

export function createWaitAgentTool(opts: MultiAgentV2Options): Tool {
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, { allowed: new Set(["timeout_ms"]) });
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
    const changed =
      typeof sessionOrError.waitForMailboxChange === "function"
        ? await sessionOrError.waitForMailboxChange(timeoutMs)
        : await new Promise<boolean>((resolvePromise) =>
            setTimeout(
              () => resolvePromise(sessionOrError.mailbox.hasPending()),
              timeoutMs,
            ),
          );
    emit(sessionOrError, {
      type: "collab_waiting_end",
      payload: {
        senderThreadId: current.threadId,
        callId: waitCallId,
        statuses: {},
      },
    });
    return json({
      message: changed ? "Wait completed." : "Wait timed out.",
      timed_out: !changed,
    });
  };

  return {
    name: "wait_agent",
    description:
      "Wait for new messages from any agent. Returns when a message is ready or timeout elapses.",
    metadata: toolMetadata("agent", { keywords: ["agent", "wait", "status"] }),
    isReadOnly: true,
    recoveryCategory: "side-effecting",
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
        },
      },
      additionalProperties: false,
    },
    execute,
  };
}
