import type {
  TurnCheckpointSliceLine,
  TurnCheckpointV1Event,
  TurnCheckpointV2Event,
} from "./event-log.js";
import type { ToolResultIntegrityResponseItem } from "./rollout-item.js";
import {
  CanonicalSha256Writer,
  TOOL_RESULT_DIGEST_PREFIX,
  ToolResultCanonicalizationError,
  constantTimeDigestEqual,
  digestToolResultBody,
  type ToolResultIntegrityDeferral,
  type ToolResultIntegrityFailure,
} from "./tool-result-integrity.js";
import {
  validateToolPairSequence,
  type ToolPairIntegrityFailure,
  type ToolPairOperationalDeferral,
  type ToolPairProjection,
  type ToolPairProjectionSummary,
} from "./tool-pair-validator.js";

export const LEGACY_DURABLE_CHECKPOINT_VERSION = 1 as const;
export const DURABLE_CHECKPOINT_READ_VERSION = 2 as const;
export const DURABLE_ROLLOUT_SCHEMA_V2 = 2 as const;
export const MAX_CHECKPOINT_PREFIX_MESSAGES = 2_000_000;

const CHECKPOINT_PREFIX_DIGEST_DOMAIN = "agenc.checkpoint-prefix.v2";
const MAX_CHECKPOINT_TURN_ID_BYTES = 4_096;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CHECKPOINT_BASE_KEYS = Object.freeze([
  "boundary",
  "checkpointSeq",
  "iterationIndex",
  "persistedMessageCount",
  "prefixHash",
  "resumableState",
  "turnId",
]);
const CHECKPOINT_SLICE_KEYS = Object.freeze([
  "autoCompactTracking",
  "continuationNudgeCount",
  "maxOutputTokensRecoveryCount",
  "pendingBudgetDecision",
  "planToolRequiredRetryCount",
  "recoveryReentryCount",
  "stopHookBlockingCount",
  "taskBudgetRemaining",
  "transition",
  "turnCount",
]);
const RESPONSE_ITEM_KEYS = Object.freeze([
  "content",
  "endTurn",
  "id",
  "phase",
  "role",
  "toolCallId",
  "toolCalls",
  "toolName",
  "toolResultIntegrity",
]);
const TOOL_CALL_KEYS = Object.freeze(["arguments", "id", "name"]);

export type ReadableTurnCheckpoint =
  | {
      readonly version: typeof LEGACY_DURABLE_CHECKPOINT_VERSION;
      readonly checkpoint: TurnCheckpointV1Event;
    }
  | {
      readonly version: typeof DURABLE_CHECKPOINT_READ_VERSION;
      readonly checkpoint: TurnCheckpointV2Event;
    };

export type DurableCheckpointReadFailureCode =
  "checkpoint_shape_invalid" | "checkpoint_version_unsupported";

export class DurableCheckpointReadError extends Error {
  readonly kind = "integrity_failure" as const;

  constructor(
    readonly code: DurableCheckpointReadFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "DurableCheckpointReadError";
  }
}

export interface DurableCheckpointPrefixFailure {
  readonly kind: "integrity_failure";
  readonly code:
    | "checkpoint_prefix_missing"
    | "checkpoint_prefix_digest_mismatch"
    | "misplaced_tool_result_integrity"
    | "checkpoint_response_shape_invalid"
    | "checkpoint_prefix_body_invalid";
  readonly index: number | null;
  readonly reason: string;
  readonly cause?: ToolResultIntegrityFailure;
}

export interface DurableCheckpointPrefixDeferral {
  readonly kind: "operational_deferral";
  readonly code:
    "checkpoint_prefix_message_limit" | "checkpoint_prefix_body_deferred";
  readonly index: number | null;
  readonly reason: string;
  readonly cause?: ToolResultIntegrityDeferral;
}

export type DurableCheckpointPrefixValidation =
  | {
      readonly status: "valid";
      readonly prefixHash: string;
      readonly toolPairs: ToolPairProjectionSummary;
    }
  | {
      readonly status: "invalid";
      readonly failure:
        DurableCheckpointPrefixFailure | ToolPairIntegrityFailure;
    }
  | {
      readonly status: "deferred";
      readonly failure:
        DurableCheckpointPrefixDeferral | ToolPairOperationalDeferral;
    };

/** Strictly dispatch a durable checkpoint. Unknown versions fail closed. */
export function readTurnCheckpoint(payload: unknown): ReadableTurnCheckpoint {
  if (!isRecord(payload)) {
    throw malformed("checkpoint payload must be an object");
  }
  const rawVersion = payload.checkpointVersion;
  const version =
    rawVersion === undefined ? LEGACY_DURABLE_CHECKPOINT_VERSION : rawVersion;
  if (
    version !== LEGACY_DURABLE_CHECKPOINT_VERSION &&
    version !== DURABLE_CHECKPOINT_READ_VERSION
  ) {
    throw new DurableCheckpointReadError(
      "checkpoint_version_unsupported",
      `durable checkpoint version ${safeVersion(version)} is not readable; maximum is ${DURABLE_CHECKPOINT_READ_VERSION}`,
    );
  }

  const expectedKeys =
    version === LEGACY_DURABLE_CHECKPOINT_VERSION
      ? rawVersion === undefined
        ? CHECKPOINT_BASE_KEYS
        : [...CHECKPOINT_BASE_KEYS, "checkpointVersion"]
      : [
          ...CHECKPOINT_BASE_KEYS,
          "checkpointVersion",
          "toolResultIntegrityVersion",
        ];
  if (!hasExactKeys(payload, expectedKeys)) {
    throw malformed("checkpoint payload contains unversioned fields");
  }

  const common = parseCheckpointBase(payload);
  if (version === LEGACY_DURABLE_CHECKPOINT_VERSION) {
    if (
      payload.toolResultIntegrityVersion !== undefined ||
      (rawVersion !== undefined && rawVersion !== 1)
    ) {
      throw malformed("legacy checkpoint carries incompatible v2 metadata");
    }
    return {
      version,
      checkpoint: {
        ...common,
        ...(rawVersion === 1 ? { checkpointVersion: 1 as const } : {}),
      },
    };
  }
  if (payload.toolResultIntegrityVersion !== 1) {
    throw malformed("checkpoint v2 requires toolResultIntegrityVersion 1");
  }
  return {
    version,
    checkpoint: {
      ...common,
      checkpointVersion: DURABLE_CHECKPOINT_READ_VERSION,
      toolResultIntegrityVersion: 1,
    },
  };
}

/**
 * Compute the version-2 prefix digest over the complete persisted
 * representation. A3b must invoke this before replay truncation.
 */
export function computeCheckpointPrefixHashV2(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
): string {
  if (!Number.isSafeInteger(count) || count < 0 || count > messages.length) {
    throw new Error("checkpoint prefix count is outside the available history");
  }
  const writer = new CanonicalSha256Writer(CHECKPOINT_PREFIX_DIGEST_DOMAIN);
  writer.writeCount("message-count", count);
  for (let index = 0; index < count; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`checkpoint prefix message ${index} is missing`);
    }
    assertResponseItemShape(message, index);
    writer.writeCount("message-index", index);
    writer.writeString("role", message.role);
    const integrity = message.toolResultIntegrity;
    const bodyIdentity =
      message.role === "tool" && integrity !== undefined
        ? integrity.persisted
        : digestToolResultBody(message.content);
    writer.writeString("content-digest", bodyIdentity.digest);
    writer.writeCount("content-byte-length", bodyIdentity.byteLength);

    const calls = message.toolCalls ?? [];
    writer.writeCount("tool-call-count", calls.length);
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const call = calls[callIndex];
      if (call === undefined) continue;
      writer.writeCount("tool-call-index", callIndex);
      writer.writeString("tool-call-id", call.id);
      writer.writeString("tool-call-name", call.name);
      writeOptionalString(writer, "tool-call-arguments", call.arguments);
    }
    writeOptionalString(writer, "tool-result-call-id", message.toolCallId);
    writeOptionalString(writer, "tool-result-name", message.toolName);
    writeOptionalString(writer, "response-id", message.id);
    writeOptionalString(writer, "phase", message.phase);
    writer.writeString(
      "end-turn-present",
      String(message.endTurn !== undefined),
    );
    if (message.endTurn !== undefined) {
      writer.writeString("end-turn", String(message.endTurn));
    }

    writer.writeString(
      "tool-result-integrity-present",
      String(integrity !== undefined),
    );
    if (integrity !== undefined) {
      writer.writeCount("tool-result-integrity-version", integrity.version);
      writer.writeString("tool-result-algorithm", integrity.algorithm);
      writer.writeString("tool-result-run-id", integrity.runId);
      writer.writeString("tool-result-call-id", integrity.toolCallId);
      writer.writeString("tool-result-id", integrity.resultId);
      writer.writeString(
        "tool-result-original-digest",
        integrity.original.digest,
      );
      writer.writeCount(
        "tool-result-original-byte-length",
        integrity.original.byteLength,
      );
      writer.writeString(
        "tool-result-persisted-representation",
        integrity.persisted.representation,
      );
      writer.writeString(
        "tool-result-persisted-digest",
        integrity.persisted.digest,
      );
      writer.writeCount(
        "tool-result-persisted-byte-length",
        integrity.persisted.byteLength,
      );
    }
  }
  return writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length);
}

/**
 * Validate v2 body metadata, exact call/result order, and the checkpoint hash.
 * Only `status: "valid"` is executable; invalid and deferred outcomes fail
 * closed for the A3b resume gate.
 */
export function validateCheckpointPrefixV2(params: {
  readonly checkpoint: TurnCheckpointV2Event;
  readonly expectedRunId: string;
  readonly messages: ReadonlyArray<ToolResultIntegrityResponseItem>;
  readonly projection: ToolPairProjection;
  readonly projectionId: string;
  readonly sourceKey: string;
  readonly maxPrefixMessages?: number;
}): DurableCheckpointPrefixValidation {
  const count = params.checkpoint.persistedMessageCount;
  if (count > params.messages.length) {
    return {
      status: "invalid",
      failure: {
        kind: "integrity_failure",
        code: "checkpoint_prefix_missing",
        index: null,
        reason: `checkpoint requires ${count} messages but only ${params.messages.length} are available`,
      },
    };
  }
  const maxPrefixMessages =
    params.maxPrefixMessages ?? MAX_CHECKPOINT_PREFIX_MESSAGES;
  if (!Number.isSafeInteger(maxPrefixMessages) || maxPrefixMessages <= 0) {
    throw new Error("maxPrefixMessages must be a positive safe integer");
  }
  if (count > maxPrefixMessages) {
    return {
      status: "deferred",
      failure: {
        kind: "operational_deferral",
        code: "checkpoint_prefix_message_limit",
        index: null,
        reason: `checkpoint prefix has ${count} messages; limit is ${maxPrefixMessages}`,
      },
    };
  }
  for (let index = 0; index < count; index += 1) {
    const message = params.messages[index];
    if (message !== undefined) {
      try {
        assertResponseItemShape(message, index);
      } catch (error) {
        if (error instanceof DurableCheckpointReadError) {
          return {
            status: "invalid",
            failure: {
              kind: "integrity_failure",
              code: "checkpoint_response_shape_invalid",
              index,
              reason: error.message,
            },
          };
        }
        throw error;
      }
    }
    if (
      message !== undefined &&
      message.role !== "tool" &&
      message.toolResultIntegrity !== undefined
    ) {
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "misplaced_tool_result_integrity",
          index,
          reason:
            "tool-result integrity metadata is attached to a non-tool message",
        },
      };
    }
  }

  const toolPairs = validateToolPairSequence(
    prefixMessages(params.messages, count),
    params.projection,
    {
      projectionId: params.projectionId,
      sourceKey: params.sourceKey,
      requireResultIntegrity: true,
      expectedRunId: params.expectedRunId,
    },
  );
  if (toolPairs.status !== "valid") return toolPairs;

  let prefixHash: string;
  try {
    prefixHash = computeCheckpointPrefixHashV2(params.messages, count);
  } catch (error) {
    if (error instanceof DurableCheckpointReadError) {
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "checkpoint_response_shape_invalid",
          index: null,
          reason: error.message,
        },
      };
    }
    if (error instanceof ToolResultCanonicalizationError) {
      if (error.kind === "operational_deferral") {
        return {
          status: "deferred",
          failure: {
            kind: "operational_deferral",
            code: "checkpoint_prefix_body_deferred",
            index: null,
            reason: error.message,
            cause: {
              kind: "operational_deferral",
              code: error.code as ToolResultIntegrityDeferral["code"],
              reason: error.message,
            },
          },
        };
      }
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "checkpoint_prefix_body_invalid",
          index: null,
          reason: error.message,
          cause: {
            kind: "integrity_failure",
            code: error.code as ToolResultIntegrityFailure["code"],
            reason: error.message,
          },
        },
      };
    }
    throw error;
  }
  if (!constantTimeDigestEqual(prefixHash, params.checkpoint.prefixHash)) {
    return {
      status: "invalid",
      failure: {
        kind: "integrity_failure",
        code: "checkpoint_prefix_digest_mismatch",
        index: null,
        reason: "checkpoint prefix digest does not match persisted history",
      },
    };
  }
  return { status: "valid", prefixHash, toolPairs: toolPairs.summary };
}

function parseCheckpointBase(
  payload: Record<string, unknown>,
): Omit<TurnCheckpointV1Event, "checkpointVersion"> {
  const turnId = requiredText(payload.turnId, "turnId");
  if (Buffer.byteLength(turnId, "utf8") > MAX_CHECKPOINT_TURN_ID_BYTES) {
    throw malformed(
      `turnId exceeds ${MAX_CHECKPOINT_TURN_ID_BYTES} UTF-8 bytes`,
    );
  }
  const boundary = payload.boundary;
  if (boundary !== "iteration" && boundary !== "postAssistant") {
    throw malformed("checkpoint boundary is invalid");
  }
  const prefixHash = requiredText(payload.prefixHash, "prefixHash");
  if (!SHA256_HEX_PATTERN.test(prefixHash)) {
    throw malformed(
      "checkpoint prefixHash must be a lowercase SHA-256 hex digest",
    );
  }
  return {
    turnId,
    iterationIndex: nonNegativeInteger(
      payload.iterationIndex,
      "iterationIndex",
    ),
    boundary,
    checkpointSeq: positiveInteger(payload.checkpointSeq, "checkpointSeq"),
    persistedMessageCount: nonNegativeInteger(
      payload.persistedMessageCount,
      "persistedMessageCount",
    ),
    prefixHash,
    resumableState: parseCheckpointSlice(payload.resumableState),
  };
}

function assertResponseItemShape(
  item: ToolResultIntegrityResponseItem,
  index: number,
): void {
  if (!isRecord(item) || !hasOnlyKnownKeys(item, RESPONSE_ITEM_KEYS)) {
    throw malformed(
      `checkpoint response item ${index} contains unversioned fields`,
    );
  }
  if (
    item.role !== "system" &&
    item.role !== "developer" &&
    item.role !== "user" &&
    item.role !== "assistant" &&
    item.role !== "tool"
  ) {
    throw malformed(`checkpoint response item ${index} has an invalid role`);
  }
  if (typeof item.content !== "string" && !Array.isArray(item.content)) {
    throw malformed(`checkpoint response item ${index} has invalid content`);
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!isRecord(part) || typeof part.type !== "string") {
        throw malformed(
          `checkpoint response item ${index} has an invalid content part`,
        );
      }
    }
  }
  if (item.toolCalls !== undefined) {
    if (!Array.isArray(item.toolCalls) || item.role !== "assistant") {
      throw malformed(
        `checkpoint response item ${index} has invalid toolCalls`,
      );
    }
    for (const call of item.toolCalls) {
      if (
        !isRecord(call) ||
        !hasOnlyKnownKeys(call, TOOL_CALL_KEYS) ||
        (call.id !== undefined && typeof call.id !== "string") ||
        (call.name !== undefined && typeof call.name !== "string") ||
        (call.arguments !== undefined && typeof call.arguments !== "string")
      ) {
        throw malformed(
          `checkpoint response item ${index} has an invalid tool call`,
        );
      }
    }
  }
  for (const [field, value] of [
    ["toolCallId", item.toolCallId],
    ["toolName", item.toolName],
    ["id", item.id],
    ["phase", item.phase],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw malformed(`checkpoint response item ${index} has invalid ${field}`);
    }
  }
  if (item.endTurn !== undefined && typeof item.endTurn !== "boolean") {
    throw malformed(`checkpoint response item ${index} has invalid endTurn`);
  }
  if (
    item.toolResultIntegrity !== undefined &&
    !isRecord(item.toolResultIntegrity)
  ) {
    throw malformed(
      `checkpoint response item ${index} has invalid tool-result integrity metadata`,
    );
  }
}

function parseCheckpointSlice(value: unknown): TurnCheckpointSliceLine {
  if (!isRecord(value)) throw malformed("resumableState must be an object");
  if (!hasOnlyKnownKeys(value, CHECKPOINT_SLICE_KEYS)) {
    throw malformed("resumableState contains unversioned fields");
  }
  const result: {
    turnCount: number;
    recoveryReentryCount: number;
    maxOutputTokensRecoveryCount: number;
    continuationNudgeCount: number;
    stopHookBlockingCount: number;
    planToolRequiredRetryCount?: number;
    taskBudgetRemaining?: number;
    autoCompactTracking?: TurnCheckpointSliceLine["autoCompactTracking"];
    transition?: TurnCheckpointSliceLine["transition"];
    pendingBudgetDecision?: TurnCheckpointSliceLine["pendingBudgetDecision"];
  } = {
    turnCount: nonNegativeInteger(value.turnCount, "resumableState.turnCount"),
    recoveryReentryCount: nonNegativeInteger(
      value.recoveryReentryCount,
      "resumableState.recoveryReentryCount",
    ),
    maxOutputTokensRecoveryCount: nonNegativeInteger(
      value.maxOutputTokensRecoveryCount,
      "resumableState.maxOutputTokensRecoveryCount",
    ),
    continuationNudgeCount: nonNegativeInteger(
      value.continuationNudgeCount,
      "resumableState.continuationNudgeCount",
    ),
    stopHookBlockingCount: nonNegativeInteger(
      value.stopHookBlockingCount,
      "resumableState.stopHookBlockingCount",
    ),
  };
  if (value.planToolRequiredRetryCount !== undefined) {
    result.planToolRequiredRetryCount = nonNegativeInteger(
      value.planToolRequiredRetryCount,
      "resumableState.planToolRequiredRetryCount",
    );
  }
  if (value.taskBudgetRemaining !== undefined) {
    result.taskBudgetRemaining = nonNegativeInteger(
      value.taskBudgetRemaining,
      "resumableState.taskBudgetRemaining",
    );
  }
  if (value.autoCompactTracking !== undefined) {
    if (!isRecord(value.autoCompactTracking)) {
      throw malformed("resumableState.autoCompactTracking must be an object");
    }
    const tracking = value.autoCompactTracking;
    if (
      !hasExactKeys(tracking, [
        "compacted",
        "consecutiveFailures",
        "turnCounter",
        "turnId",
      ])
    ) {
      throw malformed(
        "resumableState.autoCompactTracking contains unversioned fields",
      );
    }
    if (typeof tracking.compacted !== "boolean") {
      throw malformed(
        "resumableState.autoCompactTracking.compacted is invalid",
      );
    }
    result.autoCompactTracking = {
      compacted: tracking.compacted,
      turnId: requiredText(
        tracking.turnId,
        "resumableState.autoCompactTracking.turnId",
      ),
      turnCounter: nonNegativeInteger(
        tracking.turnCounter,
        "resumableState.autoCompactTracking.turnCounter",
      ),
      consecutiveFailures: nonNegativeInteger(
        tracking.consecutiveFailures,
        "resumableState.autoCompactTracking.consecutiveFailures",
      ),
    };
  }
  if (value.transition !== undefined) {
    if (!isRecord(value.transition)) {
      throw malformed("resumableState.transition must be an object");
    }
    if (!hasExactKeys(value.transition, ["reason"])) {
      throw malformed("resumableState.transition contains unversioned fields");
    }
    result.transition = {
      reason: requiredText(
        value.transition.reason,
        "resumableState.transition.reason",
      ),
    };
  }
  if (value.pendingBudgetDecision !== undefined) {
    if (!isRecord(value.pendingBudgetDecision)) {
      throw malformed("resumableState.pendingBudgetDecision must be an object");
    }
    const decision = value.pendingBudgetDecision;
    if (decision.kind === "continue") {
      if (!hasExactKeys(decision, ["kind", "remaining"])) {
        throw malformed(
          "resumableState.pendingBudgetDecision contains unversioned fields",
        );
      }
      result.pendingBudgetDecision = {
        kind: "continue",
        remaining: nonNegativeInteger(
          decision.remaining,
          "resumableState.pendingBudgetDecision.remaining",
        ),
      };
    } else if (decision.kind === "stop") {
      if (!hasExactKeys(decision, ["kind", "reason"])) {
        throw malformed(
          "resumableState.pendingBudgetDecision contains unversioned fields",
        );
      }
      result.pendingBudgetDecision = {
        kind: "stop",
        reason: requiredText(
          decision.reason,
          "resumableState.pendingBudgetDecision.reason",
        ),
      };
    } else {
      throw malformed("resumableState.pendingBudgetDecision.kind is invalid");
    }
  }
  return result;
}

function* prefixMessages(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
): Iterable<ToolResultIntegrityResponseItem> {
  for (let index = 0; index < count; index += 1) {
    const message = messages[index];
    if (message !== undefined) yield message;
  }
}

function writeOptionalString(
  writer: CanonicalSha256Writer,
  label: string,
  value: string | undefined,
): void {
  writer.writeString(`${label}-present`, String(value !== undefined));
  if (value !== undefined) writer.writeString(label, value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformed(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw malformed(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw malformed(`${field} must be a non-empty string`);
  }
  return value;
}

function malformed(message: string): DurableCheckpointReadError {
  return new DurableCheckpointReadError("checkpoint_shape_invalid", message);
}

function safeVersion(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  return `<${typeof value}>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
): boolean {
  const allowed = new Set(known);
  return Object.keys(value).every((key) => allowed.has(key));
}
