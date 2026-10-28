import { readReasoningCapPolicy, type ReasoningCapPolicyState } from "./reasoning-cap-policy.js";
import {
  type LegacyTurnCheckpointSliceLine,
  type TurnCheckpointSliceLine,
  type TurnCheckpointV1Event,
  type TurnCheckpointV2Event,
  type TurnCheckpointV3Event,
  type TurnCheckpointV4Event,
} from "./event-log.js";
import { readProviderContextHistory } from "../llm/wire/responses-openai-context.js";
import { isKnownEmptyProviderReasoning } from "../llm/types.js";
import type { ToolResultIntegrityResponseItem } from "./rollout-item.js";
import {
  assertAgentInvocationChannelMessage,
  validateAgentInvocationMessageSequence,
} from "../contracts/agent-invocation-envelope.js";
import { assertCompactionHistoryMarkerV1 } from "./compaction-history-marker.js";
import {
  CanonicalFieldRecorder,
  CanonicalRecordLog,
  CanonicalSha256Writer,
  TOOL_RESULT_DIGEST_PREFIX,
  ToolResultCanonicalizationError,
  constantTimeDigestEqual,
  digestToolResultBody,
  type CanonicalFieldRecord,
  type CanonicalFieldWriter,
  type ToolResultIntegrityDeferral,
  type ToolResultIntegrityFailure,
} from "./tool-result-integrity.js";
import {
  StreamingToolPairValidator,
  validateToolPairSequence,
  type ToolPairDanglingUse,
  type ToolPairIntegrityFailure,
  type ToolPairOperationalDeferral,
  type ToolPairProjection,
  type ToolPairProjectionSummary,
  type ToolPairValidationOutcome,
} from "./tool-pair-validator.js";
import {
  LEGACY_TURN_CHECKPOINT_SLICE_KEYS,
  TURN_CHECKPOINT_SLICE_KEYS,
  type PendingAdmissionFallbackSlice,
  validatePendingAdmissionFallbackSlice,
} from "./turn-checkpoint-slice.js";
import { readTextToolCallCorrection, type TextToolCallCorrection } from "../recovery/rejected-text-tool-call.js";
import { isRecoveryToolResult } from "./recovery-tool-result.js";

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
const CHECKPOINT_PREFIX_V4_DIGEST_DOMAIN = "agenc.checkpoint-prefix.v4";
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
  "providerReasoning",
  "providerContextHistory",
  "role",
  "toolCallId",
  "toolCalls",
  "toolName",
  "toolResultIntegrity",
  "toolResultIsError",
]);
const TOOL_CALL_KEYS = Object.freeze(["arguments", "id", "name"]);
const PROVIDER_REASONING_V1_KEYS = Object.freeze(["content", "version"]);
const PROVIDER_REASONING_V2_KEYS = Object.freeze([
  "content",
  "model",
  "provider",
  "version",
]);

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
    if (payload.prefixHashVersion !== 3 && payload.prefixHashVersion !== 4) {
      throw malformed(
        `checkpoint v${version} requires prefixHashVersion 3 or 4`,
      );
    }
    return {
      version,
      sourceVersion: version,
      checkpoint: {
        ...parseCheckpointBase(payload, "current"),
        checkpointVersion: version,
        toolResultIntegrityVersion: 1,
        prefixHashVersion: payload.prefixHashVersion,
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

/** Current writer: authenticate failure metadata in its own digest version. */
export function computeCheckpointPrefixHashV4(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
): string {
  return computeCheckpointPrefixHash(messages, count, CHECKPOINT_PREFIX_V4_DIGEST_DOMAIN, true, true);
}

function computeCheckpointPrefixHash(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  count: number,
  digestDomain: string,
  authenticateCompactionHistory: boolean,
  authenticateToolResultStatus = false,
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
    writeCheckpointPrefixMessage(
      writer,
      message,
      authenticateCompactionHistory,
      authenticateToolResultStatus,
    );
  }
  return writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length);
}

/**
 * One v4 prefix message, recorded once so a writer can digest a growing
 * history without re-encoding it. It holds the message's canonical fields as
 * {@link computeCheckpointPrefixHashV4} writes them after `message-index`.
 */
export interface CheckpointPrefixRecordV4 {
  readonly fields: CanonicalFieldRecord;
}

/** A recorded v4 prefix message bound to its position in the prefix. */
export interface PositionedCheckpointPrefixRecordV4 {
  readonly index: number;
  readonly record: CheckpointPrefixRecordV4;
  readonly position: CanonicalFieldRecord;
}

const checkpointPrefixRecordsV4 = new WeakSet<CheckpointPrefixRecordV4>();
const positionedCheckpointPrefixRecordsV4 =
  new WeakSet<PositionedCheckpointPrefixRecordV4>();

/**
 * Apply the v4 per-message gate (the same shape assertion as the full digest)
 * and record the fields the digest writes for this message. `index` only
 * labels errors; the record itself is position independent.
 */
export function recordCheckpointPrefixMessageV4(
  message: ToolResultIntegrityResponseItem,
  index: number,
): CheckpointPrefixRecordV4 {
  assertResponseItemShape(message, index, true);
  const recorder = new CanonicalFieldRecorder();
  writeCheckpointPrefixMessage(recorder, message, true, true);
  const record = Object.freeze({ fields: recorder.finish() });
  checkpointPrefixRecordsV4.add(record);
  return record;
}

/** Bind a recorded message to `index`, framing `message-index` exactly. */
export function positionCheckpointPrefixRecordV4(
  record: CheckpointPrefixRecordV4,
  index: number,
): PositionedCheckpointPrefixRecordV4 {
  if (!checkpointPrefixRecordsV4.has(record)) {
    throw new TypeError("checkpoint prefix record was not produced by recordCheckpointPrefixMessageV4");
  }
  const recorder = new CanonicalFieldRecorder();
  recorder.writeCount("message-index", index);
  const positioned = Object.freeze({ index, record, position: recorder.finish() });
  positionedCheckpointPrefixRecordsV4.add(positioned);
  return positioned;
}

/**
 * The v4 prefix digest of a history whose messages were recorded one by one.
 * Equal to {@link computeCheckpointPrefixHashV4} over those messages once the
 * caller has also validated their agent-invocation sequence
 * ({@link validateCheckpointPrefixInvocationSequenceV4}); it replays the
 * recorded bytes instead of encoding every message again.
 */
export function computeCheckpointPrefixHashV4FromRecords(
  records: ReadonlyArray<PositionedCheckpointPrefixRecordV4>,
): string {
  const writer = new CanonicalSha256Writer(CHECKPOINT_PREFIX_V4_DIGEST_DOMAIN);
  writer.writeCount("message-count", records.length);
  for (let index = 0; index < records.length; index += 1) {
    const positioned = records[index];
    if (
      positioned === undefined ||
      !positionedCheckpointPrefixRecordsV4.has(positioned) ||
      positioned.index !== index
    ) {
      throw new Error(`checkpoint prefix record ${index} is missing or misplaced`);
    }
    writer.writeRecord(positioned.position);
    writer.writeRecord(positioned.record.fields);
  }
  return writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length);
}

/**
 * The agent-invocation sequence gate of the v4 digest. A message without
 * invocation metadata only contributes its content check, so callers that
 * validated that check once may pass `content: ""` for it here.
 */
export function validateCheckpointPrefixInvocationSequenceV4(
  items: ReadonlyArray<Pick<ToolResultIntegrityResponseItem, "role" | "content" | "agentInvocation">>,
): void {
  validateAgentInvocationResponseSequence(items as readonly ToolResultIntegrityResponseItem[]);
}

function writeCheckpointPrefixMessage(
  writer: CanonicalFieldWriter,
  message: ToolResultIntegrityResponseItem,
  authenticateCompactionHistory: boolean,
  authenticateToolResultStatus: boolean,
): void {
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
  // Failure status was absent from historical digest versions. Only the
  // explicit new algorithm authenticates it; there is no fallback.
  if (authenticateToolResultStatus && message.toolResultIsError === true) {
    writer.writeString("tool-result-is-error", "true");
  }
  writeOptionalString(writer, "phase", message.phase);
  writer.writeString(
    "end-turn-present",
    String(message.endTurn !== undefined),
  );
  if (message.endTurn !== undefined) {
    writer.writeString("end-turn", String(message.endTurn));
  }

  // Conditional encoding preserves existing checkpoint hashes when the
  // optional field is absent, while authenticating every new replay value.
  if (message.providerContextHistory !== undefined) {
    writer.writeString("provider-context-history", JSON.stringify(message.providerContextHistory));
  }
  if (message.providerReasoning !== undefined) {
    writer.writeCount(
      "provider-reasoning-version",
      message.providerReasoning.version,
    );
    writer.writeString(
      "provider-reasoning-content",
      message.providerReasoning.content,
    );
    if (message.providerReasoning.version === 2) {
      writer.writeString(
        "provider-reasoning-provider",
        message.providerReasoning.provider,
      );
      writer.writeString(
        "provider-reasoning-model",
        message.providerReasoning.model,
      );
    }
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
  if (params.checkpoint.prefixHashVersion !== 3) {
    return invalidPrefixHashVersion();
  }
  return validateCheckpointPrefixWithHasher(
    params,
    computeCheckpointPrefixHashV3,
    true,
  );
}

export function validateCheckpointPrefixV4(
  params: CheckpointPrefixValidationParams<TurnCheckpointV4Event>,
): DurableCheckpointPrefixValidation {
  if (params.checkpoint.prefixHashVersion !== 4) return invalidPrefixHashVersion();
  return validateCheckpointPrefixWithHasher(params, computeCheckpointPrefixHashV4, true);
}

function invalidPrefixHashVersion(): DurableCheckpointPrefixValidation {
  return { status: "invalid", failure: { kind: "integrity_failure", code: "checkpoint_response_shape_invalid", index: null, reason: "checkpoint prefix hash version does not match its selected algorithm" } };
}

/**
 * Recovery results the runtime persisted right after a checkpoint's prefix,
 * for the calls that checkpoint left open, before a turn resumed from it. A
 * continued turn that found such a result kept its own pairing out of durable
 * history (#2603), so the checkpoints written after that resume hashed the
 * persisted history without the window.
 */
export interface CheckpointRecoveryWindow {
  /** Persisted history index of the first recovery result. */
  readonly start: number;
  /** Number of consecutive recovery results. */
  readonly length: number;
}

/**
 * Validate a current-schema checkpoint whose digest skipped a recovery
 * window. Every structural gate (item shape, invocation sequence, tool
 * pairing and the seal of every result) still runs over the complete
 * persisted prefix, recovery results included; only the digest input leaves
 * the window out. Each skipped item must be the exact sealed recovery result
 * for its own call, whose body is fixed by the call id and tool name the
 * digest still covers.
 */
export function validateRecoveredCheckpointPrefix(
  params: CheckpointPrefixValidationParams<TurnCheckpointV4Event> & {
    readonly recoveryWindow: CheckpointRecoveryWindow;
  },
): DurableCheckpointPrefixValidation {
  return validateCheckpointPrefixWithHasher(
    params,
    params.checkpoint.prefixHashVersion === 4
      ? computeCheckpointPrefixHashV4
      : computeCheckpointPrefixHashV3,
    true,
    params.recoveryWindow,
  );
}

/** Strictly bind each checkpoint version to its one prefix-hash algorithm. */
export function validateCheckpointPrefix(
  params: CheckpointPrefixValidationParams<IntegrityTurnCheckpoint>,
): DurableCheckpointPrefixValidation {
  if (params.checkpoint.checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION) {
    if (params.checkpoint.prefixHashVersion === 4) {
      return validateCheckpointPrefixV4({ ...params, checkpoint: params.checkpoint });
    }
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

/**
 * Validates the current-schema checkpoints (checkpoint v4, prefix digest v4)
 * of one growing history in order, so that opening a session costs one pass
 * over its messages instead of one pass per checkpoint.
 *
 * {@link validateCheckpointPrefixV4} runs its gates over the whole prefix of
 * every checkpoint: the shape and seal-placement gate per message, the
 * agent-invocation sequence, the tool-pair stream (which also verifies every
 * result's seal), then the digest. Each gate is a left-to-right pass whose
 * state after a prefix that passed is the state a fresh pass reaches there:
 * the per-message gates have no state, a passing invocation sequence never
 * ends inside a channel group, and the tool-pair stream is one streaming
 * validator. So for a checkpoint whose prefix extends the last one, running
 * every gate in the same order over only the new messages, continuing the
 * same tool-pair stream, yields the outcome and failure the full validation
 * yields. The digest replays the recorded canonical bytes of every message in
 * one hash update (its message count is framed first, so each checkpoint still
 * hashes its whole prefix, but nothing is encoded twice).
 *
 * `validate` returns `undefined` whenever that argument does not hold (another
 * checkpoint version, a shorter prefix than one already validated, holes in
 * the history); the caller then runs the full validation. A history whose
 * messages are not the objects validated before starts over from its first
 * message. The tool-pair stream lives under its own projection id, so full
 * validations on the same projection never disturb it. Call {@link close}
 * when done to finish that projection run.
 */
export class IncrementalCheckpointPrefixValidatorV4 {
  readonly #params: Omit<
    CheckpointPrefixValidationParams<TurnCheckpointV4Event>,
    "checkpoint" | "messages" | "maxPrefixMessages"
  >;
  #messages: ReadonlyArray<ToolResultIntegrityResponseItem> | undefined;
  /** The message objects validated so far, by history index. */
  readonly #validated: ToolResultIntegrityResponseItem[] = [];
  #toolPairs: StreamingToolPairValidator | undefined;
  /** Position and field records of every recorded message, in order. */
  readonly #records = new CanonicalRecordLog();
  #recorded = 0;
  #lastDigest: { readonly count: number; readonly prefixHash: string } | undefined;

  constructor(
    params: Omit<
      CheckpointPrefixValidationParams<TurnCheckpointV4Event>,
      "checkpoint" | "messages" | "maxPrefixMessages"
    >,
  ) {
    this.#params = params;
  }

  /** Messages that passed every structural gate of the current history. */
  get validatedMessageCount(): number {
    return this.#validated.length;
  }

  /** Forget the current history; the next checkpoint starts from its first message. */
  reset(): void {
    this.#finishToolPairs();
    this.#messages = undefined;
    this.#validated.length = 0;
    this.#records.truncate(0);
    this.#recorded = 0;
    this.#lastDigest = undefined;
  }

  /** Finish the open tool-pair projection run. The validator can be reused. */
  close(): void {
    this.reset();
  }

  /**
   * The history-derivation work, in message visits, that {@link validate}
   * does for this checkpoint: every message it has not validated yet passes
   * each gate once (`newMessagePasses` visits) and the whole prefix is checked
   * for identity and replayed into the digest (`prefixPasses` visits).
   * Undefined when `validate` would leave the checkpoint to the full validator.
   */
  plannedWork(
    checkpoint: TurnCheckpointV4Event,
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
    newMessagePasses: number,
    prefixPasses: number,
  ): number | undefined {
    const plan = this.#plan(checkpoint, messages);
    if (plan === undefined) return undefined;
    return (plan.count - plan.start) * newMessagePasses + plan.count * prefixPasses;
  }

  /** Where `validate` would start and end, without changing any state. */
  #plan(
    checkpoint: TurnCheckpointV4Event,
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  ): { readonly start: number; readonly count: number; readonly continues: boolean } | undefined {
    if (
      checkpoint.checkpointVersion !== DURABLE_CHECKPOINT_READ_VERSION ||
      checkpoint.prefixHashVersion !== 4
    ) {
      return undefined;
    }
    const count = checkpoint.persistedMessageCount;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > messages.length ||
      count > MAX_CHECKPOINT_PREFIX_MESSAGES
    ) {
      return undefined;
    }
    const continues = this.#continues(messages);
    const start = continues ? this.#validated.length : 0;
    if (count < start) return undefined;
    for (let index = start; index < count; index += 1) {
      if (messages[index] === undefined) return undefined;
    }
    return { start, count, continues };
  }

  validate(
    checkpoint: TurnCheckpointV4Event,
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  ): DurableCheckpointPrefixValidation | undefined {
    const plan = this.#plan(checkpoint, messages);
    if (plan === undefined) return undefined;
    if (!plan.continues) {
      this.reset();
      this.#messages = messages;
    }
    const { start, count } = plan;

    // 1. Shape and seal placement of each new message.
    for (let index = start; index < count; index += 1) {
      const message = messages[index]!;
      try {
        assertResponseItemShape(message, index, true);
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
      if (message.role !== "tool" && message.toolResultIntegrity !== undefined) {
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

    // 2. The invocation sequence of the new messages. The validated prefix
    // passed as a whole, so no channel group straddles its end.
    try {
      validateAgentInvocationResponseSequence(messages.slice(start, count));
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

    // 3. Continue the tool-pair stream, then judge it at this prefix's end.
    const toolPairs = this.#continueToolPairs(
      messages,
      start,
      count,
      checkpoint.boundary === "postAssistant",
    );
    if (toolPairs.status === "invalid" || toolPairs.status === "deferred") {
      return toolPairs;
    }

    // 4. Record each new message once, then digest the whole prefix.
    const recorded = this.#record(messages, count);
    if (recorded !== undefined) return recorded;
    let prefixHash: string;
    if (this.#lastDigest?.count === count) {
      prefixHash = this.#lastDigest.prefixHash;
    } else {
      const writer = new CanonicalSha256Writer(CHECKPOINT_PREFIX_V4_DIGEST_DOMAIN);
      writer.writeCount("message-count", count);
      writer.writeRecordLog(this.#records, 2 * count);
      prefixHash = writer.digest().slice(TOOL_RESULT_DIGEST_PREFIX.length);
      this.#lastDigest = { count, prefixHash };
    }
    if (!constantTimeDigestEqual(prefixHash, checkpoint.prefixHash)) {
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

  /** True when `messages` still holds every message validated so far. */
  #continues(messages: ReadonlyArray<ToolResultIntegrityResponseItem>): boolean {
    if (messages !== this.#messages) return false;
    const validated = this.#validated;
    if (messages.length < validated.length) return false;
    for (let index = 0; index < validated.length; index += 1) {
      if (messages[index] !== validated[index]) return false;
    }
    return true;
  }

  #continueToolPairs(
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
    start: number,
    count: number,
    allowDanglingAtEnd: boolean,
  ): ToolPairValidationOutcome {
    const projection = this.#params.projection;
    let validator = this.#toolPairs;
    try {
      const outcome = projection.runAtomically(() => {
        validator ??= new StreamingToolPairValidator(projection, {
          projectionId: this.#params.projectionId,
          sourceKey: this.#params.sourceKey,
          requireResultIntegrity: true,
          expectedRunId: this.#params.expectedRunId,
        });
        for (let index = start; index < count; index += 1) {
          const failure = validator.push(messages[index]!);
          if (failure !== undefined) return failure;
        }
        return validator.peekFinish(allowDanglingAtEnd);
      });
      if (validator?.terminalFailureOutcome !== undefined) {
        // The stream closed (and its projection run with it); a later
        // checkpoint of this history starts over, as a full validation does.
        this.#toolPairs = undefined;
        this.reset();
        return outcome;
      }
      this.#toolPairs = validator;
      for (let index = start; index < count; index += 1) {
        this.#validated.push(messages[index]!);
      }
      return outcome;
    } catch (error) {
      // The projection rolled back what this call pushed; the stream state
      // no longer matches it, so the history starts over next time.
      const summary = validator?.summary() ?? {
        callCount: 0,
        resolvedCount: 0,
        openCallCount: 0,
        maximumOpenCallCount: 0,
        logicalIndexBytes: 0,
      };
      this.#toolPairs = validator;
      this.reset();
      return {
        status: "deferred",
        failure: {
          kind: "operational_deferral",
          code: "tool_pair_projection_unavailable",
          index: null,
          reason:
            error instanceof Error && error.message.length > 0
              ? `tool-pair projection is unavailable: ${error.message}`
              : "tool-pair projection is unavailable",
        },
        summary,
      };
    }
  }

  /** Record messages up to `count`; a failure maps as the full digest maps it. */
  #record(
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
    count: number,
  ): DurableCheckpointPrefixValidation | undefined {
    for (let index = this.#recorded; index < count; index += 1) {
      let record: CheckpointPrefixRecordV4;
      try {
        record = recordCheckpointPrefixMessageV4(messages[index]!, index);
      } catch (error) {
        return checkpointDigestFailure(error);
      }
      const position = new CanonicalFieldRecorder();
      position.writeCount("message-index", index);
      this.#records.append(position.finish());
      this.#records.append(record.fields);
      this.#recorded = index + 1;
    }
    return undefined;
  }

  /**
   * Close the open projection run (an ephemeral projection discards it). Its
   * outcome was already judged per checkpoint; finishing is cleanup only, so
   * a projection that fails here leaves the run to its next reset.
   */
  #finishToolPairs(): void {
    const validator = this.#toolPairs;
    this.#toolPairs = undefined;
    if (validator === undefined || validator.terminalFailureOutcome !== undefined) return;
    try {
      this.#params.projection.runAtomically(() => {
        validator.finish({ allowDanglingAtEnd: true });
      });
    } catch {
      // Cleanup only; see above.
    }
  }
}

/** Map a digest-time error exactly as {@link validateCheckpointPrefixWithHasher} maps it. */
function checkpointDigestFailure(error: unknown): DurableCheckpointPrefixValidation {
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

function validateCheckpointPrefixWithHasher(
  params: CheckpointPrefixValidationParams<IntegrityTurnCheckpoint>,
  computePrefixHash: (
    messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
    count: number,
  ) => string,
  authenticateCompactionHistory: boolean,
  recoveryWindow?: CheckpointRecoveryWindow,
): DurableCheckpointPrefixValidation {
  // The digest covers `count` messages. A recovery window lies inside the
  // persisted prefix, so every structural gate covers it as well.
  const count = params.checkpoint.persistedMessageCount;
  const persistedCount = count + (recoveryWindow?.length ?? 0);
  if (persistedCount > params.messages.length) {
    return {
      status: "invalid",
      failure: {
        kind: "integrity_failure",
        code: "checkpoint_prefix_missing",
        index: null,
        reason: `checkpoint requires ${persistedCount} messages but only ${params.messages.length} are available`,
      },
    };
  }
  const maxPrefixMessages =
    params.maxPrefixMessages ?? MAX_CHECKPOINT_PREFIX_MESSAGES;
  if (!Number.isSafeInteger(maxPrefixMessages) || maxPrefixMessages <= 0) {
    throw new Error("maxPrefixMessages must be a positive safe integer");
  }
  if (persistedCount > maxPrefixMessages) {
    return {
      status: "deferred",
      failure: {
        kind: "operational_deferral",
        code: "checkpoint_prefix_message_limit",
        index: null,
        reason: `checkpoint prefix has ${persistedCount} messages; limit is ${maxPrefixMessages}`,
      },
    };
  }
  if (recoveryWindow !== undefined) {
    const windowFailure = recoveryWindowFailure(
      params.messages,
      recoveryWindow,
      count,
    );
    if (windowFailure !== undefined) return windowFailure;
  }
  for (let index = 0; index < persistedCount; index += 1) {
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
      ...prefixMessages(params.messages, persistedCount),
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
    prefixMessages(params.messages, persistedCount),
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
    prefixHash = computePrefixHash(
      recoveryWindow === undefined
        ? params.messages
        : withoutRecoveryWindow(params.messages, recoveryWindow, persistedCount),
      count,
    );
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

/**
 * A recovery window must sit inside the persisted prefix and hold only exact
 * sealed recovery results. Their seals and their pairing with the open calls
 * are checked with the rest of the prefix by the tool-pair gate.
 */
function recoveryWindowFailure(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  window: CheckpointRecoveryWindow,
  count: number,
): DurableCheckpointPrefixValidation | undefined {
  const fail = (reason: string): DurableCheckpointPrefixValidation => ({
    status: "invalid",
    failure: {
      kind: "integrity_failure",
      code: "checkpoint_prefix_digest_mismatch",
      index: null,
      reason,
    },
  });
  if (
    !Number.isSafeInteger(window.start) ||
    !Number.isSafeInteger(window.length) ||
    window.start < 0 ||
    window.length <= 0 ||
    window.start > count
  ) {
    return fail("checkpoint recovery window is outside the checkpoint prefix");
  }
  for (let index = window.start; index < window.start + window.length; index += 1) {
    const message = messages[index];
    if (
      message === undefined ||
      message.toolResultIntegrity === undefined ||
      !isRecoveryToolResult(message)
    ) {
      return fail(
        `checkpoint recovery window item ${index} is not a sealed recovery result`,
      );
    }
  }
  return undefined;
}

function withoutRecoveryWindow(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  window: CheckpointRecoveryWindow,
  persistedCount: number,
): ToolResultIntegrityResponseItem[] {
  return [
    ...messages.slice(0, window.start),
    ...messages.slice(window.start + window.length, persistedCount),
  ];
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
  if (item.toolResultIsError !== undefined &&
      (!authenticateCompactionHistory || item.role !== "tool" ||
       item.toolResultIsError !== true)) {
    throw malformed(
      `checkpoint response item ${index} has invalid toolResultIsError (requires checkpoint v4 and a failed tool result)`,
    );
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
  if (item.providerContextHistory !== undefined &&
      (item.role !== "assistant" || readProviderContextHistory(item.providerContextHistory) === undefined)) {
    throw malformed(`checkpoint response item ${index} has invalid provider context history`);
  }
  if (item.providerReasoning !== undefined) {
    if (item.role !== "assistant" || !isRecord(item.providerReasoning)) {
      throw malformed(
        `checkpoint response item ${index} has invalid provider reasoning replay`,
      );
    }
    const providerReasoning = item.providerReasoning as Record<string, unknown>;
    const validV1 =
      providerReasoning.version === 1 &&
      hasOnlyKnownKeys(providerReasoning, PROVIDER_REASONING_V1_KEYS);
    const validV2 =
      providerReasoning.version === 2 &&
      hasOnlyKnownKeys(providerReasoning, PROVIDER_REASONING_V2_KEYS) &&
      typeof providerReasoning.provider === "string" &&
      providerReasoning.provider.trim().length > 0 &&
      typeof providerReasoning.model === "string" &&
      providerReasoning.model.trim().length > 0;
    if (
      (!validV1 && !validV2) ||
      typeof providerReasoning.content !== "string" ||
      (providerReasoning.content.length === 0 &&
        !(validV2 && Array.isArray(item.toolCalls) && item.toolCalls.length > 0 &&
          isKnownEmptyProviderReasoning(providerReasoning.content, providerReasoning)))
    ) {
      throw malformed(
        `checkpoint response item ${index} has invalid provider reasoning replay`,
      );
    }
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
  completionGateRound?: number;
  completionGateSampleStart?: number;
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
  if (value.completionGateSampleStart !== undefined) {
    result.completionGateSampleStart = nonNegativeInteger(
      value.completionGateSampleStart, "resumableState.completionGateSampleStart",
    );
  }
  if (value.completionGateRound !== undefined) {
    result.completionGateRound = nonNegativeInteger(
      value.completionGateRound,
      "resumableState.completionGateRound",
    );
  }
  return result;
}

interface ParsedCheckpointAdmissionState {
  pendingAdmissionFallback?: PendingAdmissionFallbackSlice;
}

function parseCheckpointAdmissionState(
  value: Record<string, unknown>,
): ParsedCheckpointAdmissionState {
  const result: ParsedCheckpointAdmissionState = {};
  // `editorToolCallsAdmitted` (retired editor quota) is accepted and ignored.
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
  reasoningOnlyRecoveryPending?: true;
  reasoningCapPolicy?: ReasoningCapPolicyState;
  reasoningOnlyRecoveryCount?: number;
  modelSampleOrdinal?: number;
  modelSampleResumePrompt?: "continuation_nudge" | "empty_response" | "text_tool_call_correction";
  textToolCallCorrectionCount?: number;
  textToolCallCorrection?: TextToolCallCorrection;
}

function parseCheckpointModelSampleState(
  value: Record<string, unknown>,
): ParsedCheckpointModelSampleState {
  const result: ParsedCheckpointModelSampleState = {};
  if (value.reasoningCapPolicy !== undefined) {
    try { result.reasoningCapPolicy = readReasoningCapPolicy(value.reasoningCapPolicy); }
    catch { throw malformed("resumableState.reasoningCapPolicy is invalid"); }
  }
  if (value.reasoningOnlyRecoveryCount !== undefined) {
    result.reasoningOnlyRecoveryCount = nonNegativeInteger(
      value.reasoningOnlyRecoveryCount, "resumableState.reasoningOnlyRecoveryCount",
    );
  }
  if (value.reasoningOnlyRecoveryPending !== undefined) {
    if (value.reasoningOnlyRecoveryPending !== true) {
      throw malformed("resumableState.reasoningOnlyRecoveryPending is invalid");
    }
    result.reasoningOnlyRecoveryPending = true;
  }
  if (value.modelSampleOrdinal !== undefined) {
    result.modelSampleOrdinal = nonNegativeInteger(
      value.modelSampleOrdinal,
      "resumableState.modelSampleOrdinal",
    );
  }
  if (value.modelSampleResumePrompt !== undefined) {
    if (
      value.modelSampleResumePrompt !== "continuation_nudge" &&
      value.modelSampleResumePrompt !== "empty_response" &&
      value.modelSampleResumePrompt !== "text_tool_call_correction"
    ) {
      throw malformed("resumableState.modelSampleResumePrompt is invalid");
    }
    result.modelSampleResumePrompt = value.modelSampleResumePrompt;
  }
  if (value.textToolCallCorrectionCount !== undefined) {
    result.textToolCallCorrectionCount = nonNegativeInteger(value.textToolCallCorrectionCount, "resumableState.textToolCallCorrectionCount");
  }
  if (value.textToolCallCorrection !== undefined) {
    const correction = readTextToolCallCorrection(value.textToolCallCorrection);
    if (!correction) throw malformed("resumableState.textToolCallCorrection is invalid");
    result.textToolCallCorrection = correction;
  }
  if (result.modelSampleResumePrompt === "text_tool_call_correction" &&
      (result.textToolCallCorrection === undefined || !result.textToolCallCorrectionCount)) {
    throw malformed("resumableState tool-call correction is missing its durable counter or identity");
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
  writer: CanonicalFieldWriter,
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
