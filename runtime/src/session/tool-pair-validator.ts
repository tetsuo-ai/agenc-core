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

export interface ToolPairDanglingUse {
  readonly callId: string;
  readonly toolName: string;
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
  completeDangling(
    projectionId: string,
    summary: ToolPairProjectionSummary,
  ): void;
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
      /** Structurally valid prefix ending at an explicitly permitted call boundary. */
      readonly status: "dangling";
      readonly summary: ToolPairProjectionSummary;
      readonly danglingToolUses: ReadonlyArray<ToolPairDanglingUse>;
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
  readonly allowDanglingAtEnd?: boolean;
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

type ToolPairFailureOutcome =
  | { readonly status: "invalid"; readonly failure: ToolPairIntegrityFailure }
  | {
      readonly status: "deferred";
      readonly failure: ToolPairOperationalDeferral;
    };

type ToolPairTerminalFailureOutcome = Extract<
  ToolPairValidationOutcome,
  { readonly status: "invalid" | "deferred" }
>;

interface FinishToolPairValidationOptions {
  readonly allowDanglingAtEnd?: boolean;
  readonly persistSuccess?: boolean;
}

/**
 * Stateful ordered validator shared by offline scans and the live append path.
 * Resolved IDs live only in the exact projection; the JS heap retains the
 * bounded unresolved set and scalar counters.
 */
export class StreamingToolPairValidator {
  private readonly limits: ReturnType<typeof resolveLimits>;
  private readonly openCalls = new Map<string, OpenToolCall>();
  private callCount = 0;
  private resolvedCount = 0;
  private maximumOpenCallCount = 0;
  private logicalIndexBytes = 0;
  private index = 0;
  private terminalFailure: ToolPairTerminalFailureOutcome | undefined;

  constructor(
    private readonly projection: ToolPairProjection,
    private readonly options: ToolPairValidationOptions,
  ) {
    this.limits = resolveLimits(options);
    projection.reset({
      projectionId: options.projectionId,
      sourceKey: options.sourceKey,
    });
  }

  push(message: ToolPairMessage): ToolPairTerminalFailureOutcome | undefined {
    if (this.terminalFailure !== undefined) return this.terminalFailure;
    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      return this.pushAssistantToolCalls(message.toolCalls);
    }
    if (message.role === "tool") return this.pushToolResult(message);
    if (this.openCalls.size > 0) {
      return this.finishFailure(
        invalid(
          "tool_result_missing",
          this.index,
          `tool results must immediately follow their assistant calls; unresolved: ${summarizeOpenIds(this.openCalls)}`,
        ),
      );
    }
    this.index += 1;
    return undefined;
  }

  finish(
    options: FinishToolPairValidationOptions = {},
  ): ToolPairValidationOutcome {
    if (this.terminalFailure !== undefined) return this.terminalFailure;
    const allowDanglingAtEnd =
      options.allowDanglingAtEnd ??
      this.options.allowDanglingAtEnd ??
      false;
    if (this.openCalls.size > 0) {
      if (!allowDanglingAtEnd) {
        return this.finishFailure(
          invalid(
            "tool_result_missing",
            null,
            `tool-pair stream ended with unresolved calls: ${summarizeOpenIds(this.openCalls)}`,
          ),
        );
      }
      const summary = this.summary();
      if (options.persistSuccess !== false) {
        this.projection.completeDangling(this.options.projectionId, summary);
      }
      return {
        status: "dangling",
        summary,
        danglingToolUses: Array.from(
          this.openCalls,
          ([callId, call]) => ({ callId, toolName: call.toolName }),
        ),
      };
    }
    const summary = this.summary();
    if (options.persistSuccess !== false) {
      this.projection.complete(this.options.projectionId, summary);
    }
    return { status: "valid", summary };
  }

  summary(): ToolPairProjectionSummary {
    return {
      callCount: this.callCount,
      resolvedCount: this.resolvedCount,
      openCallCount: this.openCalls.size,
      maximumOpenCallCount: this.maximumOpenCallCount,
      logicalIndexBytes: this.logicalIndexBytes,
    };
  }

  private pushAssistantToolCalls(
    toolCalls: NonNullable<ToolPairMessage["toolCalls"]>,
  ): ToolPairTerminalFailureOutcome | undefined {
    if (this.openCalls.size > 0) {
      return this.finishFailure(
        invalid(
          "assistant_tool_calls_before_results",
          this.index,
          `assistant tool calls started before resolving: ${summarizeOpenIds(this.openCalls)}`,
        ),
      );
    }
    if (toolCalls.length > this.limits.maxOpenToolCalls) {
      return this.finishFailure(
        deferred(
          "tool_pair_open_call_limit",
          this.index,
          `assistant message opens ${toolCalls.length} tool calls; limit is ${this.limits.maxOpenToolCalls}`,
        ),
      );
    }
    for (const call of toolCalls) {
      if (typeof call.id !== "string" || call.id.trim().length === 0) {
        return this.finishFailure(
          invalid(
            "assistant_tool_call_id_missing",
            this.index,
            "assistant tool call has an empty identity",
          ),
        );
      }
      if (typeof call.name !== "string" || call.name.trim().length === 0) {
        return this.finishFailure(
          invalid(
            "assistant_tool_call_name_missing",
            this.index,
            `assistant tool call ${formatIdentityForLog(call.id)} has an empty tool name`,
          ),
        );
      }
      const callIdBytes = Buffer.byteLength(call.id, "utf8");
      if (callIdBytes > this.limits.maxToolCallIdBytes) {
        return this.finishFailure(
          deferred(
            "tool_call_id_limit",
            this.index,
            `tool call identity is ${callIdBytes} UTF-8 bytes; limit is ${this.limits.maxToolCallIdBytes}`,
          ),
        );
      }

      // Exact duplicate lookup intentionally precedes the count limit.
      if (
        this.projection.find(this.options.projectionId, call.id) !== undefined
      ) {
        return this.finishFailure(
          invalid(
            "assistant_tool_call_id_duplicate",
            this.index,
            `assistant tool call repeats ${formatIdentityForLog(call.id)}`,
          ),
        );
      }
      if (this.callCount >= this.limits.maxToolCalls) {
        return this.finishFailure(
          deferred(
            "tool_pair_call_limit",
            this.index,
            `tool-pair scan exceeds ${this.limits.maxToolCalls} distinct calls`,
          ),
        );
      }
      const addedIndexBytes =
        callIdBytes + Buffer.byteLength(call.name, "utf8");
      if (
        this.logicalIndexBytes + addedIndexBytes >
        this.limits.maxIndexBytes
      ) {
        return this.finishFailure(
          deferred(
            "tool_pair_index_byte_limit",
            this.index,
            `tool-pair projection exceeds ${this.limits.maxIndexBytes} logical UTF-8 bytes`,
          ),
        );
      }
      const inserted = this.projection.insertCall(this.options.projectionId, {
        callId: call.id,
        toolName: call.name,
        assistantIndex: this.index,
      });
      if (!inserted) {
        return this.finishFailure(
          invalid(
            "assistant_tool_call_id_duplicate",
            this.index,
            `assistant tool call repeats ${formatIdentityForLog(call.id)}`,
          ),
        );
      }
      this.openCalls.set(call.id, {
        toolName: call.name,
        assistantIndex: this.index,
      });
      this.callCount += 1;
      this.logicalIndexBytes += addedIndexBytes;
    }
    this.maximumOpenCallCount = Math.max(
      this.maximumOpenCallCount,
      this.openCalls.size,
    );
    this.index += 1;
    return undefined;
  }

  private pushToolResult(
    message: ToolPairMessage,
  ): ToolPairTerminalFailureOutcome | undefined {
    if (
      typeof message.toolCallId !== "string" ||
      message.toolCallId.trim().length === 0
    ) {
      return this.finishFailure(
        invalid(
          "tool_result_id_missing",
          this.index,
          "tool result has an empty tool-call identity",
        ),
      );
    }
    const toolCallIdBytes = Buffer.byteLength(message.toolCallId, "utf8");
    if (toolCallIdBytes > this.limits.maxToolCallIdBytes) {
      return this.finishFailure(
        deferred(
          "tool_call_id_limit",
          this.index,
          `tool result identity is ${toolCallIdBytes} UTF-8 bytes; limit is ${this.limits.maxToolCallIdBytes}`,
        ),
      );
    }
    const openCall = this.openCalls.get(message.toolCallId);
    if (openCall === undefined) {
      const exact = this.projection.find(
        this.options.projectionId,
        message.toolCallId,
      );
      if (exact?.resultIndex !== undefined) {
        return this.finishFailure(
          invalid(
            "tool_result_duplicate",
            this.index,
            `tool result repeats ${formatIdentityForLog(message.toolCallId)}`,
          ),
        );
      }
      return this.finishFailure(
        invalid(
          exact === undefined
            ? this.callCount === 0
              ? "tool_result_without_call"
              : "tool_result_unknown_id"
            : "tool_result_unknown_id",
          this.index,
          `tool result references unknown ${formatIdentityForLog(message.toolCallId)}`,
        ),
      );
    }
    if (
      message.toolName !== undefined &&
      message.toolName !== openCall.toolName
    ) {
      return this.finishFailure(
        invalid(
          "tool_result_name_mismatch",
          this.index,
          `tool result ${formatIdentityForLog(message.toolCallId)} names ${formatIdentityForLog(message.toolName)}, expected ${formatIdentityForLog(openCall.toolName)}`,
        ),
      );
    }

    const integrity = this.verifyResultIntegrity(message);
    if (integrity.status !== "valid") return integrity.outcome;
    const addedIndexBytes =
      integrity.integrity === undefined
        ? 0
        : Buffer.byteLength(integrity.integrity.resultId, "utf8") +
          Buffer.byteLength(integrity.integrity.original.digest, "utf8");
    if (
      this.logicalIndexBytes + addedIndexBytes >
      this.limits.maxIndexBytes
    ) {
      return this.finishFailure(
        deferred(
          "tool_pair_index_byte_limit",
          this.index,
          `tool-pair projection exceeds ${this.limits.maxIndexBytes} logical UTF-8 bytes`,
        ),
      );
    }
    const resolution = this.projection.resolveCall({
      projectionId: this.options.projectionId,
      callId: message.toolCallId,
      resultIndex: this.index,
      ...(integrity.integrity === undefined
        ? {}
        : {
            resultId: integrity.integrity.resultId,
            originalResultDigest: integrity.integrity.original.digest,
          }),
    });
    if (resolution !== "resolved") {
      return this.finishFailure(
        invalid(
          resolution === "already_resolved"
            ? "tool_result_duplicate"
            : "tool_result_unknown_id",
          this.index,
          `tool result could not resolve ${formatIdentityForLog(message.toolCallId)}`,
        ),
      );
    }
    this.openCalls.delete(message.toolCallId);
    this.resolvedCount += 1;
    this.logicalIndexBytes += addedIndexBytes;
    this.index += 1;
    return undefined;
  }

  private verifyResultIntegrity(message: ToolPairMessage):
    | { readonly status: "valid"; readonly integrity?: ToolResultIntegrity }
    | {
        readonly status: "invalid";
        readonly outcome: ToolPairTerminalFailureOutcome;
      } {
    if (this.options.requireResultIntegrity !== true) {
      return { status: "valid" };
    }
    const verified = verifyToolResultIntegrity({
      integrity: message.toolResultIntegrity,
      expectedRunId: this.options.expectedRunId,
      toolCallId: message.toolCallId as string,
      content: message.content,
    });
    if (verified.status === "invalid") {
      return {
        status: "invalid",
        outcome: this.finishFailure({
          status: "invalid",
          failure: {
            kind: "integrity_failure",
            code: "tool_result_integrity_invalid",
            index: this.index,
            reason: verified.failure.reason,
            cause: verified.failure,
          },
        }),
      };
    }
    if (verified.status === "deferred") {
      return {
        status: "invalid",
        outcome: this.finishFailure({
          status: "deferred",
          failure: {
            kind: "operational_deferral",
            code: "tool_result_integrity_deferred",
            index: this.index,
            reason: verified.failure.reason,
            cause: verified.failure,
          },
        }),
      };
    }
    return { status: "valid", integrity: verified.integrity };
  }

  private finishFailure(
    outcome: ToolPairFailureOutcome,
  ): ToolPairTerminalFailureOutcome {
    const terminal = { ...outcome, summary: this.summary() };
    this.projection.fail(
      this.options.projectionId,
      terminal.summary,
      outcome.failure,
    );
    this.terminalFailure = terminal;
    return terminal;
  }
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
  let validator: StreamingToolPairValidator | undefined;
  try {
    return projection.runAtomically(() => {
      validator = new StreamingToolPairValidator(projection, options);
      for (const message of messages) {
        const failure = validator.push(message);
        if (failure !== undefined) return failure;
      }
      return validator.finish();
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
      summary: validator?.summary() ?? emptySummary(),
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
