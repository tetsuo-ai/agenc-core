/**
 * Bounded event retention, gap markers, submission caches and usage
 * snapshots for background agents. Split out of background-agent-runner.ts
 * as a pure move.
 */

import type { ManagedThread } from "../../agents/thread-manager.js";
import {
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../session/cost.js";
import { EVENT_GAP_EVENT } from "../../contracts/run-contracts.js";

import {
  positiveSequence,
  nonNegativeSequence,
  positiveInteger,
  stringRecordField,
  finiteNumber,
} from "./shared.js";
import type {
  ActiveBackgroundAgent,
  ActiveMessageSubmission,
  ActiveShellExecution,
  BackgroundAgentDaemonEvent,
  AgentTerminalUsage,
} from "./shared.js";

/**
 * Upper bound on daemon events buffered for a single agent while no
 * session binding is attached (and on the per-agent `#pendingEvents`
 * detach buffer). A detached or pre-attach agent that never gets an
 * `agent.attach` would otherwise accumulate events on the heap without
 * limit. When the cap is exceeded the oldest events are dropped (FIFO
 * eviction) so the newest events — the ones most useful when the TUI
 * finally attaches — are retained. Mirrors
 * MAX_RETAINED_NOTIFICATIONS (tasks/lifecycle.ts) and the
 * per-session caps in agent-cli.ts / client-multiplexer.ts.
 */
const MAX_BUFFERED_AGENT_EVENTS = 1_000;

const BACKGROUND_RUNNER_GAP_SOURCE = "background_runner_retention";

/**
 * Drops the oldest events in-place until `events` is within
 * {@link MAX_BUFFERED_AGENT_EVENTS}. Returns the same array so callers
 * can push then bound, matching `bufferSessionEvent` in
 * client-multiplexer.ts.
 */
function boundBufferedAgentEvents(
  events: BackgroundAgentDaemonEvent[],
  runId?: string,
): BackgroundAgentDaemonEvent[] {
  const previousMarkers = events.filter(isBackgroundRunnerGapEvent);
  const realEvents = events.filter(
    (event) => !isBackgroundRunnerGapEvent(event),
  );
  const retired =
    realEvents.length > MAX_BUFFERED_AGENT_EVENTS
      ? realEvents.splice(0, realEvents.length - MAX_BUFFERED_AGENT_EVENTS)
      : [];
  const previousRetiredCount = previousMarkers.reduce(
    (total, marker) => total + positiveInteger(marker.payload?.retiredCount),
    0,
  );
  const retiredCount = previousRetiredCount + retired.length;
  if (retiredCount === 0) {
    events.splice(0, events.length, ...realEvents);
    return events;
  }

  const priorAfterSequence = previousMarkers
    .map((marker) => nonNegativeSequence(marker.payload?.afterSequence))
    .find((value) => value !== undefined);
  const previousCoordinatesUnknown = previousMarkers.some(
    (marker) => marker.payload?.coordinatesAvailable === false,
  );
  const retiredSequences = retired.map((event) =>
    positiveSequence(event.sequence),
  );
  const firstRetiredSequence = retiredSequences[0];
  const allNewRetiredEventsSequenced = retiredSequences.every(
    (value) => value !== undefined,
  );
  const afterSequence =
    !previousCoordinatesUnknown && priorAfterSequence !== undefined
      ? priorAfterSequence
      : !previousCoordinatesUnknown &&
          retired.length > 0 &&
          allNewRetiredEventsSequenced &&
          firstRetiredSequence !== undefined
        ? firstRetiredSequence - 1
        : undefined;
  const firstAvailableSequence = positiveSequence(realEvents[0]?.sequence);
  const coordinatesAvailable =
    afterSequence !== undefined &&
    afterSequence >= 0 &&
    firstAvailableSequence !== undefined &&
    firstAvailableSequence > afterSequence;
  const resolvedRunId = runId ?? gapRunId(previousMarkers);
  const marker: BackgroundAgentDaemonEvent = {
    id: `runner-gap:${resolvedRunId ?? "unknown"}`,
    type: EVENT_GAP_EVENT,
    payload: {
      kind: EVENT_GAP_EVENT,
      reason: "retention",
      source: BACKGROUND_RUNNER_GAP_SOURCE,
      retiredCount,
      coordinatesAvailable,
      ...(resolvedRunId !== undefined ? { runId: resolvedRunId } : {}),
      ...(coordinatesAvailable
        ? { afterSequence, firstAvailableSequence }
        : {}),
    },
  };
  events.splice(0, events.length, marker, ...realEvents);
  return events;
}

function isBackgroundRunnerGapEvent(
  event: BackgroundAgentDaemonEvent,
): boolean {
  return (
    event.type === EVENT_GAP_EVENT &&
    event.payload?.source === BACKGROUND_RUNNER_GAP_SOURCE
  );
}

function gapRunId(
  markers: readonly BackgroundAgentDaemonEvent[],
): string | undefined {
  return markers
    .map((marker) => marker.payload?.runId)
    .find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
}

function terminalUsageForActiveAgent(
  active: ActiveBackgroundAgent,
): AgentTerminalUsage {
  const live = managedTokenUsage(active.thread);
  return {
    inputTokens: finiteNumber(live.inputTokens),
    outputTokens: finiteNumber(live.outputTokens),
    totalTokens: finiteNumber(live.totalTokens),
    costUsd: agentCostUsd(active),
  };
}

function agentCostUsd(active: ActiveBackgroundAgent): number {
  const tokenUsage = managedTokenUsage(active.thread);
  const model = activeAgentModel(active);
  const provider = activeAgentProvider(active);
  // LiveAgent currently exposes aggregate input/output token counters.
  // Preserve that limited basis in the terminal usage snapshot without
  // pretending cached/reasoning/search dimensions were observed.
  const usage: ModelUsage = {
    model,
    ...(provider !== undefined ? { provider } : {}),
    inputTokens: finiteNumber(tokenUsage.inputTokens),
    outputTokens: finiteNumber(tokenUsage.outputTokens),
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: finiteNumber(tokenUsage.totalTokens),
    turns: 0,
  };
  return computeUsdCost(usage, DEFAULT_MODEL_COSTS);
}

function activeAgentModel(active: ActiveBackgroundAgent): string {
  return (
    stringRecordField(active.thread.configSnapshot?.(), "model") ?? "agenc"
  );
}

function activeAgentProvider(
  active: ActiveBackgroundAgent,
): string | undefined {
  return (
    stringRecordField(active.thread.configSnapshot?.(), "provider") ??
    stringRecordField(active.thread.configSnapshot?.(), "model_provider")
  );
}

const MAX_RETAINED_SHELL_EXECUTIONS = 256;

function pruneShellExecutionCache(
  cache: Map<string, ActiveShellExecution>,
): void {
  if (cache.size <= MAX_RETAINED_SHELL_EXECUTIONS) return;
  for (const [commandId, execution] of cache) {
    if (!execution.settled) continue;
    cache.delete(commandId);
    if (cache.size <= MAX_RETAINED_SHELL_EXECUTIONS) return;
  }
}

const MAX_MESSAGE_SUBMISSION_CACHE = 1_024;

function pruneMessageSubmissionCache(
  submissions: Map<string, ActiveMessageSubmission>,
): void {
  if (submissions.size <= MAX_MESSAGE_SUBMISSION_CACHE) return;
  for (const [clientMessageId, submission] of submissions) {
    if (!submission.settled) continue;
    submissions.delete(clientMessageId);
    if (submissions.size <= MAX_MESSAGE_SUBMISSION_CACHE) return;
  }
}

interface ManagedTokenUsageShape {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export function managedTokenUsage(
  thread: Pick<ManagedThread, "totalTokenUsage">,
): ManagedTokenUsageShape {
  const usage = thread.totalTokenUsage?.();
  if (typeof usage !== "object" || usage === null) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const u = usage as Record<string, unknown>;
  // Two shapes reach this seam: run-agent's live counter uses
  // inputTokens/outputTokens, while a daemon session's cross-turn
  // accumulator (stream-model.ts, the TokenUsageInfo port) uses
  // promptTokens/completionTokens. Reading only the former zeroed
  // input/output in every session.snapshot (totalTokens matched both
  // shapes, which is why the bug shipped as {0, 0, N}).
  const field = (...names: readonly string[]): number => {
    for (const name of names) {
      const value = u[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const inputTokens = field("inputTokens", "promptTokens");
  const outputTokens = field("outputTokens", "completionTokens");
  const totalTokens = field("totalTokens");
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
  };
}

export {
  BACKGROUND_RUNNER_GAP_SOURCE,
  boundBufferedAgentEvents,
  terminalUsageForActiveAgent,
  pruneShellExecutionCache,
  pruneMessageSubmissionCache,
};
