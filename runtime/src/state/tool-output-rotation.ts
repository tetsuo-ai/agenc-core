import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { getAgencHomeDir } from "../session/session-store.js";
import { redactSecrets, redactSecretsInValue } from "../secrets/index.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import {
  checkUnknownOutcomeMutationGate,
  UnknownOutcomeMutationBlockedError,
  type UnresolvedUnknownOutcomeEffect,
} from "./unknown-outcome-gate.js";

export interface ToolOutputRotationPolicy {
  readonly outputPartialMaxBytes?: number;
  readonly logMaxBytes?: number;
  readonly rotatedLogCount?: number;
}

export interface RotatedToolOutput {
  readonly outputPartial: string | null;
  readonly outputLogPath?: string;
  readonly outputLogBytes: number;
}

export interface InFlightToolCallStartParams {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly startedAt: string;
  readonly recoveryCategory?: ToolRecoveryCategory;
  readonly agencHome?: string;
  readonly outputRotation?: ToolOutputRotationPolicy;
  /**
   * Unknown-outcome mutation gate mode (default `"enforce"`). While the
   * session has unresolved `poisoned` effects, recording a NEW
   * side-effecting call throws {@link UnknownOutcomeMutationBlockedError}
   * under `"enforce"`. The daemon's post-dispatch snapshot observer passes
   * `"flag"` — it records reality (the tool is already running) but the
   * returned violation is persisted into the session snapshot rather than
   * silently discarded. `"flag"` is for observers only; admission and
   * direct writers keep the fail-closed default.
   */
  readonly unknownOutcomeGate?: "enforce" | "flag";
}

export interface InFlightToolCallStartOutcome {
  /** Present when the gate was violated in `"flag"` mode. */
  readonly gateViolation?: {
    readonly blocking: readonly UnresolvedUnknownOutcomeEffect[];
  };
}

export interface InFlightToolCallCompletionParams {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly result: unknown;
  readonly isError: boolean;
  readonly completedAt: string;
  readonly recoveryCategory?: ToolRecoveryCategory;
  readonly agencHome?: string;
  readonly outputRotation?: ToolOutputRotationPolicy;
}

export interface InFlightToolCallProgressParams {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly chunk: unknown;
  readonly observedAt: string;
  readonly recoveryCategory?: ToolRecoveryCategory;
  readonly agencHome?: string;
  readonly outputRotation?: ToolOutputRotationPolicy;
}

export interface InFlightToolCallUnknownOutcomeParams {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly observedAt: string;
  readonly recoveryCategory: Exclude<ToolRecoveryCategory, "idempotent">;
}

const DEFAULT_TOOL_OUTPUT_ROTATION_POLICY = Object.freeze({
  outputPartialMaxBytes: 32_768,
  logMaxBytes: 1_048_576,
  rotatedLogCount: 4,
} satisfies Required<ToolOutputRotationPolicy>);

const DEFAULT_TOOL_RECOVERY_CATEGORY: ToolRecoveryCategory =
  "side-effecting";

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export function recordInFlightToolCallStart(
  driver: StateSqliteDriver,
  params: InFlightToolCallStartParams,
): InFlightToolCallStartOutcome {
  const recoveryCategory = normalizeToolRecoveryCategory(
    params.recoveryCategory,
  );
  const gate = checkUnknownOutcomeMutationGate(driver, {
    sessionId: params.sessionId,
    recoveryCategory,
  });
  if (!gate.allowed && (params.unknownOutcomeGate ?? "enforce") === "enforce") {
    throw new UnknownOutcomeMutationBlockedError(
      params.sessionId,
      gate.blocking,
    );
  }
  const outputLogPath = resolveToolOutputLogPath({
    agencHome: params.agencHome,
    agentId: params.agentId ?? params.sessionId,
    toolCallId: params.toolCallId,
  });
  removeRotatedToolOutputLog(outputLogPath, params.outputRotation);
  driver
    .prepareState<
      [string, string, string, string, string, null, null, number, string, string]
    >(
      `INSERT INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        output_partial,
        output_log_path,
        output_log_bytes,
        started_at,
        recovery_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, tool_call_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        args_json = excluded.args_json,
        status = excluded.status,
        output_partial = excluded.output_partial,
        output_log_path = excluded.output_log_path,
        output_log_bytes = excluded.output_log_bytes,
        started_at = excluded.started_at,
        recovery_category = excluded.recovery_category
      WHERE in_flight_tool_calls.status NOT IN ('poisoned', 'unknown_resolved')`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName,
      stringifyForSql(params.args),
      "running",
      null,
      null,
      0,
      params.startedAt,
      recoveryCategory,
    );
  return gate.allowed ? {} : { gateViolation: { blocking: gate.blocking } };
}

export function recordInFlightToolCallProgress(
  driver: StateSqliteDriver,
  params: InFlightToolCallProgressParams,
): void {
  const policy = normalizeOutputRotationPolicy(params.outputRotation);
  const agentId = params.agentId ?? params.sessionId;
  let row = driver
    .prepareState<
      [string, string],
      {
        output_partial: string | null;
        output_log_path: string | null;
        output_log_bytes: number;
      }
    >(
      `SELECT output_partial, output_log_path, output_log_bytes
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(params.sessionId, params.toolCallId);
  if (row === undefined) {
    // Observer-context backfill for an orphan (already-running) call: like
    // the snapshot observer it records reality, so the unknown-outcome gate
    // must flag rather than throw — an enforce throw here would leave the
    // running call crash-invisible in exactly the sessions already holding
    // an unresolved effect.
    recordInFlightToolCallStart(driver, {
      sessionId: params.sessionId,
      agentId,
      toolCallId: params.toolCallId,
      toolName: params.toolName ?? "unknown",
      args: null,
      startedAt: params.observedAt,
      recoveryCategory: params.recoveryCategory,
      agencHome: params.agencHome,
      outputRotation: params.outputRotation,
      unknownOutcomeGate: "flag",
    });
    row = {
      output_partial: null,
      output_log_path: null,
      output_log_bytes: 0,
    };
  }

  const appended = appendOutputChunkForState({
    agencHome: params.agencHome,
    agentId,
    toolCallId: params.toolCallId,
    existingPartial: row.output_partial,
    existingOutputLogPath: row.output_log_path,
    chunk: stringifyToolOutput(params.chunk),
    policy,
  });
  driver
    .prepareState<
      [string | null, string | null, number, string | null, string, string]
    >(
      `UPDATE in_flight_tool_calls
       SET output_partial = ?,
           output_log_path = ?,
           output_log_bytes = ?,
           recovery_category = COALESCE(?, recovery_category)
       WHERE session_id = ?
         AND tool_call_id = ?
         AND status NOT IN ('poisoned', 'unknown_resolved')`,
    )
    .run(
      appended.outputPartial,
      appended.outputLogPath ?? null,
      appended.outputLogBytes,
      params.recoveryCategory !== undefined
        ? normalizeToolRecoveryCategory(params.recoveryCategory)
        : null,
      params.sessionId,
      params.toolCallId,
    );
}

export function recordInFlightToolCallCompletion(
  driver: StateSqliteDriver,
  params: InFlightToolCallCompletionParams,
): void {
  const rotated = rotateToolOutputForState({
    agencHome: params.agencHome,
    agentId: params.agentId ?? params.sessionId,
    toolCallId: params.toolCallId,
    output: stringifyToolOutput(params.result),
    outputRotation: params.outputRotation,
  });
  const status = params.isError ? "failed" : "completed";
  const update = driver
    .prepareState<
      [string, string | null, string | null, number, string | null, string, string]
    >(
      // A poisoned (unknown-outcome) row is review-locked: recovery only
      // poisons calls whose execution the crash killed, so a "completion"
      // arriving afterwards is a stale/duplicate/replayed event, not a
      // trustworthy acknowledgement — it must not silently lift the review
      // gate. unknown_resolved is terminal by review and equally immutable.
      `UPDATE in_flight_tool_calls
       SET status = ?,
           output_partial = ?,
           output_log_path = ?,
           output_log_bytes = ?,
           recovery_category = COALESCE(?, recovery_category)
       WHERE session_id = ?
         AND tool_call_id = ?
         AND status NOT IN ('poisoned', 'unknown_resolved')`,
    )
    .run(
      status,
      rotated.outputPartial,
      rotated.outputLogPath ?? null,
      rotated.outputLogBytes,
      params.recoveryCategory !== undefined
        ? normalizeToolRecoveryCategory(params.recoveryCategory)
        : null,
      params.sessionId,
      params.toolCallId,
    );
  if (update.changes > 0) return;
  // OR IGNORE: zero changes can now also mean "row exists but is
  // review-locked (poisoned/unknown_resolved)" — the completion is dropped
  // rather than resurrecting or duplicating the locked row.
  driver
    .prepareState<
      [string, string, string, string, string, string | null, string | null, number, string, string]
    >(
      `INSERT OR IGNORE INTO in_flight_tool_calls (
        session_id,
        tool_call_id,
        tool_name,
        args_json,
        status,
        output_partial,
        output_log_path,
        output_log_bytes,
        started_at,
        recovery_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName ?? "unknown",
      "null",
      status,
      rotated.outputPartial,
      rotated.outputLogPath ?? null,
      rotated.outputLogBytes,
      params.completedAt,
      normalizeToolRecoveryCategory(params.recoveryCategory),
    );
}

/**
 * Project a canonical effect_unknown_outcome event into the existing recovery
 * gate. The journal event is the authority; this row is the restart/query
 * index used to block dependent side-effecting calls until explicit review.
 */
export function recordInFlightToolCallUnknownOutcome(
  driver: StateSqliteDriver,
  params: InFlightToolCallUnknownOutcomeParams,
): void {
  const update = driver
    .prepareState<[string, string, string]>(
      `UPDATE in_flight_tool_calls
       SET status = 'poisoned', recovery_category = ?
       WHERE session_id = ? AND tool_call_id = ?
         AND status <> 'unknown_resolved'`,
    )
    .run(
      params.recoveryCategory,
      params.sessionId,
      params.toolCallId,
    );
  if (update.changes > 0) return;
  driver
    .prepareState<
      [string, string, string, string, string, null, null, number, string, string]
    >(
      `INSERT OR IGNORE INTO in_flight_tool_calls (
        session_id, tool_call_id, tool_name, args_json, status,
        output_partial, output_log_path, output_log_bytes, started_at,
        recovery_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.toolCallId,
      params.toolName,
      "null",
      "poisoned",
      null,
      null,
      0,
      params.observedAt,
      params.recoveryCategory,
    );
}

export function rotateToolOutputForState(params: {
  readonly agencHome?: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly output: string;
  readonly outputRotation?: ToolOutputRotationPolicy;
}): RotatedToolOutput {
  const policy = normalizeOutputRotationPolicy(params.outputRotation);
  const output = Buffer.from(params.output, "utf8");
  const prefix = utf8Prefix(output, policy.outputPartialMaxBytes);
  const outputLogPath = resolveToolOutputLogPath(params);
  removeRotatedToolOutputLog(outputLogPath, policy);
  if (prefix.bytes >= output.length) {
    return {
      outputPartial: prefix.text.length === 0 ? null : prefix.text,
      outputLogBytes: 0,
    };
  }
  const retainedOverflow = retainedOverflowForRotatedLogs(
    output.subarray(prefix.bytes),
    policy,
  );
  writeRotatedToolOutputLog(
    outputLogPath,
    retainedOverflow,
    policy,
  );
  return {
    outputPartial: prefix.text.length === 0 ? null : prefix.text,
    outputLogPath,
    outputLogBytes: retainedRotatedLogBytes(outputLogPath, policy),
  };
}

export function resolveToolOutputLogPath(params: {
  readonly agencHome?: string;
  readonly agentId: string;
  readonly toolCallId: string;
}): string {
  return join(
    getAgencHomeDir(params.agencHome),
    "agent-logs",
    safeLogPathSegment(params.agentId),
    `${safeLogPathSegment(params.toolCallId)}.log`,
  );
}

export function readRotatedToolOutputLog(
  outputLogPath: string,
  outputRotation?: ToolOutputRotationPolicy,
): string {
  const policy = normalizeOutputRotationPolicy(outputRotation);
  const buffers: Buffer[] = [];
  for (let index = policy.rotatedLogCount; index >= 1; index -= 1) {
    const path = `${outputLogPath}.${index}`;
    if (existsSync(path)) buffers.push(readFileSync(path));
  }
  if (existsSync(outputLogPath)) buffers.push(readFileSync(outputLogPath));
  return Buffer.concat(buffers).toString("utf8");
}

function normalizeOutputRotationPolicy(
  policy: ToolOutputRotationPolicy | undefined,
): Required<ToolOutputRotationPolicy> {
  return {
    outputPartialMaxBytes: nonNegativeInteger(
      policy?.outputPartialMaxBytes,
      DEFAULT_TOOL_OUTPUT_ROTATION_POLICY.outputPartialMaxBytes,
    ),
    logMaxBytes: positiveInteger(
      policy?.logMaxBytes,
      DEFAULT_TOOL_OUTPUT_ROTATION_POLICY.logMaxBytes,
    ),
    rotatedLogCount: nonNegativeInteger(
      policy?.rotatedLogCount,
      DEFAULT_TOOL_OUTPUT_ROTATION_POLICY.rotatedLogCount,
    ),
  };
}

export function normalizeToolRecoveryCategory(
  category: ToolRecoveryCategory | string | undefined,
): ToolRecoveryCategory {
  switch (category) {
    case "idempotent":
    case "side-effecting":
    case "interactive":
      return category;
    default:
      return DEFAULT_TOOL_RECOVERY_CATEGORY;
  }
}

function retainedOverflowForRotatedLogs(
  overflow: Buffer,
  policy: Required<ToolOutputRotationPolicy>,
): Buffer {
  const retainedCapacity = Math.min(
    overflow.length,
    policy.logMaxBytes * (policy.rotatedLogCount + 1),
  );
  return utf8Tail(overflow, retainedCapacity);
}

function appendOutputChunkForState(params: {
  readonly agencHome?: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly existingPartial: string | null;
  readonly existingOutputLogPath: string | null;
  readonly chunk: string;
  readonly policy: Required<ToolOutputRotationPolicy>;
}): RotatedToolOutput {
  const currentPartial = Buffer.from(params.existingPartial ?? "", "utf8");
  const chunk = Buffer.from(params.chunk, "utf8");
  const normalizedPartial = utf8Prefix(
    currentPartial,
    params.policy.outputPartialMaxBytes,
  );
  const partialParts = [Buffer.from(normalizedPartial.text, "utf8")];
  const overflowParts: Buffer[] = [];
  if (normalizedPartial.bytes < currentPartial.length) {
    overflowParts.push(currentPartial.subarray(normalizedPartial.bytes));
  }
  const partialBytes = Buffer.byteLength(normalizedPartial.text, "utf8");
  const room = Math.max(0, params.policy.outputPartialMaxBytes - partialBytes);
  const chunkPrefix = utf8Prefix(chunk, room);
  if (chunkPrefix.bytes > 0) {
    partialParts.push(Buffer.from(chunkPrefix.text, "utf8"));
  }
  if (chunkPrefix.bytes < chunk.length) {
    overflowParts.push(chunk.subarray(chunkPrefix.bytes));
  }

  const outputPartial = Buffer.concat(partialParts).toString("utf8");
  const overflow = Buffer.concat(overflowParts);
  if (overflow.length === 0) {
    return {
      outputPartial: outputPartial.length === 0 ? null : outputPartial,
      ...(params.existingOutputLogPath !== null
        ? { outputLogPath: params.existingOutputLogPath }
        : {}),
      outputLogBytes:
        params.existingOutputLogPath === null
          ? 0
          : retainedRotatedLogBytes(params.existingOutputLogPath, params.policy),
    };
  }

  const outputLogPath =
    params.existingOutputLogPath ??
    resolveToolOutputLogPath({
      agencHome: params.agencHome,
      agentId: params.agentId,
      toolCallId: params.toolCallId,
    });
  appendRetainedToolOutputLog(outputLogPath, overflow, params.policy);
  return {
    outputPartial: outputPartial.length === 0 ? null : outputPartial,
    outputLogPath,
    outputLogBytes: retainedRotatedLogBytes(outputLogPath, params.policy),
  };
}

function appendRetainedToolOutputLog(
  outputLogPath: string,
  output: Buffer,
  policy: Required<ToolOutputRotationPolicy>,
): void {
  const retained = retainedOverflowForRotatedLogs(output, policy);
  if (retained.length < output.length) {
    removeRotatedToolOutputLog(outputLogPath, policy);
  }
  writeRotatedToolOutputLog(outputLogPath, retained, policy);
}

function writeRotatedToolOutputLog(
  outputLogPath: string,
  output: Buffer,
  policy: Required<ToolOutputRotationPolicy>,
): void {
  mkdirSync(dirname(outputLogPath), { recursive: true, mode: 0o700 });
  let offset = 0;
  while (offset < output.length) {
    const currentBytes = existingFileBytes(outputLogPath);
    if (currentBytes >= policy.logMaxBytes) {
      rotateExistingLog(outputLogPath, policy.rotatedLogCount);
      continue;
    }
    const room = policy.logMaxBytes - currentBytes;
    const chunkSize = Math.min(room, output.length - offset);
    appendFileSync(outputLogPath, output.subarray(offset, offset + chunkSize), {
      mode: 0o600,
    });
    offset += chunkSize;
    if (offset < output.length) {
      rotateExistingLog(outputLogPath, policy.rotatedLogCount);
    }
  }
}

function rotateExistingLog(outputLogPath: string, rotatedLogCount: number): void {
  if (!existsSync(outputLogPath)) return;
  if (rotatedLogCount === 0) {
    rmSync(outputLogPath, { force: true });
    return;
  }
  rmSync(`${outputLogPath}.${rotatedLogCount}`, { force: true });
  for (let index = rotatedLogCount - 1; index >= 1; index -= 1) {
    const source = `${outputLogPath}.${index}`;
    if (existsSync(source)) renameSync(source, `${outputLogPath}.${index + 1}`);
  }
  renameSync(outputLogPath, `${outputLogPath}.1`);
}

function removeRotatedToolOutputLog(
  outputLogPath: string,
  outputRotation: ToolOutputRotationPolicy | undefined,
): void {
  const policy = normalizeOutputRotationPolicy(outputRotation);
  rmSync(outputLogPath, { force: true });
  for (let index = 1; index <= policy.rotatedLogCount; index += 1) {
    rmSync(`${outputLogPath}.${index}`, { force: true });
  }
}

function retainedRotatedLogBytes(
  outputLogPath: string,
  policy: Required<ToolOutputRotationPolicy>,
): number {
  let bytes = existingFileBytes(outputLogPath);
  for (let index = 1; index <= policy.rotatedLogCount; index += 1) {
    bytes += existingFileBytes(`${outputLogPath}.${index}`);
  }
  return bytes;
}

function existingFileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function utf8Prefix(buffer: Buffer, maxBytes: number): {
  readonly text: string;
  readonly bytes: number;
} {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0) {
    try {
      return {
        text: UTF8_FATAL_DECODER.decode(buffer.subarray(0, end)),
        bytes: end,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", bytes: 0 };
}

function utf8Tail(buffer: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length) {
    try {
      UTF8_FATAL_DECODER.decode(buffer.subarray(start));
      return buffer.subarray(start);
    } catch {
      start += 1;
    }
  }
  return Buffer.alloc(0);
}

function stringifyForSql(value: unknown): string {
  const serialized = JSON.stringify(redactSecretsInValue(value ?? null));
  return serialized === undefined ? "null" : serialized;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return redactSecrets(value);
  const serialized = JSON.stringify(redactSecretsInValue(value));
  return serialized === undefined ? String(value ?? "") : serialized;
}

function safeLogPathSegment(value: string): string {
  if (
    value !== "." &&
    value !== ".." &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(value)
  ) {
    return value;
  }
  const safe = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const prefix = safe.length > 0 && !/^\.+$/.test(safe) ? safe : "unknown";
  return `${prefix}-${hash}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
