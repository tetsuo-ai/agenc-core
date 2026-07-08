/**
 * Trajectory curation — turns the redacted JSONL files written by the
 * opt-in trajectory export sink (`trajectory-export.ts`) into training
 * data.
 *
 * Input contract: each line is a `TrajectoryExportRecord`
 * (`{schemaVersion, exportedAtUnixMs, sessionId, rolloutPath, item}`)
 * whose `item` is one redacted `RolloutItem`. Records for multiple
 * sessions may share a file (the `AGENC_TRAJECTORY_EXPORT_PATH` mode
 * appends every session to one file), so grouping is by `sessionId`,
 * never by file.
 *
 * Curation is pure local file processing:
 *   - **Filter** — keep only trajectories that finished at least one
 *     turn (`turn_complete`), hit no terminal `error` event, were never
 *     aborted/interrupted (`turn_aborted` covers Esc/cancel), and carry
 *     no user tool-use rejection markers. Transient `stream_error`
 *     events do NOT exclude a trajectory: when the provider hiccup is
 *     fatal the runtime follows up with `error`/`turn_aborted`, which
 *     do.
 *   - **Redact** — every emitted row is passed through the same
 *     `redactSecretsInValue` the export sink already applies at write
 *     time (belt and suspenders for files produced by older builds).
 *   - **Emit** — `sft` chat-format rows (one conversation per kept
 *     session, reduced through the canonical event-log reducer so
 *     compaction and rollbacks apply exactly as the model saw them) or
 *     `dpo` preference pairs derived from `thread_rolled_back`
 *     regenerations (see `buildDpoPairs`).
 *
 * There is no `--require-eval-passed` style filter: neither
 * `TrajectoryExportRecord` nor any `RolloutItem` variant carries an
 * evaluation outcome, so such a flag would have nothing to read.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { redactSecretsInValue } from "../secrets/index.js";
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from "../utils/messages.js";
import {
  isPermissionDeniedToolResult,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGE,
} from "../tui/tool-result-denial.js";
import { emptyReducedState, reduce } from "./event-log-reducer.js";
import {
  parseRolloutLine,
  type ResponseItem,
  type RolloutItem,
} from "./rollout-item.js";
import { isUserTurnBoundary } from "./rollout-reconstruction.js";
import { TRAJECTORY_EXPORT_SCHEMA_VERSION } from "./trajectory-export.js";

// ─────────────────────────────────────────────────────────────────────
// Reading + grouping export records
// ─────────────────────────────────────────────────────────────────────

export interface ParsedTrajectoryExports {
  /** Rollout items grouped by sessionId, in file/line order. */
  readonly sessions: ReadonlyMap<string, readonly RolloutItem[]>;
  /** Lines that parsed as valid export records. */
  readonly recordCount: number;
  /** Non-blank lines that failed to parse as export records. */
  readonly malformedLineCount: number;
  /** Records whose schemaVersion is not the supported one. */
  readonly unsupportedSchemaCount: number;
}

/**
 * List the `.jsonl` files the export sink writes under a directory
 * (sorted for deterministic output). A path pointing at a single file
 * is returned as-is so `AGENC_TRAJECTORY_EXPORT_PATH` mode works too.
 */
export function listTrajectoryExportFiles(path: string): string[] {
  const resolved = resolve(path);
  if (statSync(resolved).isDirectory()) {
    return readdirSync(resolved)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(resolved, name));
  }
  return [resolved];
}

/**
 * Parse the raw contents of one or more export files into per-session
 * rollout-item streams. Malformed lines and unsupported schema versions
 * are counted, never thrown — curation over a partially corrupt export
 * dir should salvage what it can.
 */
export function parseTrajectoryExportContents(
  contents: readonly string[],
): ParsedTrajectoryExports {
  const sessions = new Map<string, RolloutItem[]>();
  let recordCount = 0;
  let malformedLineCount = 0;
  let unsupportedSchemaCount = 0;

  for (const content of contents) {
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        malformedLineCount += 1;
        continue;
      }
      if (
        record === null ||
        typeof record !== "object" ||
        typeof (record as { sessionId?: unknown }).sessionId !== "string" ||
        (record as { item?: unknown }).item === undefined
      ) {
        malformedLineCount += 1;
        continue;
      }
      const { schemaVersion, sessionId, item } = record as {
        schemaVersion?: unknown;
        sessionId: string;
        item: unknown;
      };
      if (schemaVersion !== TRAJECTORY_EXPORT_SCHEMA_VERSION) {
        unsupportedSchemaCount += 1;
        continue;
      }
      // Route the embedded item through the canonical rollout parser so
      // legacy type aliases and the unknown-variant shim apply exactly
      // as they do on rollout replay.
      let parsedItem: RolloutItem | null;
      try {
        parsedItem = parseRolloutLine(JSON.stringify(item));
      } catch {
        malformedLineCount += 1;
        continue;
      }
      if (parsedItem === null) {
        malformedLineCount += 1;
        continue;
      }
      recordCount += 1;
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.push(parsedItem);
      } else {
        sessions.set(sessionId, [parsedItem]);
      }
    }
  }

  return { sessions, recordCount, malformedLineCount, unsupportedSchemaCount };
}

/** Convenience: read + parse every export file under `path`. */
export function readTrajectoryExports(path: string): ParsedTrajectoryExports {
  const contents = listTrajectoryExportFiles(path).map((file) =>
    readFileSync(file, "utf8"),
  );
  return parseTrajectoryExportContents(contents);
}

// ─────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────

export interface TrajectoryClassification {
  /** At least one turn ran to completion. */
  readonly hasTurnComplete: boolean;
  /** A terminal `error` event was recorded (stream_error does not count). */
  readonly hasErrorEvent: boolean;
  /** Any turn was aborted (user interrupt, cancel, terminal abort). */
  readonly hasTurnAborted: boolean;
  /** The user rewound the thread (`thread_rolled_back`). */
  readonly hasThreadRollback: boolean;
  /** A persisted message carries a user interrupt/rejection marker. */
  readonly hasUserRejection: boolean;
}

const USER_REJECTION_MARKERS: readonly string[] = Object.freeze([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGE,
]);

/** Flatten a ResponseItem content field to plain text. */
export function responseItemText(content: ResponseItem["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function responseItemCarriesRejection(item: ResponseItem): boolean {
  const text = responseItemText(item.content);
  if (USER_REJECTION_MARKERS.some((marker) => text.includes(marker))) {
    return true;
  }
  // Tool results produced by a permission denial ("Rejected by user"
  // payload shapes) — reuse the transcript-layer detector.
  if (item.role === "tool" || item.toolCallId !== undefined) {
    return isPermissionDeniedToolResult(text);
  }
  return false;
}

/** Derive the filter signals for one session's exported item stream. */
export function classifyTrajectory(
  items: readonly RolloutItem[],
): TrajectoryClassification {
  let hasTurnComplete = false;
  let hasErrorEvent = false;
  let hasTurnAborted = false;
  let hasThreadRollback = false;
  let hasUserRejection = false;

  for (const item of items) {
    if (item.type === "response_item") {
      if (!hasUserRejection && responseItemCarriesRejection(item.payload)) {
        hasUserRejection = true;
      }
      continue;
    }
    if (item.type !== "event_msg") continue;
    switch (item.payload.msg.type) {
      case "turn_complete":
        hasTurnComplete = true;
        break;
      case "error":
        hasErrorEvent = true;
        break;
      case "turn_aborted":
        hasTurnAborted = true;
        break;
      case "thread_rolled_back":
        hasThreadRollback = true;
        break;
      default:
        break;
    }
  }

  return {
    hasTurnComplete,
    hasErrorEvent,
    hasTurnAborted,
    hasThreadRollback,
    hasUserRejection,
  };
}

/**
 * SFT keeps only fully clean trajectories: completed, no error, no
 * abort/interrupt, no rejection markers, and no thread rollback (a
 * rollback is an explicit user rejection of part of the trajectory —
 * those sessions feed the DPO path instead).
 */
export function isSftEligible(c: TrajectoryClassification): boolean {
  return (
    c.hasTurnComplete &&
    !c.hasErrorEvent &&
    !c.hasTurnAborted &&
    !c.hasThreadRollback &&
    !c.hasUserRejection
  );
}

/**
 * DPO requires a completed, error-free, uninterrupted session that
 * contains at least one rollback (the preference signal source).
 */
export function isDpoEligible(c: TrajectoryClassification): boolean {
  return (
    c.hasTurnComplete &&
    !c.hasErrorEvent &&
    !c.hasTurnAborted &&
    c.hasThreadRollback
  );
}

// ─────────────────────────────────────────────────────────────────────
// Chat-schema mapping
// ─────────────────────────────────────────────────────────────────────

export interface CuratedChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface CuratedChatMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_calls?: readonly CuratedChatToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

/** One SFT JSONL row: a whole conversation in standard chat schema. */
export interface SftExample {
  readonly messages: readonly CuratedChatMessage[];
  readonly meta: { readonly sessionId: string };
}

/** One DPO JSONL row: shared prompt + preferred/rejected continuations. */
export interface DpoPair {
  readonly prompt: readonly CuratedChatMessage[];
  readonly chosen: readonly CuratedChatMessage[];
  readonly rejected: readonly CuratedChatMessage[];
  readonly meta: { readonly sessionId: string };
}

export function toChatMessage(item: ResponseItem): CuratedChatMessage {
  return {
    role: item.role,
    content: responseItemText(item.content),
    ...(item.toolCalls !== undefined && item.toolCalls.length > 0
      ? {
          tool_calls: item.toolCalls.map(
            (call): CuratedChatToolCall => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments ?? "" },
            }),
          ),
        }
      : {}),
    ...(item.toolCallId !== undefined ? { tool_call_id: item.toolCallId } : {}),
    ...(item.toolName !== undefined ? { name: item.toolName } : {}),
  };
}

/**
 * Fold a session's item stream through the canonical event-log reducer
 * so compaction replacement histories and rollback trims apply exactly
 * as during live replay, then return the final message history.
 */
export function reduceTrajectoryHistory(
  items: readonly RolloutItem[],
): ResponseItem[] {
  let state = emptyReducedState();
  for (const item of items) {
    state = reduce(state, item).state;
  }
  return state.history;
}

// ─────────────────────────────────────────────────────────────────────
// SFT emission
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the SFT chat example for one kept session, or null when the
 * reduced history has nothing trainable (no user message or no
 * assistant message).
 */
export function buildSftExample(
  sessionId: string,
  items: readonly RolloutItem[],
): SftExample | null {
  const history = reduceTrajectoryHistory(items);
  const hasUser = history.some((item) => item.role === "user");
  const hasAssistant = history.some((item) => item.role === "assistant");
  if (!hasUser || !hasAssistant) return null;
  return {
    messages: history.map(toChatMessage),
    meta: { sessionId },
  };
}

// ─────────────────────────────────────────────────────────────────────
// DPO emission
// ─────────────────────────────────────────────────────────────────────

export interface DpoDerivation {
  readonly pairs: readonly DpoPair[];
  /** Total thread_rolled_back events observed across the session. */
  readonly rollbackCount: number;
}

interface RollbackCandidate {
  /** History prefix surviving the rollback (deep snapshot). */
  readonly prefix: readonly ResponseItem[];
  /** Items the rollback discarded (the rejected continuation). */
  readonly rejected: readonly ResponseItem[];
}

function firstUserBoundaryIndex(
  history: readonly ResponseItem[],
  from: number,
): number {
  for (let i = from; i < history.length; i += 1) {
    const item = history[i];
    if (item && isUserTurnBoundary(item)) return i;
  }
  return -1;
}

/**
 * Continuation slice for a preference pair: the assistant/tool messages
 * that follow the shared prompt, ending at the next user-turn boundary.
 */
function continuationAfter(
  history: readonly ResponseItem[],
  promptIndex: number,
): ResponseItem[] {
  const out: ResponseItem[] = [];
  for (let i = promptIndex + 1; i < history.length; i += 1) {
    const item = history[i];
    if (!item) continue;
    if (isUserTurnBoundary(item)) break;
    if (item.role === "assistant" || item.role === "tool") out.push(item);
  }
  return out;
}

function sameHistoryPrefix(
  a: readonly ResponseItem[],
  b: readonly ResponseItem[],
): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Derive preference pairs from `thread_rolled_back` regenerations —
 * the one honest preference signal this record format carries.
 *
 * When the user rewinds N turns and re-prompts, the append-only export
 * stream keeps both continuations: the discarded one (rejected by the
 * rewind) and the one the session actually kept. A pair is emitted only
 * when the evidence genuinely supports "same prompt, one continuation
 * rejected, one kept":
 *
 *   1. the rollback's surviving prefix is byte-identical in the final
 *      reduced history (no later rollback/compaction rewrote it),
 *   2. both the discarded slice and the kept continuation start with a
 *      user-turn-boundary message whose text is identical (a true
 *      regeneration — if the user re-prompted with different text there
 *      is no shared prompt and no pair), and
 *   3. both continuations contain at least one assistant message.
 *
 * Anything weaker is skipped rather than fabricated.
 */
export function buildDpoPairs(
  sessionId: string,
  items: readonly RolloutItem[],
): DpoDerivation {
  const candidates: RollbackCandidate[] = [];
  let rollbackCount = 0;

  let state = emptyReducedState();
  for (const item of items) {
    const isRollback =
      item.type === "event_msg" &&
      item.payload.msg.type === "thread_rolled_back";
    const before = isRollback ? state.history : undefined;
    state = reduce(state, item).state;
    if (isRollback && before !== undefined) {
      rollbackCount += 1;
      const prefix = state.history;
      candidates.push({
        prefix: [...prefix],
        rejected: before.slice(prefix.length),
      });
    }
  }

  const finalHistory = state.history;
  const pairs: DpoPair[] = [];

  for (const candidate of candidates) {
    // (1) prefix must have survived to the end of the session.
    if (finalHistory.length <= candidate.prefix.length) continue;
    if (
      !sameHistoryPrefix(
        candidate.prefix,
        finalHistory.slice(0, candidate.prefix.length),
      )
    ) {
      continue;
    }

    // (2) both sides must re-open with the same user prompt.
    const rejectedPromptIdx = firstUserBoundaryIndex(candidate.rejected, 0);
    const chosenPromptIdx = firstUserBoundaryIndex(
      finalHistory,
      candidate.prefix.length,
    );
    if (rejectedPromptIdx === -1 || chosenPromptIdx === -1) continue;
    const rejectedPrompt = candidate.rejected[rejectedPromptIdx]!;
    const chosenPrompt = finalHistory[chosenPromptIdx]!;
    if (
      responseItemText(rejectedPrompt.content) !==
      responseItemText(chosenPrompt.content)
    ) {
      continue;
    }

    // (3) both continuations must contain assistant output.
    const rejected = continuationAfter(candidate.rejected, rejectedPromptIdx);
    const chosen = continuationAfter(finalHistory, chosenPromptIdx);
    if (
      !rejected.some((item) => item.role === "assistant") ||
      !chosen.some((item) => item.role === "assistant")
    ) {
      continue;
    }

    pairs.push({
      prompt: [
        ...finalHistory.slice(0, candidate.prefix.length).map(toChatMessage),
        toChatMessage(chosenPrompt),
      ],
      chosen: chosen.map(toChatMessage),
      rejected: rejected.map(toChatMessage),
      meta: { sessionId },
    });
  }

  return { pairs, rollbackCount };
}

// ─────────────────────────────────────────────────────────────────────
// JSONL rendering
// ─────────────────────────────────────────────────────────────────────

/**
 * Render rows as JSONL, re-applying the export sink's redaction pass to
 * each row. The sink already redacts at write time; re-running the same
 * `redactSecretsInValue` here costs little and protects exports written
 * by older sinks or hand-assembled files.
 */
export function renderTrajectoryJsonl(rows: readonly unknown[]): string {
  return rows
    .map((row) => `${JSON.stringify(redactSecretsInValue(row))}\n`)
    .join("");
}
