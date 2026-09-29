import type { ExecutionAdmissionClient } from "../budget/admission-client.js";
import type { AdmissionUsageTotals } from "../budget/admission-types.js";
import type { Session } from "../session/session.js";
import type { ChildRoutingAttemptResult } from "./child-routing-fallback.js";
import { liveAgentSession } from "./live-session.js";
import type { AgentStatus } from "./status.js";
import type { AgentThread } from "./thread.js";

const JOURNAL_PAGE_SIZE = 256;
const MAX_JOURNAL_EVENTS = 16_384;

function dispatchedModelCalls(client: ExecutionAdmissionClient, runId: string): {
  readonly modelCalls: number;
  readonly allDispatchedVoided: boolean;
} {
  if (client.replayJournal === undefined) {
    throw new Error("Child routing cannot verify dispatched model calls.");
  }
  const dispatched = new Set<string>();
  const voided = new Set<string>();
  let afterSequence = 0;
  for (let scanned = 0; scanned < MAX_JOURNAL_EVENTS; scanned += JOURNAL_PAGE_SIZE) {
    const events = client.replayJournal({ afterSequence, limit: JOURNAL_PAGE_SIZE });
    for (const event of events) {
      if (event.runId !== runId || event.sequence <= afterSequence) {
        throw new Error("Child routing received an invalid admission journal.");
      }
      afterSequence = event.sequence;
      if (event.kind === "model_turn" && event.event === "dispatched") {
        dispatched.add(event.reservationId ?? event.stepId);
      }
      if (event.kind === "model_turn" && event.event === "voided") {
        voided.add(event.reservationId ?? event.stepId);
      }
    }
    if (events.length < JOURNAL_PAGE_SIZE) {
      return { modelCalls: dispatched.size,
        allDispatchedVoided: [...dispatched].every((id) => voided.has(id)) };
    }
  }
  throw new Error("Child routing admission journal exceeds its observation limit.");
}

/**
 * Observe the first task of a freshly spawned child, including keep-alive idle.
 * Only a durable task receipt can authorize the next routing attempt. Capture
 * the exact bound admission client while running: its session authority is
 * revoked on cancellation or close, but its journal remains readable.
 *
 * The existing runner delivers the receipt to the parent. This observer never
 * fabricates mailbox messages or changes the child destination in place.
 */
export function observeChildRoutingAttempt(
  parent: Session,
  thread: AgentThread,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ChildRoutingAttemptResult<AgentThread>> {
  const live = thread.live;
  let admission: ExecutionAdmissionClient | undefined;
  let readDirectUsage: ExecutionAdmissionClient["getDirectUsageSummary"];
  const originalParentAdmission = parent.services.executionAdmission;
  const readParentUsage = originalParentAdmission?.getUsageSummary?.bind(originalParentAdmission);
  let turnId: string | undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const signal = options.signal ?? parent.abortController.signal;
    const cleanup = (): void => {
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      const error = new Error("Child routing observation was cancelled.");
      error.name = "AbortError";
      fail(error);
    };
    const observe = (status: AgentStatus): void => {
      if (settled) return;
      try {
        if (thread.live !== live) throw new Error("Child routing live identity changed.");
        admission ??= liveAgentSession(live)?.services.executionAdmission;
        // Read the method once. Session admission can be a proxy that binds
        // methods to whichever task is active at property access time.
        readDirectUsage ??= admission?.getDirectUsageSummary?.bind(admission);
        if ("turnId" in status) {
          if (turnId !== undefined && turnId !== status.turnId) {
            throw new Error("Child routing initial task changed before observation completed.");
          }
          turnId = status.turnId;
        }
        if (status.status === "pending_init" || status.status === "running") return;
        const receipt = live.lastTaskReceipt;
        if (status.status === "interrupted" &&
            (receipt?.turnId !== turnId || receipt?.terminal === undefined)) {
          // Control marks an interrupt before the runner commits its receipt.
          return;
        }
        if (receipt?.terminal === undefined || receipt.turnId !== turnId) {
          throw new Error("Child routing ended without a durable task receipt.");
        }
        const direct = readDirectUsage?.();
        if (direct !== undefined && direct.runId !== live.agentId) {
          throw new Error("Child routing received usage for another run.");
        }
        const summary = direct ?? readParentUsage?.();
        const usage: AdmissionUsageTotals | undefined = direct ?? summary?.agents.find(
          (agent) => agent.runId === live.agentId,
        );
        // Summary modelCalls excludes voided 402/429 calls. Count dispatch
        // journal reservations instead so those attempts still consume limits.
        const dispatched = admission !== undefined ? dispatchedModelCalls(admission, live.agentId) : undefined;
        const modelCalls = dispatched?.modelCalls
          ?? (summary !== undefined && usage === undefined && receipt.terminal.dispatch === "not_sent"
            ? 0 : undefined);
        if (modelCalls === undefined ||
            (receipt.terminal.dispatch !== "not_sent" && modelCalls === 0)) {
          throw new Error("Child routing cannot verify dispatched model calls.");
        }
        const usageKnown = usage !== undefined && (!usage.hasUnknownCost || usage.heldCostUsd > 0);
        const zeroCost = usage === undefined && (modelCalls === 0 || dispatched?.allDispatchedVoided === true);
        if (!usageKnown && !zeroCost) {
          throw new Error("Child routing cannot verify child cost reservations.");
        }
        const result: ChildRoutingAttemptResult<AgentThread> = {
          value: thread,
          terminal: receipt.terminal,
          modelCalls,
          toolCalls: live.toolCallCount,
          ...(usageKnown ? { costUsd: usage.costUsd, heldUnknownCostUsd: usage.heldCostUsd }
            : { costUsd: 0 }),
        };
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        fail(error);
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = thread.onStatusChange(observe);
    // onStatusChange synchronously replays the current status.
    if (settled) cleanup();
  });
}
