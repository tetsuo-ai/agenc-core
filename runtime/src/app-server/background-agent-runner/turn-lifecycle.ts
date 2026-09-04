/**
 * Submission and turn lifecycle: active-agent predicates, shell submissions,
 * durable run events and terminal results. Split out of
 * background-agent-runner.ts as a pure move.
 */

import { createHash } from "node:crypto";
import type { LocalRuntimeBootstrap } from "../../bin/bootstrap.js";
import type { AgentControl } from "../../agents/control.js";
import { MailboxClosedError } from "../../agents/mailbox.js";
import type { ManagedThread } from "../../agents/thread-manager.js";
import type { LLMContentPart } from "../../llm/types.js";
import type { ToolDispatchResult } from "../../tool-registry.js";
import type { AgentStatus as ThreadAgentStatus } from "../../agents/status.js";
import type { Event } from "../../session/event-log.js";
import type { SessionSubmitOptions } from "../../session/autonomous-mode.js";
import type {
  MessageContent,
  SessionShellExecuteResult,
} from "../protocol/index.js";
import { MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES } from "../protocol/index.js";
import type { RunTerminalResult } from "../../contracts/run-contracts.js";

import {
  AgenCBackgroundAgentMessageError,
  positiveSequence,
  recordValue,
  isJsonObject,
} from "./shared.js";
import type {
  AgenCBackgroundAgentTerminalSnapshot,
  AgenCBackgroundAgentSuspensionSnapshot,
  ActiveBackgroundAgent,
} from "./shared.js";
import { terminalUsageForActiveAgent } from "./snapshot-retention.js";

function isRunnableActiveAgent(active: ActiveBackgroundAgent): boolean {
  return (
    active.ingressClosed !== true &&
    active.pendingTerminal === undefined &&
    active.pendingSuspension === undefined
  );
}

function isInterruptibleActiveAgent(active: ActiveBackgroundAgent): boolean {
  return (
    active.ingressClosed !== true &&
    (active.pendingTerminal === undefined ||
      active.cancellationRequest !== undefined)
  );
}

interface ActiveTurnPeek {
  unsafePeek?: () => unknown;
}

function hasRuntimeActiveTurn(
  session: LocalRuntimeBootstrap["session"],
): boolean {
  const activeTurn = (session as unknown as { activeTurn?: ActiveTurnPeek })
    .activeTurn;
  return (
    typeof activeTurn?.unsafePeek === "function" &&
    activeTurn.unsafePeek() !== null
  );
}

function hasOpenAgentDescendants(
  control: AgentControl,
  rootThreadId: string,
): boolean {
  const childrenByParent = control.liveThreadSpawnChildren();
  const pending = [rootThreadId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const parent = pending.pop()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const children = childrenByParent.get(parent) ?? [];
    if (children.length > 0) return true;
    for (const [childThreadId] of children) pending.push(childThreadId);
  }
  return false;
}

function runtimeActiveTurnId(
  session: LocalRuntimeBootstrap["session"],
): string | undefined {
  const activeTurn = (session as unknown as { activeTurn?: ActiveTurnPeek })
    .activeTurn;
  if (typeof activeTurn?.unsafePeek !== "function") return undefined;
  const value = activeTurn.unsafePeek();
  if (!isJsonObject(value) || typeof value.turnId !== "string") {
    return undefined;
  }
  return value.turnId;
}

function isClearInFlight(active: ActiveBackgroundAgent): boolean {
  return (
    active.pendingMessageSubmissionCount > 0 ||
    active.pendingShellExecutionCount > 0 ||
    active.messageSubmission !== undefined ||
    hasRuntimeActiveTurn(active.bootstrap.session) ||
    active.activeToolCallIds.size > 0
  );
}

const SHELL_RESULT_TRUNCATION_MARKER = "\n[truncated]";

function shellSubmissionMessageId(commandId: string): string {
  return `shell:${commandId}`;
}

function shellEventKey(commandId: string): string {
  return createHash("sha256")
    .update(commandId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function throwIfShellRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Shell command cancelled",
  );
}

function boundShellResultText(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES) {
    return { value, truncated: false };
  }
  const marker = Buffer.from(SHELL_RESULT_TRUNCATION_MARKER, "utf8");
  let end = Math.max(
    0,
    MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES - marker.byteLength,
  );
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: `${encoded.subarray(0, end).toString("utf8")}${SHELL_RESULT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function normalizeSessionShellResult(
  commandId: string,
  dispatch: ToolDispatchResult,
): SessionShellExecuteResult {
  const metadata = recordValue(dispatch.metadata);
  const codeMode = recordValue(dispatch.codeModeResult);
  const metadataStdout =
    typeof metadata.stdout === "string" ? metadata.stdout : undefined;
  const codeModeOutput =
    typeof codeMode.output === "string" ? codeMode.output : undefined;
  const rawStdout =
    metadataStdout ??
    codeModeOutput ??
    (dispatch.isError === true ? "" : dispatch.content);
  const rawStderr =
    typeof metadata.stderr === "string"
      ? metadata.stderr
      : dispatch.isError === true && rawStdout.length === 0
        ? dispatch.content
        : "";
  const metadataExitCode = metadata.exitCode;
  const codeModeExitCode = codeMode.exit_code;
  const exitCode =
    typeof metadataExitCode === "number" &&
    Number.isSafeInteger(metadataExitCode)
      ? metadataExitCode
      : typeof codeModeExitCode === "number" &&
          Number.isSafeInteger(codeModeExitCode)
        ? codeModeExitCode
        : null;
  const timedOut = metadata.timedOut === true || codeMode.timed_out === true;
  const content = boundShellResultText(dispatch.content);
  const stdout = boundShellResultText(rawStdout);
  const stderr = boundShellResultText(rawStderr);
  const truncated =
    metadata.truncated === true ||
    content.truncated ||
    stdout.truncated ||
    stderr.truncated;
  return {
    commandId,
    content: content.value,
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode,
    timedOut,
    truncated,
    isError:
      dispatch.isError === true ||
      timedOut ||
      (exitCode !== null && exitCode !== 0),
  };
}

function clientMessageIdConflict(
  clientMessageId: string,
): AgenCBackgroundAgentMessageError {
  return new AgenCBackgroundAgentMessageError(
    "CLIENT_MESSAGE_ID_CONFLICT",
    `clientMessageId ${clientMessageId} was already used for different content`,
  );
}

function messageContentToLlmParts(
  content: MessageContent | undefined,
): readonly LLMContentPart[] | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image_url",
      image_url: { url: part.image_url.url },
    };
  });
}

type TerminalThreadStatus = Extract<
  ThreadAgentStatus,
  { readonly status: "completed" | "errored" | "shutdown" | "not_found" }
>;

function commitDurableRunStartupActivation(
  active: ActiveBackgroundAgent,
  runId: string,
  activatedAt: string,
): void {
  const resumeEventId = active.pendingStartupActivationResumeEventId;
  if (resumeEventId === undefined) return;
  const exactActivatedAt =
    active.pendingStartupActivationActivatedAt ?? activatedAt;
  active.pendingStartupActivationActivatedAt = exactActivatedAt;
  const epoch = active.runEpoch;
  const resumeHash = createHash("sha256")
    .update(resumeEventId, "utf8")
    .digest("hex")
    .slice(0, 32);
  const eventId = `run-startup-activated:${runId}:${epoch}:${resumeHash}`;
  const acceptCommitted = (proveDurable: boolean): Event | undefined => {
    const matches = active.bootstrap.rolloutStore
      .readAll()
      .flatMap((item) =>
        item.type === "event_msg" &&
        (item.payload.eventId === eventId || item.payload.id === eventId)
          ? [item.payload]
          : [],
      );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(`startup activation ${eventId} has duplicate evidence`);
    }
    const event = matches[0]!;
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      positiveSequence(event.seq) === undefined ||
      event.msg.type !== "run_startup_activated" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== epoch ||
      event.msg.payload.resumeEventId !== resumeEventId ||
      event.msg.payload.activatedAt !== exactActivatedAt
    ) {
      throw new Error(`startup activation ${eventId} has conflicting evidence`);
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    return event;
  };
  let event: Event;
  try {
    event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_startup_activated",
        payload: {
          runId,
          epoch,
          resumeEventId,
          activatedAt: exactActivatedAt,
        },
      },
    });
  } catch (error) {
    const recovered = acceptCommitted(true);
    if (recovered === undefined) throw error;
    event = recovered;
  }
  if (event.eventId !== eventId || positiveSequence(event.seq) === undefined) {
    throw new Error(
      `startup activation ${eventId} lacks canonical coordinates`,
    );
  }
  try {
    active.bootstrap.rolloutStore.recordRunStartupActivationEvent(event);
  } catch {
    // Canonical fsync evidence is authoritative; SQLite is rebuildable.
  }
  active.pendingStartupActivationResumeEventId = undefined;
  active.pendingStartupActivationActivatedAt = undefined;
}

function awaitTerminalStatus(
  thread: ManagedThread,
): Promise<TerminalThreadStatus> {
  return new Promise((resolve) => {
    let settledSynchronously = false;
    let unsubscribe = (): void => {};
    const listener = (status: ThreadAgentStatus): void => {
      if (
        status.status === "completed" ||
        status.status === "errored" ||
        status.status === "shutdown" ||
        status.status === "not_found"
      ) {
        settledSynchronously = true;
        unsubscribe();
        resolve(status);
      }
    };
    unsubscribe = thread.subscribeStatus(listener);
    // ManagedThread subscriptions publish their current value immediately.
    // If it was already terminal, the callback ran before the real
    // unsubscribe function was assigned.
    if (settledSynchronously) unsubscribe();
  });
}

function commitDurableRunCancellationRequest(
  active: ActiveBackgroundAgent,
  runId: string,
  reason: string,
): void {
  const requestedAt = active.pendingTerminal?.finishedAt ?? active.lastActiveAt;
  const existing = active.cancellationRequest;
  if (existing !== undefined) {
    if (existing.reason !== reason || existing.requestedAt !== requestedAt) {
      throw new Error(`run ${runId} has conflicting cancellation intent`);
    }
    return;
  }
  const eventId = `run-cancel-request:${runId}:${active.runEpoch}`;
  const acceptCommitted = (proveDurable = false): boolean => {
    const matches = active.bootstrap.rolloutStore.readAll().flatMap((item) => {
      if (item.type !== "event_msg") return [];
      const event = item.payload;
      if (
        event.eventId !== eventId &&
        event.id !== eventId &&
        !(
          event.msg.type === "run_cancel_requested" &&
          event.msg.payload.runId === runId &&
          event.msg.payload.epoch === active.runEpoch
        )
      ) {
        return [];
      }
      return [event];
    });
    if (matches.length === 0) return false;
    if (matches.length !== 1) {
      throw new Error(
        `run cancellation request ${eventId} has duplicate canonical evidence`,
      );
    }
    const event = matches[0]!;
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined ||
      event.msg.type !== "run_cancel_requested" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== active.runEpoch ||
      event.msg.payload.reason !== reason ||
      event.msg.payload.requestedAt !== requestedAt
    ) {
      throw new Error(
        `run cancellation request ${eventId} has conflicting canonical evidence`,
      );
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    active.cancellationRequest = {
      eventId,
      sequence,
      reason,
      requestedAt,
    };
    return true;
  };
  if (acceptCommitted(true)) return;
  try {
    const event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_cancel_requested",
        payload: {
          runId,
          epoch: active.runEpoch,
          reason,
          requestedAt,
        },
      },
    });
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined
    ) {
      throw new Error(
        `run cancellation request ${eventId} has no canonical coordinates`,
      );
    }
    active.cancellationRequest = {
      eventId,
      sequence,
      reason,
      requestedAt,
    };
  } catch (error) {
    // Session.emit may fail after append+fsync at the publish failpoint. The
    // deterministic identity makes retry safe only when the bytes on disk are
    // exactly the requested cancellation evidence.
    if (!acceptCommitted(true)) throw error;
  }
}

function commitDurableRunTerminal(
  active: ActiveBackgroundAgent,
  runId: string,
  result: RunTerminalResult,
): AgenCBackgroundAgentTerminalSnapshot {
  if (active.terminal !== undefined) return active.terminal;
  const epoch = active.runEpoch;
  const session = active.bootstrap.session;
  const lastSequenceBeforeTerminal =
    positiveSequence(session.eventLog.lastSeq) ?? null;
  const eventId = `run-terminal:${runId}:${epoch}`;
  const event = session.emit({
    eventId,
    id: eventId,
    msg: {
      type: "run_terminal",
      payload: {
        runId,
        epoch,
        status: result.status,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
        finalMessage: result.finalMessage,
        usage: result.usage,
        lastSequenceBeforeTerminal,
        finishedAt: result.finishedAt,
      },
    },
  });
  const sequence = positiveSequence(event.seq);
  if (
    event.id !== eventId ||
    event.eventId !== eventId ||
    sequence === undefined
  ) {
    throw new Error(
      `run_terminal ${eventId} was not assigned its canonical id and positive sequence`,
    );
  }
  const terminal: AgenCBackgroundAgentTerminalSnapshot = {
    openedAt: active.startedAt,
    epoch,
    eventId: event.eventId,
    rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
    result: {
      ...result,
      lastSequence: sequence,
    },
  };
  active.terminal = terminal;
  return terminal;
}

function commitDurableRunSuspension(
  active: ActiveBackgroundAgent,
  runId: string,
): AgenCBackgroundAgentSuspensionSnapshot {
  if (active.suspension !== undefined) return active.suspension;
  const pending = active.pendingSuspension;
  if (pending === undefined) {
    throw new Error(`run ${runId} has no daemon suspension pending`);
  }
  const epoch = active.runEpoch;
  const eventId = pending.eventId;

  const acceptCommitted = (
    proveDurable = false,
  ): AgenCBackgroundAgentSuspensionSnapshot | undefined => {
    const matches = active.bootstrap.rolloutStore.readAll().flatMap((item) => {
      if (item.type !== "event_msg") return [];
      const event = item.payload;
      if (event.eventId !== eventId && event.id !== eventId) {
        return [];
      }
      if (
        event.msg.type !== "run_suspended" ||
        event.msg.payload.runId !== runId ||
        event.msg.payload.epoch !== epoch
      ) {
        return [];
      }
      return [event];
    });
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(
        `run suspension ${eventId} has duplicate canonical evidence`,
      );
    }
    const event = matches[0]!;
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined ||
      event.msg.type !== "run_suspended" ||
      event.msg.payload.reason !== pending.reason ||
      event.msg.payload.suspendedAt !== pending.suspendedAt
    ) {
      throw new Error(
        `run suspension ${eventId} has conflicting canonical evidence`,
      );
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    const suspension: AgenCBackgroundAgentSuspensionSnapshot = {
      openedAt: active.startedAt,
      epoch,
      eventId,
      sequence,
      rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
      reason: pending.reason,
      suspendedAt: pending.suspendedAt,
    };
    active.suspension = suspension;
    try {
      active.bootstrap.rolloutStore.recordRunSuspensionEvent(event);
    } catch {
      // SQLite is a rebuildable projection. Canonical fsync evidence remains
      // authoritative and startup recovery will replay this boundary.
    }
    return suspension;
  };

  const committed = acceptCommitted(true);
  if (committed !== undefined) return committed;
  try {
    const event = active.bootstrap.session.emit({
      eventId,
      id: eventId,
      msg: {
        type: "run_suspended",
        payload: {
          runId,
          epoch,
          reason: pending.reason,
          suspendedAt: pending.suspendedAt,
        },
      },
    });
    const sequence = positiveSequence(event.seq);
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      sequence === undefined
    ) {
      throw new Error(
        `run_suspended ${eventId} was not assigned canonical coordinates`,
      );
    }
    const suspension: AgenCBackgroundAgentSuspensionSnapshot = {
      openedAt: active.startedAt,
      epoch,
      eventId,
      sequence,
      rolloutPath: active.bootstrap.rolloutStore.rolloutPath,
      reason: pending.reason,
      suspendedAt: pending.suspendedAt,
    };
    active.suspension = suspension;
    try {
      active.bootstrap.rolloutStore.recordRunSuspensionEvent(event);
    } catch {
      // Rebuildable projection; the fsync-committed event is authoritative.
    }
    return suspension;
  } catch (error) {
    const recovered = acceptCommitted(true);
    if (recovered !== undefined) return recovered;
    throw error;
  }
}

function cancelledTerminalResult(
  active: ActiveBackgroundAgent,
  runId: string,
  stopReason: string,
  finishedAt: string,
): RunTerminalResult {
  return {
    runId,
    status: "cancelled",
    exitCode: null,
    stopReason,
    finalMessage: null,
    usage: terminalUsageForActiveAgent(active),
    lastSequence: null,
    finishedAt,
  };
}

function terminalResultFromThread(
  active: ActiveBackgroundAgent,
  runId: string,
  status: TerminalThreadStatus,
): RunTerminalResult {
  const usage = terminalUsageForActiveAgent(active);
  const finishedAt =
    "endedAtMs" in status && Number.isFinite(status.endedAtMs)
      ? new Date(status.endedAtMs).toISOString()
      : active.lastActiveAt;
  if (status.status === "completed") {
    return {
      runId,
      status: "completed",
      exitCode: 0,
      stopReason: "turn_completed",
      finalMessage: status.lastMessage ?? null,
      usage,
      lastSequence: null,
      finishedAt,
    };
  }
  if (status.status === "errored") {
    return {
      runId,
      status: "failed",
      exitCode: 1,
      stopReason: status.error,
      finalMessage: null,
      usage,
      lastSequence: null,
      finishedAt,
    };
  }
  return {
    runId,
    status: "cancelled",
    exitCode: null,
    stopReason: status.status === "shutdown" ? "shutdown" : "not_found",
    finalMessage: null,
    usage,
    lastSequence: null,
    finishedAt,
  };
}

function messageContentToAgentInput(
  content: MessageContent,
): string | readonly LLMContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { url: part.image_url.url } };
  });
}

async function submitStructuredAgentInput(
  active: ActiveBackgroundAgent,
  input: readonly LLMContentPart[],
  _displayText: string,
  submitOptions?: SessionSubmitOptions,
): Promise<void> {
  try {
    await active.thread.submit({
      type: "user_input",
      input,
      ...(submitOptions !== undefined ? { submitOptions } : {}),
    });
  } catch (error) {
    if (error instanceof MailboxClosedError) {
      throw new Error(
        `AgenC daemon agent not running: ${active.thread.threadId}`,
      );
    }
    throw error;
  }
}

function messageContentDisplayText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

export {
  isRunnableActiveAgent,
  isInterruptibleActiveAgent,
  hasRuntimeActiveTurn,
  hasOpenAgentDescendants,
  runtimeActiveTurnId,
  isClearInFlight,
  shellSubmissionMessageId,
  shellEventKey,
  throwIfShellRequestAborted,
  normalizeSessionShellResult,
  clientMessageIdConflict,
  messageContentToLlmParts,
  commitDurableRunStartupActivation,
  awaitTerminalStatus,
  commitDurableRunCancellationRequest,
  commitDurableRunTerminal,
  commitDurableRunSuspension,
  cancelledTerminalResult,
  terminalResultFromThread,
  messageContentToAgentInput,
  submitStructuredAgentInput,
  messageContentDisplayText,
};
