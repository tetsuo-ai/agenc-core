import type { Tool, ToolResult } from "../../tools/types.js";
import {
  callIdFromArgs,
  currentAgentContext,
  DEFAULT_WAIT_TIMEOUT_MS,
  emit,
  getSessionOrError,
  isCurrentAgentContextError,
  json,
  localZeroAdmissionEstimate,
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
  const { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs } =
    effectiveWaitTimeoutOptions(sessionOrError);
  if (supplied !== undefined && supplied < minTimeoutMs) {
    return json({ error: `timeout_ms must be at least ${minTimeoutMs}` }, true);
  }
  if (supplied !== undefined && supplied > maxTimeoutMs) {
    return json({ error: `timeout_ms must be at most ${maxTimeoutMs}` }, true);
  }
  return supplied ?? defaultTimeoutMs;
}

function configuredTimeoutOption(value: unknown, fallback: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return fallback;
  }
  return value;
}

function effectiveWaitTimeoutOptions(session: {
  readonly config?: {
    readonly multiAgentV2?: {
      readonly minWaitTimeoutMs?: number;
      readonly defaultWaitTimeoutMs?: number;
      readonly maxWaitTimeoutMs?: number;
    };
  };
}): {
  readonly defaultTimeoutMs: number;
  readonly minTimeoutMs: number;
  readonly maxTimeoutMs: number;
} {
  const cfg = session.config?.multiAgentV2;
  const minTimeoutMs = configuredTimeoutOption(
    cfg?.minWaitTimeoutMs,
    MIN_WAIT_TIMEOUT_MS,
  );
  const defaultTimeoutMs = configuredTimeoutOption(
    cfg?.defaultWaitTimeoutMs,
    DEFAULT_WAIT_TIMEOUT_MS,
  );
  const maxTimeoutMs = configuredTimeoutOption(
    cfg?.maxWaitTimeoutMs,
    MAX_WAIT_TIMEOUT_MS,
  );
  return { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs };
}

type WaitMailboxUpdate = {
  readonly role: string;
  readonly content: string;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { readonly text?: unknown }).text === "string"
        ) {
          return (part as { readonly text: string }).text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function drainMailboxUpdates(session: unknown): readonly WaitMailboxUpdate[] {
  const drain = (session as {
    readonly drainPendingInputMessages?: () => readonly {
      readonly role?: unknown;
      readonly content?: unknown;
    }[];
  }).drainPendingInputMessages;
  if (typeof drain !== "function") return [];
  return drain.call(session)
    .map((message): WaitMailboxUpdate | null => {
      const role = typeof message.role === "string" && message.role.length > 0
        ? message.role
        : "user";
      const content = contentToText(message.content);
      if (content.length === 0) return null;
      return { role, content };
    })
    .filter((message): message is WaitMailboxUpdate => message !== null);
}

export function createWaitAgentTool(opts: MultiAgentV2Options): Tool {
  const session = opts.getSession();
  const { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs } = session
    ? effectiveWaitTimeoutOptions(session)
    : {
        defaultTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
        minTimeoutMs: MIN_WAIT_TIMEOUT_MS,
        maxTimeoutMs: MAX_WAIT_TIMEOUT_MS,
      };
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
    if (
      typeof args.timeout_ms === "number" &&
      !Number.isInteger(args.timeout_ms)
    ) {
      return json({ error: "timeout_ms must be an integer" }, true);
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const timeoutMs = waitTimeoutMs(args, opts);
    if (typeof timeoutMs !== "number") return timeoutMs;
    const current = currentAgentContext(sessionOrError, args, opts);
    if (isCurrentAgentContextError(current)) return current;
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
    const updates = timedOut ? [] : drainMailboxUpdates(sessionOrError);
    emit(sessionOrError, {
      type: "collab_waiting_end",
      payload: {
        senderThreadId: current.threadId,
        callId: waitCallId,
        statuses: {},
        timedOut,
        agentStatuses: [],
        ...(updates.length > 0 ? { mailboxUpdates: updates } : {}),
      },
    });
    return json({
      message: timedOut ? "Wait timed out." : "Wait completed.",
      timed_out: timedOut,
      ...(updates.length > 0 ? { updates } : {}),
    });
  };

  return {
    name: "wait_agent",
    description:
      "Wait for a mailbox update from any live agent, including queued messages " +
      "and final-status notifications. When updates arrive, returns the drained " +
      "mailbox content so you can report completed agent findings immediately. " +
      "If no mailbox update arrives before the deadline, returns a timeout summary.",
    metadata: toolMetadata("agent", {
      mutating: true,
      keywords: ["agent", "wait", "status"],
    }),
    // Waiting drains delivered mailbox receipts into this turn.
    isReadOnly: false,
    recoveryCategory: "side-effecting",
    admissionEstimate: localZeroAdmissionEstimate,
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description:
            `Optional timeout in milliseconds. Defaults to ${defaultTimeoutMs}, ` +
            `min ${minTimeoutMs}, max ${maxTimeoutMs}.`,
        },
      },
      additionalProperties: false,
    },
    execute,
  };
}
