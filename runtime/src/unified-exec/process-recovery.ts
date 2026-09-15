import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readExecutionEnvironmentBinding } from "../execution/binding.js";
import { validateExecutionIdentity, validExecutionOwner } from "../execution/identity.js";
import { ExecutionEnvironmentError, type ExecutionEnvironmentBinding, type ExecutionOperationIdentity,
  type ExecutionProcessSpecification } from "../execution/types.js";
import { RecoverableUtf8Decoder } from "./recoverable-utf8-decoder.js";

export interface ProcessOutputCursor {
  /** Opaque host file position; non-terminal Docker headers also occupy bytes. */
  readonly offset: number;
  readonly stdoutCarry: string;
  readonly stderrCarry: string;
  readonly outputBytes: number;
  readonly outputTail: string;
}

export interface ProcessRecoveryFailure {
  readonly code: string;
  readonly message: string;
  readonly requestSent: boolean;
}

/** Only acknowledged, still-pollable handles. Supervisor output remains there. */
export interface ManagedProcessRecoveryEntry {
  readonly sessionId: number;
  readonly operationId: string;
  readonly identity: ExecutionOperationIdentity;
  readonly specificationDigest: string;
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly startedAt: number;
  readonly timeoutAt?: number;
  readonly stopped: boolean;
  readonly timedOut: boolean;
  readonly failure?: ProcessRecoveryFailure;
  /** Last output delivered at the caller's canonical checkpoint boundary. */
  readonly delivered: ProcessOutputCursor;
}

export interface ExecutionProcessRecoveryState {
  readonly version: 1;
  readonly binding: Extract<ExecutionEnvironmentBinding, { kind: "docker" }>;
  readonly ownerId: string;
  readonly authorityRevision: number;
  readonly admission: "open" | "paused" | "closed";
  readonly failure?: ProcessRecoveryFailure;
  readonly entries: readonly ManagedProcessRecoveryEntry[];
}

export function executionSpecificationDigest(spec: ExecutionProcessSpecification): string {
  return createHash("sha256").update(JSON.stringify(["agenc.execution-specification.v1", spec.program, spec.argv,
    spec.argv0 ?? null, spec.cwd, Object.keys(spec.environment).sort().map((key) => [key, spec.environment[key]]),
    spec.terminal, spec.lifetime])).digest("hex");
}

export function processRecoveryFailure(error: Error): ProcessRecoveryFailure {
  return Object.freeze({ code: error instanceof ExecutionEnvironmentError ? error.code : "execution_failed",
    message: error.message, requestSent: error instanceof ExecutionEnvironmentError ? error.requestSent : true });
}

function invalid(): never {
  throw new ExecutionEnvironmentError("invalid_process_recovery", "Invalid managed process recovery state", false);
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(row, key)) ||
      Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function failure(value: unknown): ProcessRecoveryFailure {
  const row = object(value, ["code", "message", "requestSent"]);
  if (typeof row.code !== "string" || !row.code || typeof row.message !== "string" || typeof row.requestSent !== "boolean") invalid();
  return Object.freeze({ code: row.code, message: row.message, requestSent: row.requestSent });
}

/** Strict, copied data before any asynchronous lookup or recovery dispatch. */
export function readExecutionProcessRecoveryState(value: unknown): ExecutionProcessRecoveryState {
  const row = object(value, ["version", "binding", "ownerId", "authorityRevision", "admission", "entries"], ["failure"]);
  const binding = readExecutionEnvironmentBinding(row.binding);
  if (row.version !== 1 || binding.kind !== "docker" || typeof row.ownerId !== "string" || !validExecutionOwner(row.ownerId) ||
      !integer(row.authorityRevision) || !["open", "paused", "closed"].includes(row.admission as string) || !Array.isArray(row.entries)) invalid();
  const failed = Object.hasOwn(row, "failure") ? failure(row.failure) : undefined;
  if (failed && row.admission !== "closed") invalid();
  const handles = new Set<number>(), operations = new Set<string>(), tasks = new Set<string>(), identities = new Set<string>();
  const entries = row.entries.map((value): ManagedProcessRecoveryEntry => {
    const entry = object(value, ["sessionId", "operationId", "identity", "specificationDigest", "taskId", "command", "cwd",
      "tty", "startedAt", "stopped", "timedOut", "delivered"], ["failure", "timeoutAt"]);
    const identity = object(entry.identity, ["runId", "callId", "attempt"], ["operationIndex"]);
    validateExecutionIdentity(identity as unknown as ExecutionOperationIdentity);
    const coordinate = Object.freeze({ runId: identity.runId as string, callId: identity.callId as string,
      attempt: identity.attempt as number, operationIndex: (identity.operationIndex ?? 0) as number });
    const key = JSON.stringify([coordinate.runId, coordinate.callId, coordinate.attempt, coordinate.operationIndex]);
    if (!integer(entry.sessionId) || entry.sessionId < 1 || typeof entry.operationId !== "string" || !/^[a-f0-9]{32}$/.test(entry.operationId) ||
        typeof entry.specificationDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.specificationDigest) ||
        typeof entry.taskId !== "string" || !/^[a-f0-9-]{36}$/.test(entry.taskId) ||
        typeof entry.command !== "string" || !entry.command.trim() || typeof entry.cwd !== "string" ||
        !posix.isAbsolute(entry.cwd) || entry.cwd.includes("\0") || typeof entry.tty !== "boolean" ||
        !integer(entry.startedAt) || typeof entry.stopped !== "boolean" || typeof entry.timedOut !== "boolean" ||
        (Object.hasOwn(entry, "timeoutAt") && (!integer(entry.timeoutAt) || entry.timeoutAt < entry.startedAt)) ||
        handles.has(entry.sessionId) || operations.has(entry.operationId) || tasks.has(entry.taskId) || identities.has(key)) invalid();
    handles.add(entry.sessionId); operations.add(entry.operationId); tasks.add(entry.taskId); identities.add(key);
    const cursor = object(entry.delivered, ["offset", "stdoutCarry", "stderrCarry", "outputBytes", "outputTail"]);
    if (!integer(cursor.offset) || !integer(cursor.outputBytes) || typeof cursor.outputTail !== "string" || cursor.outputTail.length > 8192 ||
        typeof cursor.stdoutCarry !== "string" || typeof cursor.stderrCarry !== "string") invalid();
    try { new RecoverableUtf8Decoder(cursor.stdoutCarry); new RecoverableUtf8Decoder(cursor.stderrCarry); }
    catch { invalid(); }
    if (Buffer.from(cursor.stdoutCarry, "base64").length + Buffer.from(cursor.stderrCarry, "base64").length > cursor.offset) invalid();
    return Object.freeze({ sessionId: entry.sessionId, operationId: entry.operationId, identity: coordinate,
      specificationDigest: entry.specificationDigest, taskId: entry.taskId, command: entry.command, cwd: entry.cwd,
      tty: entry.tty, startedAt: entry.startedAt, stopped: entry.stopped, timedOut: entry.timedOut,
      ...(entry.timeoutAt === undefined ? {} : { timeoutAt: entry.timeoutAt as number }),
      ...(Object.hasOwn(entry, "failure") ? { failure: failure(entry.failure) } : {}),
      delivered: Object.freeze({ offset: cursor.offset, stdoutCarry: cursor.stdoutCarry, stderrCarry: cursor.stderrCarry,
        outputBytes: cursor.outputBytes, outputTail: cursor.outputTail }) });
  });
  return Object.freeze({ version: 1, binding, ownerId: row.ownerId, authorityRevision: row.authorityRevision,
    admission: row.admission as ExecutionProcessRecoveryState["admission"], ...(failed ? { failure: failed } : {}),
    entries: Object.freeze(entries) });
}
