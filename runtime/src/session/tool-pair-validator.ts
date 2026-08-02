import {
  MAX_TOOL_CALL_ID_UTF8_BYTES,
  formatIdentityForLog,
  verifyToolResultIntegrity,
  type ToolResultIntegrity,
  type ToolResultIntegrityDeferral,
  type ToolResultIntegrityFailure,
} from "./tool-result-integrity.js";

export { MAX_TOOL_CALL_ID_UTF8_BYTES } from "./tool-result-integrity.js";

export const MAX_TOOL_CALL_IDS_PER_RUN = 1_000_000;
export const MAX_OPEN_TOOL_CALLS_PER_RUN = 4_096;
export const MAX_TOOL_CALL_ID_INDEX_BYTES_PER_RUN = 268_435_456;
export const MAX_TOOL_PAIR_IDS_IN_ERROR = 8;

export interface ToolPairMessage {
  readonly role: string;
  readonly content: unknown;
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolResultIntegrity?: unknown;
}

export interface ToolPairProjectionRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly assistantIndex: number;
  readonly resultIndex?: number;
  readonly resultId?: string;
  readonly originalResultDigest?: string;
}

export interface ToolPairProjectionSummary {
  readonly callCount: number;
  readonly resolvedCount: number;
  readonly openCallCount: number;
  readonly maximumOpenCallCount: number;
  readonly logicalIndexBytes: number;
}

/**
 * Exact index used by the ordered scanner. The production implementation is
 * SQLite-backed; this interface keeps the session-layer state machine free of
 * a state-store dependency and makes operational failure semantics explicit.
 */
export interface ToolPairProjection {
  runAtomically<T>(operation: () => T): T;
  reset(params: {
    readonly projectionId: string;
    readonly sourceKey: string;
  }): void;
  find(
    projectionId: string,
    callId: string,
  ): ToolPairProjectionRecord | undefined;
  insertCall(projectionId: string, record: ToolPairProjectionRecord): boolean;
  resolveCall(params: {
    readonly projectionId: string;
    readonly callId: string;
    readonly resultIndex: number;
    readonly resultId?: string;
    readonly originalResultDigest?: string;
  }): "resolved" | "already_resolved" | "missing";
  complete(projectionId: string, summary: ToolPairProjectionSummary): void;
  fail(
    projectionId: string,
    summary: ToolPairProjectionSummary,
    failure: ToolPairIntegrityFailure | ToolPairOperationalDeferral,
  ): void;
}

export type ToolPairIntegrityFailureCode =
  | "assistant_tool_calls_before_results"
  | "assistant_tool_call_id_missing"
  | "assistant_tool_call_name_missing"
  | "assistant_tool_call_id_duplicate"
  | "tool_result_id_missing"
  | "tool_result_without_call"
  | "tool_result_unknown_id"
  | "tool_result_duplicate"
  | "tool_result_name_mismatch"
  | "tool_result_missing"
  | "tool_result_integrity_invalid";

export type ToolPairOperationalDeferralCode =
  | "tool_call_id_limit"
  | "tool_pair_call_limit"
  | "tool_pair_open_call_limit"
  | "tool_pair_index_byte_limit"
  | "tool_result_integrity_deferred"
  | "tool_pair_projection_unavailable";

export interface ToolPairIntegrityFailure {
  readonly kind: "integrity_failure";
  readonly code: ToolPairIntegrityFailureCode;
  readonly index: number | null;
  readonly reason: string;
  readonly cause?: ToolResultIntegrityFailure;
}

export interface ToolPairOperationalDeferral {
  readonly kind: "operational_deferral";
  readonly code: ToolPairOperationalDeferralCode;
  readonly index: number | null;
  readonly reason: string;
  readonly cause?: ToolResultIntegrityDeferral;
}

export type ToolPairValidationOutcome =
  | {
      readonly status: "valid";
      readonly summary: ToolPairProjectionSummary;
    }
  | {
      readonly status: "invalid";
      readonly failure: ToolPairIntegrityFailure;
      readonly summary: ToolPairProjectionSummary;
    }
  | {
      readonly status: "deferred";
      readonly failure: ToolPairOperationalDeferral;
      readonly summary: ToolPairProjectionSummary;
    };

interface ToolPairValidationLimits {
  readonly projectionId: string;
  readonly sourceKey: string;
  readonly maxToolCalls?: number;
  readonly maxOpenToolCalls?: number;
  readonly maxToolCallIdBytes?: number;
  readonly maxIndexBytes?: number;
}

export type ToolPairValidationOptions = ToolPairValidationLimits &
  (
    | {
        readonly requireResultIntegrity: true;
        readonly expectedRunId: string;
      }
    | {
        readonly requireResultIntegrity?: false;
        readonly expectedRunId?: never;
      }
  );

interface OpenToolCall {
  readonly toolName: string;
  readonly assistantIndex: number;
}

/**
 * Validate a message stream without retaining every historical ID in the JS
 * heap. Only the bounded open-call set is resident; exact duplicate identity
 * is delegated to the projection.
 */
export function validateToolPairSequence(
  messages: Iterable<ToolPairMessage>,
  projection: ToolPairProjection,
  options: ToolPairValidationOptions,
): ToolPairValidationOutcome {
  const limits = resolveLimits(options);
  let latestSummary = emptySummary();
  try {
    return projection.runAtomically(() => {
      projection.reset({
        projectionId: options.projectionId,
        sourceKey: options.sourceKey,
      });
      const openCalls = new Map<string, OpenToolCall>();
      let callCount = 0;
      let resolvedCount = 0;
      let maximumOpenCallCount = 0;
      let logicalIndexBytes = 0;
      let index = 0;

      const summary = (): ToolPairProjectionSummary => ({
        callCount,
        resolvedCount,
        openCallCount: openCalls.size,
        maximumOpenCallCount,
        logicalIndexBytes,
      });
      const finishFailure = (
        outcome:
          | {
              readonly status: "invalid";
              readonly failure: ToolPairIntegrityFailure;
            }
          | {
              readonly status: "deferred";
              readonly failure: ToolPairOperationalDeferral;
            },
      ): ToolPairValidationOutcome => {
        latestSummary = summary();
        projection.fail(options.projectionId, latestSummary, outcome.failure);
        return { ...outcome, summary: latestSummary };
      };

      for (const message of messages) {
        if (
          message.role === "assistant" &&
          message.toolCalls !== undefined &&
          message.toolCalls.length > 0
        ) {
          if (openCalls.size > 0) {
            return finishFailure(
              invalid(
                "assistant_tool_calls_before_results",
                index,
                `assistant tool calls started before resolving: ${summarizeOpenIds(openCalls)}`,
              ),
            );
          }
          if (message.toolCalls.length > limits.maxOpenToolCalls) {
            return finishFailure(
              deferred(
                "tool_pair_open_call_limit",
                index,
                `assistant message opens ${message.toolCalls.length} tool calls; limit is ${limits.maxOpenToolCalls}`,
              ),
            );
          }
          for (const call of message.toolCalls) {
            if (typeof call.id !== "string" || call.id.trim().length === 0) {
              return finishFailure(
                invalid(
                  "assistant_tool_call_id_missing",
                  index,
                  "assistant tool call has an empty identity",
                ),
              );
            }
            if (
              typeof call.name !== "string" ||
              call.name.trim().length === 0
            ) {
              return finishFailure(
                invalid(
                  "assistant_tool_call_name_missing",
                  index,
                  `assistant tool call ${formatIdentityForLog(call.id)} has an empty tool name`,
                ),
              );
            }
            const callIdBytes = Buffer.byteLength(call.id, "utf8");
            if (callIdBytes > limits.maxToolCallIdBytes) {
              return finishFailure(
                deferred(
                  "tool_call_id_limit",
                  index,
                  `tool call identity is ${callIdBytes} UTF-8 bytes; limit is ${limits.maxToolCallIdBytes}`,
                ),
              );
            }

            // Exact duplicate lookup intentionally precedes the count limit:
            // after exactly one million distinct calls, replaying the first ID
            // is still diagnosed as a duplicate rather than hidden by a limit.
            if (projection.find(options.projectionId, call.id) !== undefined) {
              return finishFailure(
                invalid(
                  "assistant_tool_call_id_duplicate",
                  index,
                  `assistant tool call repeats ${formatIdentityForLog(call.id)}`,
                ),
              );
            }
            if (callCount >= limits.maxToolCalls) {
              return finishFailure(
                deferred(
                  "tool_pair_call_limit",
                  index,
                  `tool-pair scan exceeds ${limits.maxToolCalls} distinct calls`,
                ),
              );
            }
            const addedIndexBytes =
              callIdBytes + Buffer.byteLength(call.name, "utf8");
            if (logicalIndexBytes + addedIndexBytes > limits.maxIndexBytes) {
              return finishFailure(
                deferred(
                  "tool_pair_index_byte_limit",
                  index,
                  `tool-pair projection exceeds ${limits.maxIndexBytes} logical UTF-8 bytes`,
                ),
              );
            }
            const inserted = projection.insertCall(options.projectionId, {
              callId: call.id,
              toolName: call.name,
              assistantIndex: index,
            });
            if (!inserted) {
              return finishFailure(
                invalid(
                  "assistant_tool_call_id_duplicate",
                  index,
                  `assistant tool call repeats ${formatIdentityForLog(call.id)}`,
                ),
              );
            }
            openCalls.set(call.id, {
              toolName: call.name,
              assistantIndex: index,
            });
            callCount += 1;
            logicalIndexBytes += addedIndexBytes;
          }
          maximumOpenCallCount = Math.max(maximumOpenCallCount, openCalls.size);
          index += 1;
          continue;
        }

        if (message.role === "tool") {
          if (
            typeof message.toolCallId !== "string" ||
            message.toolCallId.trim().length === 0
          ) {
            return finishFailure(
              invalid(
                "tool_result_id_missing",
                index,
                "tool result has an empty tool-call identity",
              ),
            );
          }
          const toolCallIdBytes = Buffer.byteLength(message.toolCallId, "utf8");
          if (toolCallIdBytes > limits.maxToolCallIdBytes) {
            return finishFailure(
              deferred(
                "tool_call_id_limit",
                index,
                `tool result identity is ${toolCallIdBytes} UTF-8 bytes; limit is ${limits.maxToolCallIdBytes}`,
              ),
            );
          }
          const openCall = openCalls.get(message.toolCallId);
          if (openCall === undefined) {
            const exact = projection.find(
              options.projectionId,
              message.toolCallId,
            );
            if (exact?.resultIndex !== undefined) {
              return finishFailure(
                invalid(
                  "tool_result_duplicate",
                  index,
                  `tool result repeats ${formatIdentityForLog(message.toolCallId)}`,
                ),
              );
            }
            return finishFailure(
              invalid(
                exact === undefined
                  ? callCount === 0
                    ? "tool_result_without_call"
                    : "tool_result_unknown_id"
                  : "tool_result_unknown_id",
                index,
                `tool result references unknown ${formatIdentityForLog(message.toolCallId)}`,
              ),
            );
          }
          if (
            message.toolName !== undefined &&
            message.toolName !== openCall.toolName
          ) {
            return finishFailure(
              invalid(
                "tool_result_name_mismatch",
                index,
                `tool result ${formatIdentityForLog(message.toolCallId)} names ${formatIdentityForLog(message.toolName)}, expected ${formatIdentityForLog(openCall.toolName)}`,
              ),
            );
          }

          let integrity: ToolResultIntegrity | undefined;
          if (options.requireResultIntegrity === true) {
            const verified = verifyToolResultIntegrity({
              integrity: message.toolResultIntegrity,
              expectedRunId: options.expectedRunId,
              toolCallId: message.toolCallId,
              content: message.content,
            });
            if (verified.status === "invalid") {
              return finishFailure({
                status: "invalid",
                failure: {
                  kind: "integrity_failure",
                  code: "tool_result_integrity_invalid",
                  index,
                  reason: verified.failure.reason,
                  cause: verified.failure,
                },
              });
            }
            if (verified.status === "deferred") {
              return finishFailure({
                status: "deferred",
                failure: {
                  kind: "operational_deferral",
                  code: "tool_result_integrity_deferred",
                  index,
                  reason: verified.failure.reason,
                  cause: verified.failure,
                },
              });
            }
            integrity = verified.integrity;
          }

          const addedIndexBytes =
            integrity === undefined
              ? 0
              : Buffer.byteLength(integrity.resultId, "utf8") +
                Buffer.byteLength(integrity.original.digest, "utf8");
          if (logicalIndexBytes + addedIndexBytes > limits.maxIndexBytes) {
            return finishFailure(
              deferred(
                "tool_pair_index_byte_limit",
                index,
                `tool-pair projection exceeds ${limits.maxIndexBytes} logical UTF-8 bytes`,
              ),
            );
          }
          const resolution = projection.resolveCall({
            projectionId: options.projectionId,
            callId: message.toolCallId,
            resultIndex: index,
            ...(integrity === undefined
              ? {}
              : {
                  resultId: integrity.resultId,
                  originalResultDigest: integrity.original.digest,
                }),
          });
          if (resolution !== "resolved") {
            return finishFailure(
              invalid(
                resolution === "already_resolved"
                  ? "tool_result_duplicate"
                  : "tool_result_unknown_id",
                index,
                `tool result could not resolve ${formatIdentityForLog(message.toolCallId)}`,
              ),
            );
          }
          openCalls.delete(message.toolCallId);
          resolvedCount += 1;
          logicalIndexBytes += addedIndexBytes;
          index += 1;
          continue;
        }

        if (openCalls.size > 0) {
          return finishFailure(
            invalid(
              "tool_result_missing",
              index,
              `tool results must immediately follow their assistant calls; unresolved: ${summarizeOpenIds(openCalls)}`,
            ),
          );
        }
        index += 1;
      }

      if (openCalls.size > 0) {
        return finishFailure(
          invalid(
            "tool_result_missing",
            null,
            `tool-pair stream ended with unresolved calls: ${summarizeOpenIds(openCalls)}`,
          ),
        );
      }
      latestSummary = summary();
      projection.complete(options.projectionId, latestSummary);
      return { status: "valid", summary: latestSummary };
    });
  } catch (error) {
    return {
      status: "deferred",
      failure: {
        kind: "operational_deferral",
        code: "tool_pair_projection_unavailable",
        index: null,
        reason: projectionFailureReason(error),
      },
      summary: latestSummary,
    };
  }
}

function resolveLimits(options: ToolPairValidationOptions): {
  readonly maxToolCalls: number;
  readonly maxOpenToolCalls: number;
  readonly maxToolCallIdBytes: number;
  readonly maxIndexBytes: number;
} {
  return {
    maxToolCalls: positiveIntegerLimit(
      options.maxToolCalls ?? MAX_TOOL_CALL_IDS_PER_RUN,
      "maxToolCalls",
    ),
    maxOpenToolCalls: positiveIntegerLimit(
      options.maxOpenToolCalls ?? MAX_OPEN_TOOL_CALLS_PER_RUN,
      "maxOpenToolCalls",
    ),
    maxToolCallIdBytes: positiveIntegerLimit(
      options.maxToolCallIdBytes ?? MAX_TOOL_CALL_ID_UTF8_BYTES,
      "maxToolCallIdBytes",
    ),
    maxIndexBytes: positiveIntegerLimit(
      options.maxIndexBytes ?? MAX_TOOL_CALL_ID_INDEX_BYTES_PER_RUN,
      "maxIndexBytes",
    ),
  };
}

function positiveIntegerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function emptySummary(): ToolPairProjectionSummary {
  return {
    callCount: 0,
    resolvedCount: 0,
    openCallCount: 0,
    maximumOpenCallCount: 0,
    logicalIndexBytes: 0,
  };
}

function summarizeOpenIds(
  openCalls: ReadonlyMap<string, OpenToolCall>,
): string {
  const values: string[] = [];
  for (const callId of openCalls.keys()) {
    values.push(formatIdentityForLog(callId));
    if (values.length === MAX_TOOL_PAIR_IDS_IN_ERROR) break;
  }
  const remaining = openCalls.size - values.length;
  return remaining > 0
    ? `${values.join(", ")} … (+${remaining} more)`
    : values.join(", ");
}

function invalid(
  code: ToolPairIntegrityFailureCode,
  index: number | null,
  reason: string,
): { readonly status: "invalid"; readonly failure: ToolPairIntegrityFailure } {
  return {
    status: "invalid",
    failure: { kind: "integrity_failure", code, index, reason },
  };
}

function deferred(
  code: ToolPairOperationalDeferralCode,
  index: number | null,
  reason: string,
): {
  readonly status: "deferred";
  readonly failure: ToolPairOperationalDeferral;
} {
  return {
    status: "deferred",
    failure: { kind: "operational_deferral", code, index, reason },
  };
}

function projectionFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `tool-pair projection is unavailable: ${error.message}`;
  }
  return "tool-pair projection is unavailable";
}
