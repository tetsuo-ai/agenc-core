/** Canonical rollout construction shared by every in-process child Session. */

import { AdmissionDeniedError } from "../budget/admission-client.js";
import { readProviderIdentity } from "../llm/provider.js";
import { bindExecutionAdmissionJournal } from "./execution-admission-journal.js";
import type { SubagentTurnOutcomeEvent } from "./event-log.js";
import { RolloutStore } from "./rollout-store.js";
import type { Session } from "./session.js";

export interface MountChildRunJournalOptions {
  readonly parent: Session;
  readonly child: Session;
  readonly originator: string;
  readonly terminalResult: () => ChildRunTerminalResult;
}

export interface ChildRunTerminalResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly stopReason: string;
  readonly finalMessage?: string | null;
}

export interface RecordUnconstructedChildRunTerminalOptions {
  readonly parent: Session;
  readonly childRunId: string;
  readonly cwd: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly originator: string;
  readonly result: ChildRunTerminalResult;
  /**
   * Correlated task outcome for a run that failed before Session construction.
   * When present, it is fsync-committed immediately before run_terminal.
   */
  readonly taskOutcome?: SubagentTurnOutcomeEvent;
}

/**
 * Seal a child identity whose spawn committed but whose Session could not be
 * constructed. Reuse a partial journal when one exists; otherwise create the
 * minimal canonical journal needed to make the failed/cancelled run queryable.
 */
export function recordUnconstructedChildRunTerminal(
  options: RecordUnconstructedChildRunTerminalOptions,
): string | null {
  const parentRollout = options.parent.rolloutStore;
  const rawServices: unknown = options.parent.services;
  const services =
    typeof rawServices === "object" &&
    rawServices !== null &&
    !Array.isArray(rawServices)
      ? (rawServices as Session["services"])
      : undefined;
  const requiresCanonicalJournal =
    services !== undefined &&
    (services.executionAdmission !== undefined ||
      services.admissionRequired !== false);
  if (parentRollout === null) {
    if (requiresCanonicalJournal) {
      throw new AdmissionDeniedError("child_run_journal_unavailable");
    }
    return null;
  }

  const store = new RolloutStore({
    cwd: options.cwd,
    sessionId: options.childRunId,
    agencVersion: parentRollout.store.agencVersion,
    resume: true,
    ...(parentRollout.projectRootMarkers !== undefined
      ? { projectRootMarkers: parentRollout.projectRootMarkers }
      : {}),
  });
  try {
    store.open({
      sessionId: options.childRunId,
      timestamp: new Date().toISOString(),
      cwd: options.cwd,
      originator: options.originator,
      agencVersion: parentRollout.store.agencVersion,
      model: options.model,
      modelProvider: options.modelProvider,
    });
    let lastSequenceBeforeTerminal = store
      .readAll()
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload.seq)
      .filter(
        (sequence): sequence is number =>
          Number.isSafeInteger(sequence) && (sequence ?? 0) > 0,
      )
      .reduce((highest, sequence) => Math.max(highest, sequence), 0);
    const epoch = store.runEpoch;
    if (options.taskOutcome !== undefined) {
      const outcomeEventId = `subagent-turn-outcome:${options.childRunId}:${epoch}:${options.taskOutcome.turnId}`;
      const outcomeSequence = lastSequenceBeforeTerminal + 1;
      const outcomeCommitted = store.append(
        {
          eventId: outcomeEventId,
          id: outcomeEventId,
          seq: outcomeSequence,
          msg: {
            type: "subagent_turn_outcome",
            payload: options.taskOutcome,
          },
        },
        { durable: true },
      );
      if (!outcomeCommitted) {
        throw new Error(
          `unconstructed child task outcome ${outcomeEventId} was not fsync-committed`,
        );
      }
      lastSequenceBeforeTerminal = outcomeSequence;
    }
    const eventId = `run-terminal:${options.childRunId}:${epoch}`;
    const committed = store.append(
      {
        eventId,
        id: eventId,
        seq: lastSequenceBeforeTerminal + 1,
        msg: {
          type: "run_terminal",
          payload: {
            runId: options.childRunId,
            epoch,
            status: options.result.status,
            exitCode:
              options.result.status === "completed"
                ? 0
                : options.result.status === "failed"
                  ? 1
                  : null,
            stopReason: options.result.stopReason,
            finalMessage: options.result.finalMessage ?? null,
            usage: null,
            lastSequenceBeforeTerminal:
              lastSequenceBeforeTerminal > 0
                ? lastSequenceBeforeTerminal
                : null,
            finishedAt: new Date().toISOString(),
          },
        },
      },
      { durable: true },
    );
    if (!committed) {
      throw new Error(
        `unconstructed child run_terminal ${eventId} was not fsync-committed`,
      );
    }
    return store.rolloutPath;
  } finally {
    store.close();
  }
}

/**
 * Give a child run its own canonical identity and event stream. Admission and
 * effect/model evidence must never be projected into the parent's rollout or
 * proceed with no durable consumer-visible journal.
 */
export function mountChildRunJournal(
  options: MountChildRunJournalOptions,
): RolloutStore | null {
  const { parent, child } = options;
  const parentRollout = parent.rolloutStore;
  const admission = child.services.executionAdmission;
  const requiresCanonicalJournal =
    admission !== undefined || child.services.admissionRequired !== false;
  if (parentRollout === null) {
    if (requiresCanonicalJournal) {
      throw new AdmissionDeniedError("child_run_journal_unavailable");
    }
    return null;
  }

  const sessionConfiguration = child.sessionConfiguration;
  const store = new RolloutStore({
    cwd: sessionConfiguration.cwd,
    sessionId: child.conversationId,
    agencVersion: parentRollout.store.agencVersion,
    ...(parentRollout.projectRootMarkers !== undefined
      ? { projectRootMarkers: parentRollout.projectRootMarkers }
      : {}),
  });
  store.open({
    sessionId: child.conversationId,
    timestamp: new Date().toISOString(),
    cwd: sessionConfiguration.cwd,
    originator: options.originator,
    agencVersion: parentRollout.store.agencVersion,
    model: sessionConfiguration.collaborationMode.model,
    modelProvider:
      readProviderIdentity(child.services.provider) ??
      child.services.provider.name,
  });

  try {
    child.mountRolloutStore(store);
    child.eventLog.seedCanonicalHistory(
      store
        .readAll()
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload),
    );
    if (admission !== undefined) {
      const unbindAdmission = bindExecutionAdmissionJournal(child, admission);
      child.onBeforeDurableClose(unbindAdmission);
    }
    child.onBeforeDurableClose(() => {
      const result = options.terminalResult();
      const epoch = store.runEpoch;
      const runId = child.conversationId;
      const lastSequenceBeforeTerminal =
        Number.isSafeInteger(child.eventLog.lastSeq) &&
        child.eventLog.lastSeq > 0
          ? child.eventLog.lastSeq
          : null;
      const eventId = `run-terminal:${runId}:${epoch}`;
      const terminal = child.emit({
        eventId,
        id: eventId,
        msg: {
          type: "run_terminal",
          payload: {
            runId,
            epoch,
            status: result.status,
            exitCode:
              result.status === "completed"
                ? 0
                : result.status === "failed"
                  ? 1
                  : null,
            stopReason: result.stopReason,
            finalMessage: result.finalMessage ?? null,
            usage: null,
            lastSequenceBeforeTerminal,
            finishedAt: new Date().toISOString(),
          },
        },
      });
      if (
        terminal.eventId !== eventId ||
        terminal.id !== eventId ||
        !Number.isSafeInteger(terminal.seq) ||
        (terminal.seq ?? 0) <= 0
      ) {
        throw new Error(
          `child run_terminal ${eventId} has no canonical identity and sequence`,
        );
      }
    });
    return store;
  } catch (error) {
    child.mountRolloutStore(null);
    try {
      store.close();
    } catch {
      // Preserve the construction/binding failure.
    }
    throw error;
  }
}
