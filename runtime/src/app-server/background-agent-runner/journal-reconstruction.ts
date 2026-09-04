/**
 * Rollout journal scans: transcript reconstruction, transcript boundaries,
 * persisted submissions and run epochs. Split out of
 * background-agent-runner.ts as a pure move.
 */

import type { LocalRuntimeBootstrap } from "../../bin/bootstrap.js";
import type { Event } from "../../session/event-log.js";
import type { RolloutItem } from "../../session/rollout-item.js";
import {
  reconstructFromRollout,
} from "../../session/rollout-reconstruction.js";
import type {
  JsonObject,
  SessionTranscriptV2Result,
  SessionTranscriptV2TurnResult,
} from "../protocol/index.js";

import {
  positiveSequence,
  assistantMessageId,
  historyEpochForBoundary,
  messageContentFingerprint,
  canonicalEventId,
  nonNegativeFinite,
  isJsonObject,
} from "./shared.js";
import type { AgenCBackgroundAgentMessageTerminal } from "./shared.js";

function historyEpochFromRollout(
  items: readonly RolloutItem[],
  runId: string,
): string {
  return historyEpochForBoundary(
    runId,
    latestTranscriptBoundary(items)?.id ?? "initial",
  );
}

interface TranscriptBoundary {
  readonly index: number;
  readonly id: string;
  readonly kind: "cleared" | "replaced";
  readonly sequence?: number;
}

function latestTranscriptBoundary(
  items: readonly RolloutItem[],
): TranscriptBoundary | undefined {
  let latest: TranscriptBoundary | undefined;
  for (const [index, item] of items.entries()) {
    if (
      item.type === "event_msg" &&
      (item.payload.msg.type === "history_cleared" ||
        item.payload.msg.type === "transcript_epoch")
    ) {
      latest = {
        index,
        id: canonicalEventId(item.payload),
        kind:
          item.payload.msg.type === "history_cleared" ? "cleared" : "replaced",
        ...(positiveSequence(item.payload.seq) !== undefined
          ? { sequence: positiveSequence(item.payload.seq) }
          : {}),
      };
      continue;
    }
    // Compaction is deliberately NOT a transcript boundary.
    //
    // It changes what the MODEL sees; the person reading the transcript still
    // sent every earlier message and expects to find them. Treating a commit
    // as a boundary truncated the reloaded transcript to the compacted view
    // and rendered the summary itself as a user message: live, a 13-turn
    // session came back as two turns after an app relaunch, because that
    // rollout contained two compaction commits and no explicit epoch event.
    //
    // A user-facing reset still truncates, and is still the only thing that
    // does: `history_cleared` and `transcript_epoch` above. A partial compact
    // or a rewind that means to reset the transcript emits `transcript_epoch`
    // alongside its `compacted` item, so those keep working unchanged.
  }
  return latest;
}

interface PersistedMessageSubmission {
  readonly contentFingerprint: string;
  readonly acceptedAt?: string;
  readonly turnId?: string;
  readonly terminal?: AgenCBackgroundAgentMessageTerminal;
}

function findPersistedMessageSubmission(
  items: readonly RolloutItem[],
  clientMessageId: string,
): PersistedMessageSubmission | undefined {
  let match: PersistedMessageSubmission | undefined;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    if (
      match === undefined &&
      ((event.msg.type === "user_message" &&
        event.msg.payload.messageId === clientMessageId) ||
        (event.msg.type === "message_submission" &&
          event.msg.payload.messageId === clientMessageId))
    ) {
      const contentFingerprint =
        event.msg.type === "message_submission"
          ? event.msg.payload.contentFingerprint
          : messageContentFingerprint(event.msg.payload.message);
      const acceptedAt = event.msg.payload.acceptedAt;
      match = {
        contentFingerprint,
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      };
      continue;
    }
    if (match === undefined) continue;
    // A user_message starts the next admitted submission. Never let a
    // crash-tail retry inherit that later submission's turn_started or
    // terminal outcome.
    if (
      event.msg.type === "user_message" ||
      event.msg.type === "message_submission"
    ) {
      return match;
    }
    if (event.msg.type === "turn_started" && match.turnId === undefined) {
      match = { ...match, turnId: event.msg.payload.turnId };
      continue;
    }
    if (match.turnId === undefined) continue;
    const terminal = messageTerminalFromEvent(event.msg, match.turnId);
    if (terminal !== undefined) {
      return { ...match, terminal };
    }
  }
  return match;
}

function messageTerminalFromEvent(
  event: Event["msg"],
  expectedTurnId: string | undefined,
): AgenCBackgroundAgentMessageTerminal | undefined {
  if (event.type === "turn_complete") {
    if (
      expectedTurnId !== undefined &&
      event.payload.turnId !== expectedTurnId
    ) {
      return undefined;
    }
    return {
      code: 0,
      ...(event.payload.lastAgentMessage !== undefined
        ? { message: event.payload.lastAgentMessage }
        : {}),
    };
  }
  if (event.type === "turn_aborted") {
    if (
      expectedTurnId !== undefined &&
      event.payload.turnId !== undefined &&
      event.payload.turnId !== expectedTurnId
    ) {
      return undefined;
    }
    return { code: 130, message: event.payload.reason };
  }
  // Same contract as the live bridge: only turn_complete / turn_aborted
  // close a submission. A mid-turn `error` must not make an idempotent
  // retry report completed-with-failure while turn_complete is still
  // ahead in the journal.
  return undefined;
}

interface MutableTranscriptV2Message extends JsonObject {
  messageId: string;
  commitEventId: string;
  role: "user" | "assistant";
  text: string;
  turnId?: string;
  clientMessageId?: string;
  committedSequence: number;
}

/** Running totals for the turn currently open in the canonical scan. */
interface OpenTurnAccumulator {
  startedAt?: number;
  sawUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
  provider?: string;
}

/**
 * A turn's terminal row: timing from the terminal event itself (falling back
 * to the started/completed stamps for rollouts written before `durationMs`),
 * usage summed from the token_count events the turn enclosed.
 */
function closedTurnResult(
  turnId: string,
  sequence: number,
  msg: {
    readonly type: string;
    readonly payload: {
      readonly turnId?: string;
      readonly durationMs?: number;
      readonly completedAt?: number;
    };
  },
  open: OpenTurnAccumulator,
): SessionTranscriptV2TurnResult {
  const outcome = msg.type === "turn_aborted" ? "aborted" : "completed";
  let durationMs: number | undefined;
  if (msg.type === "turn_complete") {
    durationMs = nonNegativeFinite(msg.payload.durationMs);
    if (durationMs === undefined) {
      const completedAt = nonNegativeFinite(msg.payload.completedAt);
      if (completedAt !== undefined && open.startedAt !== undefined) {
        durationMs = nonNegativeFinite(completedAt - open.startedAt);
      }
    }
  }
  return {
    turnId,
    committedSequence: sequence,
    outcome,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(open.sawUsage
      ? {
          inputTokens: open.inputTokens,
          outputTokens: open.outputTokens,
          totalTokens: open.totalTokens,
        }
      : {}),
    ...(open.model !== undefined ? { model: open.model } : {}),
    ...(open.provider !== undefined ? { provider: open.provider } : {}),
  };
}

export function sessionTranscriptV2FromRollout(
  items: readonly RolloutItem[],
  sessionId: string,
  runId: string,
  activeTurn?: { readonly turnId: string; readonly clientMessageId: string },
): SessionTranscriptV2Result {
  const boundary = latestTranscriptBoundary(items);
  const boundaryIndex = boundary?.index ?? -1;
  const boundaryId = boundary?.id ?? "initial";
  let asOfSequence = 0;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    if (
      event.seq !== undefined &&
      Number.isSafeInteger(event.seq) &&
      event.seq > asOfSequence
    ) {
      asOfSequence = event.seq;
    }
  }

  const messages: MutableTranscriptV2Message[] = [];
  const turnResults: SessionTranscriptV2TurnResult[] = [];
  let currentTurnId: string | undefined;
  let currentClientMessageId: string | undefined;
  let openTurn: OpenTurnAccumulator | undefined;
  let pendingUserIndex: number | undefined;
  let pendingClientMessageId: string | undefined;
  const assistantOrdinals = new Map<string, number>();

  if (boundary?.kind === "replaced") {
    const replacement = reconstructFromRollout(
      items.slice(0, boundary.index + 1),
    ).history;
    const replacementSequence =
      boundary.sequence ?? maxEventSequence(items.slice(0, boundary.index + 1));
    let ordinal = 0;
    for (const item of replacement) {
      if (item.role !== "user" && item.role !== "assistant") continue;
      const text = responseItemDisplayText(item.content);
      if (text.length === 0) continue;
      const messageId = `replacement:${boundary.id}:${ordinal}`;
      messages.push({
        messageId,
        commitEventId: messageId,
        role: item.role,
        text,
        committedSequence: replacementSequence,
      });
      ordinal += 1;
    }
  }

  const transcriptStartIndex = boundaryIndex + 1;
  const firstCanonicalTranscriptIndex = items.findIndex(
    (item, index) =>
      index >= transcriptStartIndex &&
      item.type === "event_msg" &&
      (item.payload.msg.type === "user_message" ||
        item.payload.msg.type === "message_submission" ||
        item.payload.msg.type === "agent_message"),
  );
  const legacyEndIndex =
    firstCanonicalTranscriptIndex < 0
      ? items.length
      : firstCanonicalTranscriptIndex;
  let legacyOrdinal = 0;
  for (let index = transcriptStartIndex; index < legacyEndIndex; index += 1) {
    const item = items[index]!;
    if (item.type !== "response_item") continue;
    if (item.payload.role !== "user" && item.payload.role !== "assistant") {
      continue;
    }
    const text = responseItemDisplayText(item.payload.content);
    if (text.length === 0) continue;
    const messageId = `legacy:${boundaryId}:${legacyOrdinal}`;
    messages.push({
      messageId,
      commitEventId: messageId,
      role: item.payload.role,
      text,
      committedSequence: 0,
    });
    legacyOrdinal += 1;
  }

  // Scan canonical turn context from the epoch boundary, not merely from the
  // first visible transcript row. Hidden-user submissions deliberately have
  // no user_message, so their preceding turn_started is the only durable
  // source for the assistant message identity.
  for (let index = transcriptStartIndex; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    const sequence = positiveSequence(event.seq);
    if (sequence === undefined) continue;
    if (event.msg.type === "message_submission") {
      pendingUserIndex = undefined;
      pendingClientMessageId = event.msg.payload.messageId;
      continue;
    }
    if (event.msg.type === "user_message") {
      const text =
        event.msg.payload.displayText ??
        unknownMessageContentDisplayText(event.msg.payload.message);
      if (text.length === 0) continue;
      const commitEventId = canonicalEventId(event);
      const clientMessageId = event.msg.payload.messageId;
      messages.push({
        messageId: clientMessageId ?? `message:${commitEventId}`,
        commitEventId,
        role: "user",
        text,
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        committedSequence: sequence,
      });
      pendingUserIndex = messages.length - 1;
      pendingClientMessageId = clientMessageId;
      continue;
    }
    if (event.msg.type === "turn_started") {
      currentTurnId = event.msg.payload.turnId;
      if (pendingUserIndex !== undefined) {
        messages[pendingUserIndex]!.turnId = currentTurnId;
        pendingUserIndex = undefined;
      }
      currentClientMessageId = pendingClientMessageId;
      pendingClientMessageId = undefined;
      // A dangling previous turn has no terminal event and therefore no
      // result row; the fresh accumulator simply replaces it.
      const startedAt = nonNegativeFinite(event.msg.payload.startedAt);
      openTurn = {
        sawUsage: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
      continue;
    }
    if (event.msg.type === "token_count") {
      if (currentTurnId === undefined || openTurn === undefined) continue;
      const payload = event.msg.payload;
      const input = nonNegativeFinite(payload.promptTokens);
      const output = nonNegativeFinite(payload.completionTokens);
      const total = nonNegativeFinite(payload.totalTokens);
      if (input === undefined && output === undefined && total === undefined) {
        continue;
      }
      openTurn.sawUsage = true;
      openTurn.inputTokens += input ?? 0;
      openTurn.outputTokens += output ?? 0;
      openTurn.totalTokens += total ?? 0;
      if (typeof payload.model === "string" && payload.model.length > 0) {
        openTurn.model = payload.model;
      }
      if (typeof payload.provider === "string" && payload.provider.length > 0) {
        openTurn.provider = payload.provider;
      }
      continue;
    }
    if (event.msg.type === "agent_message") {
      const commitEventId = canonicalEventId(event);
      const correlationId = currentTurnId ?? commitEventId;
      const ordinal = assistantOrdinals.get(correlationId) ?? 0;
      assistantOrdinals.set(correlationId, ordinal + 1);
      const text = event.msg.payload.message;
      // Empty durable commits are not transcript rows, but they still occupy
      // an ordinal because the live identity allocator observes them.
      if (text.length === 0) continue;
      messages.push({
        messageId:
          currentTurnId === undefined
            ? `assistant:${commitEventId}`
            : assistantMessageId(currentTurnId, ordinal),
        commitEventId,
        role: "assistant",
        text,
        ...(currentTurnId !== undefined ? { turnId: currentTurnId } : {}),
        ...(currentClientMessageId !== undefined
          ? { clientMessageId: currentClientMessageId }
          : {}),
        committedSequence: sequence,
      });
      continue;
    }
    if (
      event.msg.type === "turn_complete" ||
      event.msg.type === "turn_aborted"
    ) {
      const terminalTurnId =
        "turnId" in event.msg.payload &&
        typeof event.msg.payload.turnId === "string"
          ? event.msg.payload.turnId
          : undefined;
      if (
        (currentTurnId === undefined && pendingUserIndex !== undefined) ||
        (currentTurnId !== undefined &&
          terminalTurnId !== undefined &&
          terminalTurnId !== currentTurnId)
      ) {
        continue;
      }
      if (currentTurnId !== undefined && openTurn !== undefined) {
        turnResults.push(
          closedTurnResult(currentTurnId, sequence, event.msg, openTurn),
        );
      }
      currentTurnId = undefined;
      currentClientMessageId = undefined;
      openTurn = undefined;
    }
  }

  return {
    schemaVersion: 2,
    sessionId,
    runId,
    historyEpoch: historyEpochForBoundary(runId, boundaryId),
    asOfSequence,
    messages,
    ...(activeTurn !== undefined ? { activeTurn } : {}),
    ...(turnResults.length > 0 ? { turnResults } : {}),
  };
}

function maxEventSequence(items: readonly RolloutItem[]): number {
  let max = 0;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const sequence = positiveSequence(item.payload.seq);
    if (sequence !== undefined) max = Math.max(max, sequence);
  }
  return max;
}

function responseItemDisplayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isJsonObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function unknownMessageContentDisplayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isJsonObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "image") return "[image]";
      if (part.type === "document") return "[document]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function currentRunEpochFromRollout(
  bootstrap: LocalRuntimeBootstrap,
  runId: string,
): number {
  let epoch = 1;
  try {
    const items = bootstrap.rolloutStore.readAll() as ReadonlyArray<{
      readonly type?: unknown;
      readonly payload?: {
        readonly msg?: {
          readonly type?: unknown;
          readonly payload?: {
            readonly runId?: unknown;
            readonly epoch?: unknown;
          };
        };
      };
    }>;
    for (const item of items) {
      if (
        item.type !== "event_msg" ||
        item.payload?.msg?.type !== "run_reopened" ||
        item.payload.msg.payload?.runId !== runId
      ) {
        continue;
      }
      const reopenedEpoch = positiveSequence(item.payload.msg.payload.epoch);
      if (reopenedEpoch !== undefined && reopenedEpoch > epoch) {
        epoch = reopenedEpoch;
      }
    }
  } catch {
    // A new run has no reopen record. Read failures are surfaced when the
    // terminal append itself tries to commit; epoch 1 is the only safe default.
  }
  return epoch;
}

export {
  historyEpochFromRollout,
  findPersistedMessageSubmission,
  currentRunEpochFromRollout,
};
