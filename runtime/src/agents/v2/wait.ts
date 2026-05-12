import type { Tool, ToolResult } from "../../tools/types.js";
import type { AgentStatus } from "../status.js";
import { isFinal, toAgentStatusJson } from "../status.js";
import type { AgentPath, ThreadId } from "../registry.js";
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
  resolveAgentId,
  strictArgs,
  stringValue,
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

interface WaitTarget {
  readonly threadId: ThreadId;
  readonly label: string;
}

interface StatusSubscription {
  readonly value: AgentStatus;
  readonly unsubscribe: () => void;
}

function parseTargets(args: Record<string, unknown>): ToolResult | string[] | undefined {
  const raw = args.targets;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    return json({ error: "targets must be an array of strings" }, true);
  }
  const targets = raw.map((target) => stringValue(target));
  if (targets.some((target) => target === undefined)) {
    return json({ error: "targets must be an array of non-empty strings" }, true);
  }
  if (targets.length === 0) {
    return json({ error: "targets must contain at least one agent" }, true);
  }
  return targets as string[];
}

function uniqueTargets(targets: readonly WaitTarget[]): WaitTarget[] {
  const seen = new Set<string>();
  const result: WaitTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.threadId)) continue;
    seen.add(target.threadId);
    result.push(target);
  }
  return result;
}

async function waitForTargets(
  control: {
    subscribeStatus?: (threadId: ThreadId) => Promise<StatusSubscription>;
    getStatus?: (threadId: ThreadId) => Promise<AgentStatus>;
  },
  targets: readonly WaitTarget[],
  timeoutMs: number,
): Promise<{
  readonly timedOut: boolean;
  readonly rawStatuses: Readonly<Record<string, AgentStatus>>;
  readonly statuses: Readonly<Record<string, ReturnType<typeof toAgentStatusJson>>>;
}> {
  const subscriptions: Array<WaitTarget & { readonly subscription: StatusSubscription }> = [];
  try {
    for (const target of targets) {
      const subscription =
        typeof control.subscribeStatus === "function"
          ? await control.subscribeStatus(target.threadId)
          : {
              value:
                typeof control.getStatus === "function"
                  ? await control.getStatus(target.threadId)
                  : ({ status: "not_found" } as const),
              unsubscribe: () => {},
            };
      subscriptions.push({ ...target, subscription });
    }

    const snapshot = (): Record<string, ReturnType<typeof toAgentStatusJson>> =>
      Object.fromEntries(
        subscriptions.map(({ label, subscription }) => [
          label,
          toAgentStatusJson(subscription.value),
        ]),
      );
    const rawSnapshot = (): Record<string, AgentStatus> =>
      Object.fromEntries(
        subscriptions.map(({ label, subscription }) => [
          label,
          subscription.value,
        ]),
      );

    const allFinal = (): boolean =>
      subscriptions.every(({ subscription }) => isFinal(subscription.value));

    if (allFinal()) {
      return {
        timedOut: false,
        rawStatuses: rawSnapshot(),
        statuses: snapshot(),
      };
    }

    const timedOut = await new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const interval = setInterval(() => {
        if (allFinal()) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(false);
        }
      }, 100);
      timeout = setTimeout(() => {
        clearInterval(interval);
        resolve(true);
      }, timeoutMs);
      interval.unref?.();
      timeout.unref?.();
    });

    return { timedOut, rawStatuses: rawSnapshot(), statuses: snapshot() };
  } finally {
    for (const { subscription } of subscriptions) {
      subscription.unsubscribe();
    }
  }
}

export function createWaitAgentTool(opts: MultiAgentV2Options): Tool {
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["timeout_ms", "targets"]),
    });
    if (strict) return strict;
    if (
      args.timeout_ms !== undefined &&
      (typeof args.timeout_ms !== "number" || !Number.isFinite(args.timeout_ms))
    ) {
      return json({ error: "timeout_ms must be a number" }, true);
    }
    const parsedTargets = parseTargets(args);
    if (parsedTargets !== undefined && !Array.isArray(parsedTargets)) {
      return parsedTargets;
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const timeoutMs = waitTimeoutMs(args, opts);
    if (typeof timeoutMs !== "number") return timeoutMs;
    const current = currentAgentContext(sessionOrError, args, opts);
    const { control } = opts.ensureAgentControl(sessionOrError);
    let targets: WaitTarget[];
    if (parsedTargets !== undefined) {
      try {
        targets = uniqueTargets(
          parsedTargets.map((target) => ({
            threadId: resolveAgentId(
              sessionOrError,
              target,
              current.agentPath,
              opts,
            ),
            label: target,
          })),
        );
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    } else {
      const listed = control.listAgents({
        pathPrefix: current.agentPath as AgentPath,
      }).filter((agent) => agent.agentName !== current.agentPath);
      const active = listed.filter((agent) => !isFinal(agent.agentStatus));
      const selected = active.length > 0 ? active : listed;
      try {
        targets = uniqueTargets(
          selected.map((agent) => ({
            threadId: resolveAgentId(
              sessionOrError,
              agent.agentName,
              current.agentPath,
              opts,
            ),
            label: agent.agentName,
          })),
        );
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    }
    const waitCallId = callIdFromArgs(args, "wait");
    emit(sessionOrError, {
      type: "collab_waiting_begin",
      payload: {
        senderThreadId: current.threadId,
        receiverThreadIds: targets.map((target) => target.threadId),
        receiverAgents: targets.map((target) => ({ threadId: target.threadId })),
        callId: waitCallId,
      },
    });
    let waitResult: Awaited<ReturnType<typeof waitForTargets>>;
    try {
      waitResult =
        targets.length > 0
          ? await waitForTargets(control, targets, timeoutMs)
          : { timedOut: false, rawStatuses: {}, statuses: {} };
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
    emit(sessionOrError, {
      type: "collab_waiting_end",
      payload: {
        senderThreadId: current.threadId,
        callId: waitCallId,
        statuses: waitResult.rawStatuses,
        agentStatuses: targets.map((target) => ({
          threadId: target.threadId,
          status:
            waitResult.rawStatuses[target.label] ??
            ({ status: "not_found" } as const),
        })),
      },
    });
    return json({
      message:
        targets.length === 0
          ? "No agents to wait for."
          : waitResult.timedOut
            ? "Wait timed out."
            : "Wait completed.",
      timed_out: waitResult.timedOut,
      statuses: waitResult.statuses,
    });
  };

  return {
    name: "wait_agent",
    description:
      "Wait for spawned agents to reach a terminal status. When targets is omitted, waits for all currently active descendants of the current agent.",
    metadata: toolMetadata("agent", { keywords: ["agent", "wait", "status"] }),
    isReadOnly: true,
    recoveryCategory: "side-effecting",
    timeoutBehavior: "tool",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of agent names or paths to wait for. Defaults to active descendants of the current agent.",
        },
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
