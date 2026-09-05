import type { Tool, ToolResult } from "../../tools/types.js";
import type { Session } from "../../session/session.js";
import {
  callIdFromArgs,
  currentAgentContext,
  DEFAULT_MAX_CONSECUTIVE_WAIT_TIMEOUTS,
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
  toListedAgentJson,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";

/**
 * Consecutive timed-out waits with no mailbox update in between, per
 * session. A wait that completes clears it. Kept off the session object so
 * the tool needs nothing new from the runtime; the WeakMap dies with the
 * session.
 */
interface WaitTimeoutStreak {
  consecutive: number;
  waitedMs: number;
}
const waitTimeoutStreaks = new WeakMap<object, WaitTimeoutStreak>();

function maxConsecutiveWaitTimeouts(session: {
  readonly config?: {
    readonly multiAgentV2?: { readonly maxConsecutiveWaitTimeouts?: number };
  };
}): number {
  const configured = configuredTimeoutOption(
    session.config?.multiAgentV2?.maxConsecutiveWaitTimeouts,
    DEFAULT_MAX_CONSECUTIVE_WAIT_TIMEOUTS,
  );
  return Math.max(1, configured);
}

function liveAgentsForDecision(
  session: Session,
  opts: MultiAgentV2Options,
): ReturnType<typeof toListedAgentJson>[] {
  try {
    const { control } = opts.ensureAgentControl(session);
    control.registerSessionRoot(session.conversationId);
    return control
      .listAgents()
      .filter((agent) => agent.agentName !== "/root")
      .map(toListedAgentJson);
  } catch {
    return [];
  }
}

function waitTimeoutMs(
  args: Record<string, unknown>,
  opts: MultiAgentV2Options,
): ToolResult | number {
  const sessionOrError = getSessionOrError(opts);
  if (!("conversationId" in sessionOrError)) return sessionOrError;
  const supplied = numberValue(args.timeout_ms);
  const { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs } =
    effectiveWaitTimeoutOptions(sessionOrError);
  if (supplied === undefined) return defaultTimeoutMs;
  // Clamp instead of erroring: an out-of-range value used to cost a full
  // model round trip just to learn the bound. The schema also declares
  // minimum/maximum so the model sees the range up front.
  return Math.min(maxTimeoutMs, Math.max(minTimeoutMs, supplied));
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
    if (!timedOut) {
      waitTimeoutStreaks.delete(sessionOrError);
      return json({
        message: "Wait completed.",
        timed_out: false,
        ...(updates.length > 0 ? { updates } : {}),
      });
    }
    const streak = waitTimeoutStreaks.get(sessionOrError) ?? {
      consecutive: 0,
      waitedMs: 0,
    };
    streak.consecutive += 1;
    streak.waitedMs += timeoutMs;
    waitTimeoutStreaks.set(sessionOrError, streak);
    const limit = maxConsecutiveWaitTimeouts(sessionOrError);
    if (streak.consecutive < limit) {
      return json({
        message: "Wait timed out.",
        timed_out: true,
        consecutive_timeouts: streak.consecutive,
        waited_ms: streak.waitedMs,
      });
    }
    // Polling on is the one thing that cannot help: nothing arrived in
    // `limit` waits. Fail the call so the model decides, and hand it the
    // agents' status so it does not need another list_agents to do so.
    const waitedSeconds = Math.round(streak.waitedMs / 1000);
    return json(
      {
        error:
          `wait_agent has timed out ${streak.consecutive} times in a row ` +
          `(${waitedSeconds} s) with no mailbox update. Do not call it again ` +
          `the same way. Decide: wait once more with a deadline you can afford ` +
          `(timeout_ms up to ${maxTimeoutMs}), close the agent with close_agent, ` +
          `or continue the task without its result and say so.`,
        timed_out: true,
        consecutive_timeouts: streak.consecutive,
        waited_ms: streak.waitedMs,
        agents: liveAgentsForDecision(sessionOrError, opts),
      },
      true,
    );
  };

  return {
    name: "wait_agent",
    description:
      "Wait for a mailbox update from any live agent, including queued messages " +
      "and final-status notifications. When updates arrive, returns the drained " +
      "mailbox content so you can report completed agent findings immediately. " +
      "If no mailbox update arrives before the deadline, returns a timeout summary. " +
      "After several consecutive timeouts with no update the call fails and asks " +
      "you to decide (wait with a longer deadline, close the agent, or continue without it).",
    metadata: toolMetadata("agent", {
      mutating: true,
      virtualNoFsWrites: true,
      keywords: ["agent", "wait", "status"],
    }),
    // Draining already-durable local receipts mutates mailbox state, but the
    // state transition is idempotent: replay after a completed drain is a
    // no-op, while replay before a drain consumes the same durable records.
    isReadOnly: false,
    recoveryCategory: "idempotent",
    cancellationUsage: "zero",
    admissionEstimate: localZeroAdmissionEstimate,
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          minimum: minTimeoutMs,
          maximum: maxTimeoutMs,
          description:
            `Optional timeout in milliseconds. Defaults to ${defaultTimeoutMs}, ` +
            `min ${minTimeoutMs}, max ${maxTimeoutMs}; values outside the range are clamped.`,
        },
      },
      additionalProperties: false,
    },
    execute,
  };
}
