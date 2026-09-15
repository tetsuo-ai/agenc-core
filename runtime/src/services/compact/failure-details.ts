/**
 * Structured detail for a compaction failure that reaches the transcript.
 *
 * A `commit_failed` wrap attaches its cause to the error object, but the
 * `auto_compact_failed` warning used to forward only `error.message`, so a
 * run that died on "durable compaction commit failed" left nothing to tell a
 * disk-full write from a validation refusal or a size cap (Terminal-Bench
 * `layout-config-recreation2__RtxCUzj`, #2499). These helpers flatten the
 * error chain into scalar fields that fit the rollout `warning` payload:
 * names, messages, Node error codes, paths, and the commit's size facts.
 * Never payload bytes.
 *
 * @module
 */

import {
  CompactionTransactionError,
  type CompactionFailureReason,
} from "./transaction-types.js";

/** Scalar-only so the rollout schema stays additive and readers stay simple. */
export type CompactionFailureDetailValue = string | number | boolean | null;
export type CompactionFailureDetails = Readonly<
  Record<string, CompactionFailureDetailValue>
>;

/** Longest message kept per error in the chain. */
export const MAX_FAILURE_DETAIL_MESSAGE_LENGTH = 512;
/** Causes walked below the failure itself: `cause`, then `root_cause`. */
const CAUSE_PREFIXES = ["cause", "root_cause"] as const;

/**
 * A transaction failure that carries structured facts (for example the
 * commit's byte sizes) alongside its cause.
 */
export class CompactionTransactionFailureWithDetails extends CompactionTransactionError {
  constructor(
    reason: CompactionFailureReason,
    message: string,
    readonly details: CompactionFailureDetails,
    options?: ErrorOptions,
  ) {
    super(reason, message, options);
    this.name = "CompactionTransactionError";
  }
}

export function truncateFailureDetail(value: string): string {
  return value.length <= MAX_FAILURE_DETAIL_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_FAILURE_DETAIL_MESSAGE_LENGTH - 1)}…`;
}

function scalarField(
  target: Record<string, CompactionFailureDetailValue>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    if (value.length > 0) target[key] = truncateFailureDetail(value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
  }
}

/** Name, message, and the Node error facts (code, errno, syscall, path) of one error. */
function describeOneError(
  error: unknown,
  prefix: string,
  target: Record<string, CompactionFailureDetailValue>,
): void {
  if (!(error instanceof Error)) {
    scalarField(target, `${prefix}_message`, String(error));
    return;
  }
  scalarField(target, `${prefix}_name`, error.name);
  scalarField(target, `${prefix}_message`, error.message);
  if (error instanceof CompactionTransactionError) {
    scalarField(target, `${prefix}_reason`, error.reason);
  }
  const node = error as NodeJS.ErrnoException;
  scalarField(target, `${prefix}_code`, node.code);
  scalarField(target, `${prefix}_errno`, node.errno);
  scalarField(target, `${prefix}_syscall`, node.syscall);
  scalarField(target, `${prefix}_path`, node.path);
  if (error instanceof AggregateError) {
    scalarField(target, `${prefix}_errors`, error.errors.length);
  }
}

/**
 * Flatten a failure and its cause chain for the warning payload. Facts the
 * failure itself carries (see {@link CompactionTransactionFailureWithDetails})
 * come first; the chain adds `error_*`, `cause_*`, and `root_cause_*`.
 */
export function compactionFailureDetails(error: unknown): CompactionFailureDetails {
  const details: Record<string, CompactionFailureDetailValue> = {
    ...(error instanceof CompactionTransactionFailureWithDetails ? error.details : {}),
  };
  describeOneError(error, "error", details);
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (const prefix of CAUSE_PREFIXES) {
    if (current === undefined || current === null) break;
    describeOneError(current, prefix, details);
    const next: unknown = current instanceof Error ? current.cause : undefined;
    if (prefix === "cause" && next !== undefined && next !== null) {
      // Skip straight to the deepest cause: the middle of a long chain is
      // wrapping, and the root names the physical failure.
      let root: unknown = next;
      while (root instanceof Error && root.cause !== undefined && root.cause !== null) {
        root = root.cause;
      }
      current = root;
      continue;
    }
    current = undefined;
  }
  return details;
}

/** One line naming the cause, for error messages and the debug log. */
export function describeFailureCause(cause: unknown): string {
  if (!(cause instanceof Error)) return truncateFailureDetail(String(cause));
  const node = cause as NodeJS.ErrnoException;
  const facts = [
    node.code !== undefined ? `code=${node.code}` : undefined,
    node.syscall !== undefined ? `syscall=${node.syscall}` : undefined,
    node.path !== undefined ? `path=${node.path}` : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  return `${cause.name}: ${truncateFailureDetail(cause.message)}${
    facts.length > 0 ? ` (${facts.join(", ")})` : ""
  }`;
}
