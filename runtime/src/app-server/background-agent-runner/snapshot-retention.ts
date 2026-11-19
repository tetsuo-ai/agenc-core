/**
 * Bounded event retention, gap markers, submission caches and usage
 * snapshots for background agents. Split out of background-agent-runner.ts
 * as a pure move.
 */

import type { ManagedThread } from "../../agents/thread-manager.js";
import type { AdmissionToolCharges } from "../../budget/admission-types.js";
import { EVENT_GAP_EVENT } from "../../contracts/run-contracts.js";
import type { CostSidecar } from "../../session/cost.js";

import {
  positiveSequence,
  nonNegativeSequence,
  positiveInteger,
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
  const { usage, ...cost } = agentCostSnapshot(active, live);
  return {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    ...cost,
  };
}

/**
 * What the session's own tool calls were charged, read from the admission
 * ledger: tool fees (web search and fetch, media generation) and the model
 * calls tools make for it (web_fetch's prompt extraction, Grok's native web
 * search, XSearch). The cost sidecar prices only the session's turn
 * `token_count` events, so it never sees them. Undefined without a ledger;
 * null when the ledger could not be read.
 */
function sessionToolCharges(
  session: ActiveBackgroundAgent["bootstrap"]["session"],
): AdmissionToolCharges | undefined | null {
  const admission = session.services.executionAdmission;
  if (admission?.getDirectToolCharges === undefined) return undefined;
  try {
    const charges = admission.getDirectToolCharges();
    return Number.isFinite(charges.costUsd) && charges.costUsd >= 0 ? charges : null;
  } catch {
    return null;
  }
}

/**
 * The session's cost: its model calls (cost sidecar) plus what its own tool
 * calls were charged (sessionToolCharges). Sub-agents run their own
 * accounting and are not included. `costKnown` keeps describing the model
 * part (history coverage and prices) and is also false when the tool charges
 * could not be read. A tool that reports no price (a free local tool, or a
 * configured search endpoint) adds nothing and does not change it.
 *
 * `usage` is the token count the cost covers. The live counter holds only
 * what this process ran, so when the sidecar's restored totals cover a
 * resumed session's history it is the sidecar's whole-session count;
 * otherwise it is the live counter.
 */
function agentCostSnapshot(
  active: ActiveBackgroundAgent,
  live: ManagedTokenUsageShape,
): Pick<AgentTerminalUsage, "costUsd" | "costKnown" | "costEstimated"> & {
  readonly usage: ManagedTokenUsageShape;
} {
  const sidecar = active.bootstrap.session.services.costSidecar;
  if (sidecar === undefined) {
    return { usage: live, costUsd: 0, costKnown: false };
  }
  try {
    const modelCostUsd = sidecar.getTotalCostUsd();
    if (!Number.isFinite(modelCostUsd) || modelCostUsd < 0) {
      return { usage: live, costUsd: 0, costKnown: false };
    }
    const sidecarUsage = sidecar.getSessionTotals();
    const state = active.bootstrap.session.state?.unsafePeek?.();
    const baseline = resumedCostBaseline(state, sidecar);
    // Known only when the sidecar priced exactly the calls this process
    // made on top of the history it restored.
    const coversSessionUsage =
      baseline !== null &&
      sidecarUsage.inputTokens - baseline.inputTokens === live.inputTokens &&
      sidecarUsage.outputTokens - baseline.outputTokens === live.outputTokens &&
      sidecarUsage.totalTokens - baseline.totalTokens === live.totalTokens;
    const tools = sessionToolCharges(active.bootstrap.session);
    return {
      usage: coversSessionUsage ? sidecarUsage : live,
      costUsd: modelCostUsd + (tools?.costUsd ?? 0),
      costKnown: coversSessionUsage && tools !== null,
      ...(sidecar.hasUnknownModelCost() ? { costEstimated: true } : {}),
    };
  } catch {
    // A snapshot must remain available if optional accounting degrades. Do
    // not reprice cumulative mixed-model usage as though it all belonged to
    // the currently selected model; zero plus an explicit unknown marker is
    // safer than a fabricated historical amount.
    return { usage: live, costUsd: 0, costKnown: false };
  }
}

const NO_HISTORY: ManagedTokenUsageShape = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * The usage the cost sidecar carried in from this session's saved totals
 * on resume, when those totals account for every call the resumed rollout
 * recorded. Zero for a session with no recorded history. Null when the
 * history's cost is not covered: nothing was restored, or an earlier run
 * ended before its totals were saved, so they fall short of the rollout.
 */
function resumedCostBaseline(
  state: unknown,
  sidecar: Partial<Pick<CostSidecar, "getRestoredSessionTotals">>,
): ManagedTokenUsageShape | null {
  const resumed = state as {
    readonly initialTokenUsage?: unknown;
    readonly resumedHistoryTokenUsage?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    };
  } | undefined;
  const recorded = resumed?.resumedHistoryTokenUsage;
  if (recorded === undefined) {
    // History seeded by a path that did not total it cannot be checked.
    return resumed?.initialTokenUsage === undefined ? NO_HISTORY : null;
  }
  const restored = sidecar.getRestoredSessionTotals?.() ?? null;
  if (
    restored === null ||
    restored.inputTokens !== recorded.promptTokens ||
    restored.outputTokens !== recorded.completionTokens ||
    restored.totalTokens !== recorded.totalTokens
  ) {
    return null;
  }
  return {
    inputTokens: restored.inputTokens,
    outputTokens: restored.outputTokens,
    totalTokens: restored.totalTokens,
  };
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
