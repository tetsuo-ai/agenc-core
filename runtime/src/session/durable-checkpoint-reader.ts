import {
  type LegacyTurnCheckpointSliceLine,
  type TurnCheckpointSliceLine,
  type TurnCheckpointV1Event,
  type TurnCheckpointV2Event,
  type TurnCheckpointV3Event,
  type TurnCheckpointV4Event,
} from "./event-log.js";
import type { ToolResultIntegrityResponseItem } from "./rollout-item.js";
import {
  assertAgentInvocationChannelMessage,
  validateAgentInvocationMessageSequence,
} from "../contracts/agent-invocation-envelope.js";
import { assertCompactionHistoryMarkerV1 } from "./compaction-history-marker.js";
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
  type ToolPairDanglingUse,
  type ToolPairIntegrityFailure,
  type ToolPairOperationalDeferral,
  type ToolPairProjection,
  type ToolPairProjectionSummary,
} from "./tool-pair-validator.js";
import {
  LEGACY_TURN_CHECKPOINT_SLICE_KEYS,
  TURN_CHECKPOINT_SLICE_KEYS,
  type PendingAdmissionFallbackSlice,
  validatePendingAdmissionFallbackSlice,
} from "./turn-checkpoint-slice.js";

export const LEGACY_DURABLE_CHECKPOINT_VERSION = 1 as const;
export const DURABLE_CHECKPOINT_V2 = 2 as const;
export const DURABLE_CHECKPOINT_V3 = 3 as const;
export const DURABLE_CHECKPOINT_READ_VERSION = 4 as const;
export const DURABLE_CHECKPOINT_WRITE_VERSION = DURABLE_CHECKPOINT_READ_VERSION;
export const DURABLE_ROLLOUT_SCHEMA_V2 = 2 as const;
export const DURABLE_ROLLOUT_SCHEMA_V3 = 3 as const;
export const DURABLE_ROLLOUT_SCHEMA_V4 = 4 as const;
export { ROLLOUT_SCHEMA_VERSION as DURABLE_ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
export const MAX_CHECKPOINT_PREFIX_MESSAGES = 2_000_000;

const CHECKPOINT_PREFIX_V2_DIGEST_DOMAIN = "agenc.checkpoint-prefix.v2";
const CHECKPOINT_PREFIX_V3_DIGEST_DOMAIN = "agenc.checkpoint-prefix.v3";
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
const RESPONSE_ITEM_KEYS = Object.freeze([
  "agentInvocation",
  "compactionHistory",
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
      readonly sourceVersion: typeof LEGACY_DURABLE_CHECKPOINT_VERSION;
      readonly checkpoint: TurnCheckpointV1Event;
    }
  | {
      readonly version: typeof DURABLE_CHECKPOINT_V2;
      readonly sourceVersion: typeof DURABLE_CHECKPOINT_V2;
      readonly checkpoint: TurnCheckpointV2Event;
    }
  | {
      readonly version: typeof DURABLE_CHECKPOINT_V3;
      readonly sourceVersion:
        typeof DURABLE_CHECKPOINT_V2 | typeof DURABLE_CHECKPOINT_V3;
      readonly checkpoint: TurnCheckpointV3Event;
    }
  | {
      readonly version: typeof DURABLE_CHECKPOINT_READ_VERSION;
      readonly sourceVersion: typeof DURABLE_CHECKPOINT_READ_VERSION;
      readonly checkpoint: TurnCheckpointV4Event;
    };

type ReadableCheckpointVersion =
  | typeof LEGACY_DURABLE_CHECKPOINT_VERSION
  | typeof DURABLE_CHECKPOINT_V2
  | typeof DURABLE_CHECKPOINT_V3
  | typeof DURABLE_CHECKPOINT_READ_VERSION;

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
    | "agent_invocation_integrity_failure"
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
      readonly danglingToolCalls: number;
      readonly danglingToolUses: ReadonlyArray<ToolPairDanglingUse>;
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
  const { rawVersion, version } = readCheckpointVersion(payload);
  const expectedKeys = checkpointEnvelopeKeys(version, rawVersion);
  if (!hasExactKeys(payload, expectedKeys)) {
    throw malformed("checkpoint payload contains unversioned fields");
  }

  if (version === LEGACY_DURABLE_CHECKPOINT_VERSION) {
    return readLegacyTurnCheckpoint(payload, rawVersion);
  }
  return readIntegrityTurnCheckpoint(payload, version);
}

function readCheckpointVersion(payload: Record<string, unknown>): {
  readonly rawVersion: unknown;
  readonly version: ReadableCheckpointVersion;
} {
  const rawVersion = payload.checkpointVersion;
  const version =
    rawVersion === undefined ? LEGACY_DURABLE_CHECKPOINT_VERSION : rawVersion;
  if (
    version !== LEGACY_DURABLE_CHECKPOINT_VERSION &&
    version !== DURABLE_CHECKPOINT_V2 &&
    version !== DURABLE_CHECKPOINT_V3 &&
    version !== DURABLE_CHECKPOINT_READ_VERSION
  ) {
    throw new DurableCheckpointReadError(
      "checkpoint_version_unsupported",
      `durable checkpoint version ${safeVersion(version)} is not readable; maximum is ${DURABLE_CHECKPOINT_READ_VERSION}`,
    );
  }
  return { rawVersion, version };
}

function checkpointEnvelopeKeys(
  version: ReadableCheckpointVersion,
  rawVersion: unknown,
): readonly string[] {
  if (version !== LEGACY_DURABLE_CHECKPOINT_VERSION) {
    const keys = [
      ...CHECKPOINT_BASE_KEYS,
      "checkpointVersion",
      "toolResultIntegrityVersion",
    ];
    return version === DURABLE_CHECKPOINT_READ_VERSION
      ? [...keys, "prefixHashVersion"]
      : keys;
  }
  if (rawVersion === undefined) return CHECKPOINT_BASE_KEYS;
  return [...CHECKPOINT_BASE_KEYS, "checkpointVersion"];
}

function readLegacyTurnCheckpoint(
  payload: Record<string, unknown>,
  rawVersion: unknown,
): Extract<
  ReadableTurnCheckpoint,
  { readonly version: typeof LEGACY_DURABLE_CHECKPOINT_VERSION }
> {
  if (
    payload.toolResultIntegrityVersion !== undefined ||
    (rawVersion !== undefined && rawVersion !== 1)
  ) {
    throw malformed("legacy checkpoint carries incompatible v2 metadata");
  }
  return {
    version: LEGACY_DURABLE_CHECKPOINT_VERSION,
    sourceVersion: LEGACY_DURABLE_CHECKPOINT_VERSION,
    checkpoint: {
      ...parseCheckpointBase(payload, "legacy"),
      ...(rawVersion === 1 ? { checkpointVersion: 1 as const } : {}),
    },
  };
}

function readIntegrityTurnCheckpoint(
  payload: Record<string, unknown>,
  version:
    | typeof DURABLE_CHECKPOINT_V2
    | typeof DURABLE_CHECKPOINT_V3
    | typeof DURABLE_CHECKPOINT_READ_VERSION,
): Exclude<
  ReadableTurnCheckpoint,
  { readonly version: typeof LEGACY_DURABLE_CHECKPOINT_VERSION }
> {
  if (payload.toolResultIntegrityVersion !== 1) {
    throw malformed(
      `checkpoint v${version} requires toolResultIntegrityVersion 1`,
    );
  }
  if (version === DURABLE_CHECKPOINT_READ_VERSION) {
    if (payload.prefixHashVersion !== 3) {
      throw malformed(
        `checkpoint v${version} requires prefixHashVersion 3`,
      );
    }
    return {
      version,
      sourceVersion: version,
      checkpoint: {
        ...parseCheckpointBase(payload, "current"),
        checkpointVersion: version,
        toolResultIntegrityVersion: 1,
        prefixHashVersion: 3,
      },
    };
  }
  const hasWriterExtensions = checkpointSliceHasWriterExtensions(
    payload.resumableState,
  );
  if (version === DURABLE_CHECKPOINT_V2 && !hasWriterExtensions) {
    const legacyCommon = parseCheckpointBase(payload, "legacy");
    return {
      version,
      sourceVersion: version,
      checkpoint: {
        ...legacyCommon,
        checkpointVersion: DURABLE_CHECKPOINT_V2,
        toolResultIntegrityVersion: 1,
      },
    };
  }
  return {
    version: DURABLE_CHECKPOINT_V3,
    sourceVersion: version,
    checkpoint: {
      ...parseCheckpointBase(payload, "current"),
      checkpointVersion: DURABLE_CHECKPOINT_V3,
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
  return computeCheckpointPrefixHash(
    messages,
    count,
    CHECKPOINT_PREFIX_V2_DIGEST_DOMAIN,
    false,
  );
}

/** Compute the v3 prefix digest, including durable compaction markers. */
export function computeCheckpointPrefixHashV3(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
): string {
  return computeCheckpointPrefixHash(
    messages,
    count,
    CHECKPOINT_PREFIX_V3_DIGEST_DOMAIN,
    true,
  );
}

function computeCheckpointPrefixHash(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
  digestDomain: string,
  authenticateCompactionHistory: boolean,
): string {
  if (!Number.isSafeInteger(count) || count < 0 || count > messages.length) {
    throw new Error("checkpoint prefix count is outside the available history");
  }
  validateAgentInvocationResponseSequence(messages.slice(0, count));
  const writer = new CanonicalSha256Writer(digestDomain);
  writer.writeCount("message-count", count);
  for (let index = 0; index < count; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`checkpoint prefix message ${index} is missing`);
    }
    assertResponseItemShape(message, index, authenticateCompactionHistory);
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

    const agentInvocation = message.agentInvocation;
    if (agentInvocation !== undefined) {
      writer.writeCount("agent-invocation-version", agentInvocation.version);
      writer.writeString("agent-invocation-kind", agentInvocation.kind);
      writer.writeString("agent-invocation-id", agentInvocation.invocationId);
      writer.writeCount(
        "agent-invocation-minimum-reader-version",
        agentInvocation.minimumReaderVersion,
      );
      writer.writeString(
        "agent-invocation-envelope-digest",
        agentInvocation.envelopeDigest,
      );
      writer.writeString(
        "agent-invocation-authority",
        agentInvocation.authority,
      );
      writer.writeCount(
        "agent-invocation-channel-index",
        agentInvocation.channelIndex,
      );
      writer.writeCount(
        "agent-invocation-channel-count",
        agentInvocation.channelCount,
      );
      writer.writeString(
        "agent-invocation-content-digest",
        agentInvocation.contentSha256,
      );
      writer.writeCount(
        "agent-invocation-content-byte-length",
        agentInvocation.contentByteLength,
      );
    }

    if (authenticateCompactionHistory) {
      const compactionHistory = message.compactionHistory;
      writer.writeString(
        "compaction-history-present",
        String(compactionHistory !== undefined),
      );
      if (compactionHistory !== undefined) {
        writer.writeCount(
          "compaction-history-version",
          compactionHistory.version,
        );
        writer.writeString("compaction-history-kind", compactionHistory.kind);
        writer.writeString(
          "compaction-history-attempt-id",
          compactionHistory.attempt_id,
        );
        writer.writeString(
          "compaction-history-summary-sha256",
          compactionHistory.summary_sha256,
        );
      }
    }
  }
  return writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length);
}

/**
 * Validate v2 body metadata, exact call/result order, and the checkpoint hash.
 * Only `status: "valid"` is executable; invalid and deferred outcomes fail
 * closed for the A3b resume gate.
 */
interface CheckpointPrefixValidationParams<Checkpoint> {
  readonly checkpoint: Checkpoint;
  readonly expectedRunId: string;
  readonly messages: ReadonlyArray<ToolResultIntegrityResponseItem>;
  readonly projection: ToolPairProjection;
  readonly projectionId: string;
  readonly sourceKey: string;
  readonly maxPrefixMessages?: number;
}

type IntegrityTurnCheckpoint =
  | TurnCheckpointV2Event
  | TurnCheckpointV3Event
  | TurnCheckpointV4Event;

export function validateCheckpointPrefixV2(
  params: CheckpointPrefixValidationParams<
    TurnCheckpointV2Event | TurnCheckpointV3Event
  >,
): DurableCheckpointPrefixValidation {
  return validateCheckpointPrefixWithHasher(
    params,
    computeCheckpointPrefixHashV2,
    false,
  );
}

export function validateCheckpointPrefixV3(
  params: CheckpointPrefixValidationParams<TurnCheckpointV4Event>,
): DurableCheckpointPrefixValidation {
  return validateCheckpointPrefixWithHasher(
    params,
    computeCheckpointPrefixHashV3,
    true,
  );
}

/** Strictly bind each checkpoint version to its one prefix-hash algorithm. */
export function validateCheckpointPrefix(
  params: CheckpointPrefixValidationParams<IntegrityTurnCheckpoint>,
): DurableCheckpointPrefixValidation {
  if (params.checkpoint.checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION) {
    return validateCheckpointPrefixV3({
      ...params,
      checkpoint: params.checkpoint,
    });
  }
  return validateCheckpointPrefixV2({
    ...params,
    checkpoint: params.checkpoint,
  });
}

function validateCheckpointPrefixWithHasher(
  params: CheckpointPrefixValidationParams<IntegrityTurnCheckpoint>,
  computePrefixHash: (
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
    count: number,
  ) => string,
  authenticateCompactionHistory: boolean,
): DurableCheckpointPrefixValidation {
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
        assertResponseItemShape(
          message,
          index,
          authenticateCompactionHistory,
        );
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

  try {
    validateAgentInvocationResponseSequence([
      ...prefixMessages(params.messages, count),
    ]);
  } catch (error) {
    if (error instanceof DurableCheckpointReadError) {
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "agent_invocation_integrity_failure",
          index: null,
          reason: error.message,
        },
      };
    }
    throw error;
  }

  const toolPairs = validateToolPairSequence(
    prefixMessages(params.messages, count),
    params.projection,
    {
      projectionId: params.projectionId,
      sourceKey: params.sourceKey,
      requireResultIntegrity: true,
      expectedRunId: params.expectedRunId,
      allowDanglingAtEnd: params.checkpoint.boundary === "postAssistant",
    },
  );
  if (toolPairs.status === "invalid" || toolPairs.status === "deferred") {
    return toolPairs;
  }

  let prefixHash: string;
  try {
    prefixHash = computePrefixHash(params.messages, count);
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
  return {
    status: "valid",
    prefixHash,
    toolPairs: toolPairs.summary,
    danglingToolCalls:
      toolPairs.status === "dangling" ? toolPairs.summary.openCallCount : 0,
    danglingToolUses:
      toolPairs.status === "dangling" ? toolPairs.danglingToolUses : [],
  };
}

function parseCheckpointBase(
  payload: Record<string, unknown>,
  sliceVersion: "legacy",
): Omit<TurnCheckpointV1Event, "checkpointVersion">;
function parseCheckpointBase(
  payload: Record<string, unknown>,
  sliceVersion: "current",
): Omit<
  TurnCheckpointV3Event,
  "checkpointVersion" | "toolResultIntegrityVersion"
>;
function parseCheckpointBase(
  payload: Record<string, unknown>,
  sliceVersion: "legacy" | "current",
):
  | Omit<TurnCheckpointV1Event, "checkpointVersion">
  | Omit<
      TurnCheckpointV3Event,
      "checkpointVersion" | "toolResultIntegrityVersion"
    > {
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
    resumableState:
      sliceVersion === "legacy"
        ? parseCheckpointSlice(payload.resumableState, "legacy")
        : parseCheckpointSlice(payload.resumableState, "current"),
  };
}

function assertResponseItemShape(
  item: ToolResultIntegrityResponseItem,
  index: number,
  authenticateCompactionHistory: boolean,
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
  if (item.agentInvocation !== undefined) {
    try {
      assertAgentInvocationChannelMessage({
        role: item.role,
        content: item.content,
        runtimeOnly: { agentInvocation: item.agentInvocation },
      });
    } catch (error) {
      throw malformed(
        `checkpoint response item ${index} has invalid agent invocation metadata: ${errorMessage(error)}`,
      );
    }
  }
  if (item.compactionHistory !== undefined) {
    if (!authenticateCompactionHistory) {
      throw malformed(
        `checkpoint response item ${index} compactionHistory requires prefix hash version 3`,
      );
    }
    try {
      assertCompactionHistoryMarkerV1(item.compactionHistory);
    } catch (error) {
      throw malformed(
        `checkpoint response item ${index} has invalid compaction-history metadata: ${errorMessage(error)}`,
      );
    }
  }
}

function validateAgentInvocationResponseSequence(
  items: readonly ToolResultIntegrityResponseItem[],
): void {
  try {
    validateAgentInvocationMessageSequence(
      items.map((item) => ({
        role: item.role,
        content: item.content,
        ...(item.agentInvocation !== undefined
          ? { runtimeOnly: { agentInvocation: item.agentInvocation } }
          : {}),
      })),
    );
  } catch (error) {
    throw malformed(
      `agent invocation sequence is invalid: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCheckpointSlice(
  value: unknown,
  sliceVersion: "legacy",
): LegacyTurnCheckpointSliceLine;
function parseCheckpointSlice(
  value: unknown,
  sliceVersion: "current",
): TurnCheckpointSliceLine;
function parseCheckpointSlice(
  value: unknown,
  sliceVersion: "legacy" | "current",
): TurnCheckpointSliceLine | LegacyTurnCheckpointSliceLine {
  if (!isRecord(value)) throw malformed("resumableState must be an object");
  const keys = checkpointSliceKeys(sliceVersion);
  if (!hasOnlyKnownKeys(value, keys)) {
    throw malformed("resumableState contains unversioned fields");
  }
  return {
    ...parseRequiredCheckpointSlice(value),
    ...parseCheckpointRetryCounts(value),
    ...parseCheckpointAdmissionState(value),
    ...parseCheckpointModelSampleState(value),
    ...parseCheckpointBudgetState(value),
    ...parseCheckpointAutoCompactState(value),
    ...parseCheckpointTransitionState(value),
  };
}

function checkpointSliceKeys(
  sliceVersion: "legacy" | "current",
): readonly string[] {
  if (sliceVersion === "legacy") return LEGACY_TURN_CHECKPOINT_SLICE_KEYS;
  return TURN_CHECKPOINT_SLICE_KEYS;
}

function parseRequiredCheckpointSlice(
  value: Record<string, unknown>,
): Pick<
  TurnCheckpointSliceLine,
  | "turnCount"
  | "recoveryReentryCount"
  | "maxOutputTokensRecoveryCount"
  | "continuationNudgeCount"
  | "stopHookBlockingCount"
> {
  return {
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
}

interface ParsedCheckpointRetryCounts {
  planToolRequiredRetryCount?: number;
}

function parseCheckpointRetryCounts(
  value: Record<string, unknown>,
): ParsedCheckpointRetryCounts {
  const result: ParsedCheckpointRetryCounts = {};
  if (value.planToolRequiredRetryCount !== undefined) {
    result.planToolRequiredRetryCount = nonNegativeInteger(
      value.planToolRequiredRetryCount,
      "resumableState.planToolRequiredRetryCount",
    );
  }
  return result;
}

interface ParsedCheckpointAdmissionState {
  editorToolCallsAdmitted?: number;
  pendingAdmissionFallback?: PendingAdmissionFallbackSlice;
}

function parseCheckpointAdmissionState(
  value: Record<string, unknown>,
): ParsedCheckpointAdmissionState {
  const result: ParsedCheckpointAdmissionState = {};
  if (value.editorToolCallsAdmitted !== undefined) {
    result.editorToolCallsAdmitted = nonNegativeInteger(
      value.editorToolCallsAdmitted,
      "resumableState.editorToolCallsAdmitted",
    );
  }
  if (value.pendingAdmissionFallback !== undefined) {
    const fallback = validatePendingAdmissionFallbackSlice(
      value.pendingAdmissionFallback,
      "resumableState.pendingAdmissionFallback",
    );
    if (!fallback.ok) throw malformed(fallback.reason);
    result.pendingAdmissionFallback = fallback.value;
  }
  return result;
}

interface ParsedCheckpointModelSampleState {
  modelSampleOrdinal?: number;
  modelSampleResumePrompt?: "continuation_nudge" | "empty_response";
}

function parseCheckpointModelSampleState(
  value: Record<string, unknown>,
): ParsedCheckpointModelSampleState {
  const result: ParsedCheckpointModelSampleState = {};
  if (value.modelSampleOrdinal !== undefined) {
    result.modelSampleOrdinal = nonNegativeInteger(
      value.modelSampleOrdinal,
      "resumableState.modelSampleOrdinal",
    );
  }
  if (value.modelSampleResumePrompt !== undefined) {
    if (
      value.modelSampleResumePrompt !== "continuation_nudge" &&
      value.modelSampleResumePrompt !== "empty_response"
    ) {
      throw malformed("resumableState.modelSampleResumePrompt is invalid");
    }
    result.modelSampleResumePrompt = value.modelSampleResumePrompt;
  }
  return result;
}

type PendingBudgetDecision =
  | { readonly kind: "continue"; readonly remaining: number }
  | { readonly kind: "stop"; readonly reason: string };

interface ParsedCheckpointBudgetState {
  taskBudgetRemaining?: number;
  pendingBudgetDecision?: PendingBudgetDecision;
}

function parseCheckpointBudgetState(
  value: Record<string, unknown>,
): ParsedCheckpointBudgetState {
  const result: ParsedCheckpointBudgetState = {};
  if (value.taskBudgetRemaining !== undefined) {
    result.taskBudgetRemaining = nonNegativeInteger(
      value.taskBudgetRemaining,
      "resumableState.taskBudgetRemaining",
    );
  }
  const pendingBudgetDecision = parsePendingBudgetDecision(
    value.pendingBudgetDecision,
  );
  if (pendingBudgetDecision !== undefined) {
    result.pendingBudgetDecision = pendingBudgetDecision;
  }
  return result;
}

function parsePendingBudgetDecision(
  value: unknown,
): PendingBudgetDecision | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw malformed("resumableState.pendingBudgetDecision must be an object");
  }
  if (value.kind === "continue") {
    if (!hasExactKeys(value, ["kind", "remaining"])) {
      throw malformed(
        "resumableState.pendingBudgetDecision contains unversioned fields",
      );
    }
    return {
      kind: "continue",
      remaining: nonNegativeInteger(
        value.remaining,
        "resumableState.pendingBudgetDecision.remaining",
      ),
    };
  }
  if (value.kind === "stop") {
    if (!hasExactKeys(value, ["kind", "reason"])) {
      throw malformed(
        "resumableState.pendingBudgetDecision contains unversioned fields",
      );
    }
    return {
      kind: "stop",
      reason: requiredText(
        value.reason,
        "resumableState.pendingBudgetDecision.reason",
      ),
    };
  }
  throw malformed("resumableState.pendingBudgetDecision.kind is invalid");
}

interface ParsedAutoCompactState {
  autoCompactTracking?: {
    readonly compacted: boolean;
    readonly turnId: string;
    readonly turnCounter: number;
    readonly consecutiveFailures: number;
  };
}

function parseCheckpointAutoCompactState(
  value: Record<string, unknown>,
): ParsedAutoCompactState {
  const rawTracking = value.autoCompactTracking;
  if (rawTracking === undefined) return {};
  if (!isRecord(rawTracking)) {
    throw malformed("resumableState.autoCompactTracking must be an object");
  }
  if (
    !hasExactKeys(rawTracking, [
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
  if (typeof rawTracking.compacted !== "boolean") {
    throw malformed("resumableState.autoCompactTracking.compacted is invalid");
  }
  return {
    autoCompactTracking: {
      compacted: rawTracking.compacted,
      turnId: requiredText(
        rawTracking.turnId,
        "resumableState.autoCompactTracking.turnId",
      ),
      turnCounter: nonNegativeInteger(
        rawTracking.turnCounter,
        "resumableState.autoCompactTracking.turnCounter",
      ),
      consecutiveFailures: nonNegativeInteger(
        rawTracking.consecutiveFailures,
        "resumableState.autoCompactTracking.consecutiveFailures",
      ),
    },
  };
}

interface ParsedCheckpointTransitionState {
  transition?: { readonly reason: string };
}

function parseCheckpointTransitionState(
  value: Record<string, unknown>,
): ParsedCheckpointTransitionState {
  const transition = value.transition;
  if (transition === undefined) return {};
  if (!isRecord(transition)) {
    throw malformed("resumableState.transition must be an object");
  }
  if (!hasExactKeys(transition, ["reason"])) {
    throw malformed("resumableState.transition contains unversioned fields");
  }
  return {
    transition: {
      reason: requiredText(
        transition.reason,
        "resumableState.transition.reason",
      ),
    },
  };
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

function checkpointSliceHasWriterExtensions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.hasOwn(value, "editorToolCallsAdmitted") ||
    Object.hasOwn(value, "pendingAdmissionFallback")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const expectedKeys = new Set(expected);
  return actual.every((key) => expectedKeys.has(key));
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
): boolean {
  const allowed = new Set(known);
  return Object.keys(value).every((key) => allowed.has(key));
}
