import { createHash } from "node:crypto";
import { computePrefixHash } from "./durable-turns.js";
import { emptyReducedState, reduce } from "./event-log-reducer.js";
import type { TurnCheckpointV4Event } from "./event-log.js";
import type {
  RolloutItem,
  ToolResultIntegrityResponseItem,
} from "./rollout-item.js";
import { withoutResponseIds } from "./rollout-item.js";
import {
  DURABLE_CHECKPOINT_READ_VERSION,
  DURABLE_CHECKPOINT_V2,
  DURABLE_CHECKPOINT_V3,
  DURABLE_ROLLOUT_SCHEMA_V2,
  DURABLE_ROLLOUT_SCHEMA_V3,
  DURABLE_ROLLOUT_SCHEMA_V4,
  DURABLE_ROLLOUT_SCHEMA_VERSION,
  LEGACY_DURABLE_CHECKPOINT_VERSION,
  DurableCheckpointReadError,
  MAX_CHECKPOINT_PREFIX_MESSAGES,
  computeCheckpointPrefixHashV3,
  readTurnCheckpoint,
  validateCheckpointPrefix,
  validateCheckpointPrefixV3,
  type DurableCheckpointPrefixDeferral,
  type DurableCheckpointPrefixFailure,
} from "./durable-checkpoint-reader.js";
import {
  ToolResultCanonicalizationError,
  constantTimeDigestEqual,
  createToolResultIntegrity,
  verifyToolResultIntegrity,
  type ToolResultIntegrityDeferral,
  type ToolResultIntegrityFailure,
} from "./tool-result-integrity.js";
import type {
  ToolPairIntegrityFailure,
  ToolPairOperationalDeferral,
  ToolPairProjection,
} from "./tool-pair-validator.js";

const UPGRADE_PROJECTION_ID_DOMAIN = "agenc.checkpoint-upgrade-projection.v1";
// One prefix validation performs shape, invocation-sequence, tool-pair, and
// digest work. Count every complete message-array traversal, including the
// bounded invocation-channel slice/map passes inside sequence validation.
const CURRENT_CHECKPOINT_PREFIX_PASSES = 13;
// A legacy promotion checks the source digest (1), computes the v3 digest (6),
// and validates the generated v4 checkpoint (13).
const LEGACY_CHECKPOINT_PREFIX_PASSES = 20;
// A v2/v3 promotion validates the frozen v2 digest (13), computes the v3
// digest (6), and validates the generated v4 checkpoint (13).
const INTEGRITY_CHECKPOINT_UPGRADE_PREFIX_PASSES = 32;
// Canonical rollback reduction can scan the history, scan backward across
// contextual pre-turn rows, and copy the retained prefix. Reserve all three
// possible passes before invoking it so adversarial rollback streams cannot
// escape the aggregate history-derivation work ceiling.
const ROLLBACK_HISTORY_PASSES = 3;
export const MAX_CHECKPOINT_UPGRADE_HISTORY_WORK =
  MAX_CHECKPOINT_PREFIX_MESSAGES *
  Math.max(
    LEGACY_CHECKPOINT_PREFIX_PASSES,
    INTEGRITY_CHECKPOINT_UPGRADE_PREFIX_PASSES,
  );

export interface DurableCheckpointUpgradePlan {
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: typeof DURABLE_ROLLOUT_SCHEMA_VERSION;
  readonly sessionMetaPromotionRequired: boolean;
  readonly changed: boolean;
  readonly toolResultsSealed: number;
  readonly checkpointsUpgraded: number;
  readonly checkpointsValidated: number;
  readonly upgradedItems: ReadonlyArray<RolloutItem>;
}

export interface DurableCheckpointUpgradeFailure {
  readonly kind: "integrity_failure";
  readonly code:
    | "rollout_schema_unsupported"
    | "rollout_schema_mixed"
    | "rollback_invalid"
    | "tool_result_call_id_missing"
    | "tool_result_integrity_invalid"
    | "checkpoint_invalid";
  readonly itemIndex: number | null;
  readonly reason: string;
  readonly cause?:
    | ToolResultIntegrityFailure
    | DurableCheckpointPrefixFailure
    | ToolPairIntegrityFailure;
}

export interface DurableCheckpointUpgradeDeferral {
  readonly kind: "operational_deferral";
  readonly code:
    | "tool_result_integrity_deferred"
    | "checkpoint_validation_deferred"
    | "history_derivation_work_limit";
  readonly itemIndex: number | null;
  readonly reason: string;
  readonly cause?:
    | ToolResultIntegrityDeferral
    | DurableCheckpointPrefixDeferral
    | ToolPairOperationalDeferral;
}

export type DurableCheckpointUpgradeOutcome =
  | { readonly status: "planned"; readonly plan: DurableCheckpointUpgradePlan }
  | {
      readonly status: "invalid";
      readonly failure: DurableCheckpointUpgradeFailure;
    }
  | {
      readonly status: "deferred";
      readonly failure: DurableCheckpointUpgradeDeferral;
    };

/**
 * Build (but never apply) an atomic rollout transformation to the current
 * checkpoint schema. The caller owns publication. Running the planner over its own output
 * is deterministic and yields `changed: false`.
 */
export function planLegacyDurableCheckpointUpgrade(params: {
  readonly items: ReadonlyArray<RolloutItem>;
  readonly runId: string;
  readonly projection: ToolPairProjection;
  readonly projectionId: string;
  readonly sourceKey: string;
  readonly maxHistoryDerivationWork?: number;
}): DurableCheckpointUpgradeOutcome {
  const maxHistoryDerivationWork = positiveWorkLimit(
    params.maxHistoryDerivationWork ?? MAX_CHECKPOINT_UPGRADE_HISTORY_WORK,
  );
  const sourceSchemaInfo = findSourceSchemaVersion(params.items);
  if (sourceSchemaInfo.mixed) {
    return invalid(
      "rollout_schema_mixed",
      null,
      "rollout without session metadata mixes incompatible checkpoint versions",
    );
  }
  const sourceSchema = sourceSchemaInfo.version;
  if (sourceSchema > DURABLE_ROLLOUT_SCHEMA_VERSION || sourceSchema < 1) {
    return invalid(
      "rollout_schema_unsupported",
      null,
      `rollout schema ${sourceSchema} cannot be upgraded to ${DURABLE_ROLLOUT_SCHEMA_VERSION}`,
    );
  }

  const transformed: RolloutItem[] = [];
  let history: ToolResultIntegrityResponseItem[] = [];
  let historyDerivationWork = 0;
  let toolResultsSealed = 0;
  let checkpointsUpgraded = 0;
  let checkpointsValidated = 0;
  let changed = false;
  let sawSessionMeta = false;

  for (let itemIndex = 0; itemIndex < params.items.length; itemIndex += 1) {
    const sourceItem = params.items[itemIndex];
    if (sourceItem === undefined) continue;
    let item = sourceItem;

    if (item.type === "session_meta") {
      sawSessionMeta = true;
      const schema = item.payload.rolloutSchemaVersion;
      if (schema !== sourceSchema) {
        return invalid(
          "rollout_schema_mixed",
          itemIndex,
          `rollout metadata mixes schema ${sourceSchema} and ${schema}`,
        );
      }
      if (schema < DURABLE_ROLLOUT_SCHEMA_VERSION) {
        item = {
          ...item,
          payload: {
            ...item.payload,
            rolloutSchemaVersion: DURABLE_ROLLOUT_SCHEMA_VERSION,
          },
        };
        changed = true;
      }
    } else if (item.type === "response_item") {
      const sealed = sealResponseItem(item.payload, params.runId, sourceSchema);
      if (sealed.status !== "sealed") {
        return withItemIndex(sealed, itemIndex);
      }
      if (sealed.changed) {
        item = { ...item, payload: sealed.item };
        toolResultsSealed += 1;
        changed = true;
      }
    } else if (
      item.type === "compacted" &&
      item.payload.replacementHistory !== undefined
    ) {
      const replacementHistory: ToolResultIntegrityResponseItem[] = [];
      let replacementChanged = false;
      for (const response of item.payload.replacementHistory) {
        const sealed = sealResponseItem(response, params.runId, sourceSchema);
        if (sealed.status !== "sealed") {
          return withItemIndex(sealed, itemIndex);
        }
        replacementHistory.push(sealed.item);
        if (sealed.changed) {
          replacementChanged = true;
          toolResultsSealed += 1;
        }
      }
      if (replacementChanged) {
        item = {
          ...item,
          payload: { ...item.payload, replacementHistory },
        };
        changed = true;
      }
    }

    if (
      item.type === "event_msg" &&
      item.payload.msg.type === "turn_checkpoint"
    ) {
      let readable;
      try {
        readable = readTurnCheckpoint(item.payload.msg.payload);
      } catch (error) {
        return invalid(
          "checkpoint_invalid",
          itemIndex,
          error instanceof Error ? error.message : "checkpoint is malformed",
        );
      }
      if (
        !checkpointMatchesRolloutSchema(sourceSchema, readable.sourceVersion)
      ) {
        return invalid(
          "rollout_schema_mixed",
          itemIndex,
          `rollout schema ${sourceSchema} contains checkpoint version ${readable.sourceVersion}`,
        );
      }

      const persistedMessageCount = readable.checkpoint.persistedMessageCount;
      if (persistedMessageCount > history.length) {
        return invalid(
          "checkpoint_invalid",
          itemIndex,
          `checkpoint requires ${persistedMessageCount} messages but only ${history.length} precede it`,
        );
      }
      const prefixPasses =
        readable.version === 1
          ? LEGACY_CHECKPOINT_PREFIX_PASSES
          : readable.sourceVersion === DURABLE_CHECKPOINT_READ_VERSION
            ? CURRENT_CHECKPOINT_PREFIX_PASSES
            : INTEGRITY_CHECKPOINT_UPGRADE_PREFIX_PASSES;
      const reservedWork = reserveHistoryDerivationWork(
        historyDerivationWork,
        persistedMessageCount,
        prefixPasses,
        maxHistoryDerivationWork,
      );
      if (reservedWork === undefined) {
        return {
          status: "deferred",
          failure: {
            kind: "operational_deferral",
            code: "history_derivation_work_limit",
            itemIndex,
            reason: `checkpoint validation would exceed the aggregate history-derivation work limit of ${maxHistoryDerivationWork} message visits`,
          },
        };
      }
      historyDerivationWork = reservedWork;

      if (readable.version === 1) {
        const legacyPrefixHash = computePrefixHash(
          history,
          persistedMessageCount,
        );
        if (
          !constantTimeDigestEqual(
            legacyPrefixHash,
            readable.checkpoint.prefixHash,
          )
        ) {
          return invalid(
            "checkpoint_invalid",
            itemIndex,
            "legacy checkpoint prefix digest does not match its persisted history",
          );
        }
      } else {
        const sourceValidation = validateCheckpointPrefix({
          checkpoint: readable.checkpoint,
          expectedRunId: params.runId,
          messages: history,
          projection: params.projection,
          projectionId: checkpointProjectionId(params.projectionId),
          sourceKey: params.sourceKey,
        });
        const sourceFailure = checkpointValidationFailure(
          sourceValidation,
          itemIndex,
        );
        if (sourceFailure !== undefined) return sourceFailure;
      }

      let checkpoint: TurnCheckpointV4Event;
      if (readable.version === 1) {
        let prefixHash: string;
        try {
          prefixHash = computeCheckpointPrefixHashV3(
            history,
            persistedMessageCount,
          );
        } catch (error) {
          const mapped = canonicalizationOutcome(error, itemIndex);
          if (mapped !== undefined) return mapped;
          if (error instanceof DurableCheckpointReadError) {
            return invalid("checkpoint_invalid", itemIndex, error.message);
          }
          throw error;
        }
        checkpoint = {
          ...readable.checkpoint,
          checkpointVersion: DURABLE_CHECKPOINT_READ_VERSION,
          toolResultIntegrityVersion: 1,
          prefixHashVersion: 3,
          prefixHash,
        };
        item = {
          ...item,
          payload: {
            ...item.payload,
            msg: { type: "turn_checkpoint", payload: checkpoint },
          },
        };
        checkpointsUpgraded += 1;
        changed = true;
      } else if (readable.sourceVersion !== DURABLE_CHECKPOINT_READ_VERSION) {
        let prefixHash: string;
        try {
          prefixHash = computeCheckpointPrefixHashV3(
            history,
            persistedMessageCount,
          );
        } catch (error) {
          const mapped = canonicalizationOutcome(error, itemIndex);
          if (mapped !== undefined) return mapped;
          if (error instanceof DurableCheckpointReadError) {
            return invalid("checkpoint_invalid", itemIndex, error.message);
          }
          throw error;
        }
        checkpoint = {
          ...readable.checkpoint,
          checkpointVersion: DURABLE_CHECKPOINT_READ_VERSION,
          toolResultIntegrityVersion: 1,
          prefixHashVersion: 3,
          prefixHash,
        };
        item = {
          ...item,
          payload: {
            ...item.payload,
            msg: { type: "turn_checkpoint", payload: checkpoint },
          },
        };
        checkpointsUpgraded += 1;
        changed = true;
      } else {
        checkpoint = readable.checkpoint;
      }

      if (readable.sourceVersion !== DURABLE_CHECKPOINT_READ_VERSION) {
        const validation = validateCheckpointPrefixV3({
          checkpoint,
          expectedRunId: params.runId,
          messages: history,
          projection: params.projection,
          projectionId: checkpointProjectionId(params.projectionId),
          sourceKey: params.sourceKey,
        });
        const targetFailure = checkpointValidationFailure(
          validation,
          itemIndex,
        );
        if (targetFailure !== undefined) return targetFailure;
      }
      checkpointsValidated += 1;
    }

    transformed.push(item);
    const historyUpdate = updateUpgradeHistory({
      history,
      item,
      itemIndex,
      runId: params.runId,
      historyDerivationWork,
      maxHistoryDerivationWork,
    });
    if (historyUpdate.status !== "updated") return historyUpdate;
    history = historyUpdate.history;
    historyDerivationWork = historyUpdate.historyDerivationWork;
  }

  return {
    status: "planned",
    plan: {
      sourceSchemaVersion: sourceSchema,
      targetSchemaVersion: DURABLE_ROLLOUT_SCHEMA_VERSION,
      sessionMetaPromotionRequired: !sawSessionMeta,
      changed,
      toolResultsSealed,
      checkpointsUpgraded,
      checkpointsValidated,
      upgradedItems: transformed,
    },
  };
}

type UpgradeHistoryOutcome =
  | {
      readonly status: "updated";
      readonly history: ToolResultIntegrityResponseItem[];
      readonly historyDerivationWork: number;
    }
  | {
      readonly status: "invalid";
      readonly failure: DurableCheckpointUpgradeFailure;
    }
  | {
      readonly status: "deferred";
      readonly failure: DurableCheckpointUpgradeDeferral;
    };

function updateUpgradeHistory(params: {
  readonly history: ToolResultIntegrityResponseItem[];
  readonly item: RolloutItem;
  readonly itemIndex: number;
  readonly runId: string;
  readonly historyDerivationWork: number;
  readonly maxHistoryDerivationWork: number;
}): UpgradeHistoryOutcome {
  const { history, item } = params;
  if (item.type === "response_item") {
    history.push(item.payload);
    return updatedHistory(history, params.historyDerivationWork);
  }
  if (
    item.type === "compacted" &&
    item.payload.replacementHistory !== undefined
  ) {
    return updatedHistory(
      Array.from(withoutResponseIds(item.payload.replacementHistory)),
      params.historyDerivationWork,
    );
  }
  if (item.type === "compaction_committed") {
    // Checkpoints after a commit were hashed over the live projection, which
    // never carries a response id; a persisted id here made every one of them
    // fail ("checkpoint prefix digest does not match persisted history").
    return updatedHistory(
      withoutResponseIds(item.payload.replacement_history).map((message) => ({
        ...message,
      })),
      params.historyDerivationWork,
    );
  }
  if (
    item.type === "compaction_rollback_committed" &&
    Array.isArray(item.payload.source_history) &&
    item.payload.target_session_id === params.runId
  ) {
    return updatedHistory(
      item.payload.source_history.map((message) => ({ ...message })),
      params.historyDerivationWork,
    );
  }
  if (
    item.type === "event_msg" &&
    item.payload.msg.type === "thread_rolled_back"
  ) {
    const numTurns = validRollbackTurnCount(item.payload.msg.payload);
    if (numTurns === undefined) {
      return invalid(
        "rollback_invalid",
        params.itemIndex,
        "thread_rolled_back numTurns must be a non-negative safe integer",
      );
    }
    if (numTurns === 0 || history.length === 0) {
      return updatedHistory(history, params.historyDerivationWork);
    }
    const reservedWork = reserveHistoryDerivationWork(
      params.historyDerivationWork,
      history.length,
      ROLLBACK_HISTORY_PASSES,
      params.maxHistoryDerivationWork,
    );
    if (reservedWork === undefined) {
      return {
        status: "deferred",
        failure: {
          kind: "operational_deferral",
          code: "history_derivation_work_limit",
          itemIndex: params.itemIndex,
          reason: `rollback history derivation would exceed the aggregate history-derivation work limit of ${params.maxHistoryDerivationWork} message visits`,
        },
      };
    }
    // Rollback is the only event variant that mutates replay history. Keep its
    // canonical trimming semantics without running the immutable reducer for
    // every response item. The complete worst-case visit/copy cost was
    // reserved above before the reducer can allocate or traverse the history.
    const state = emptyReducedState();
    state.history = history;
    return updatedHistory(reduce(state, item).state.history, reservedWork);
  }
  return updatedHistory(history, params.historyDerivationWork);
}

function validRollbackTurnCount(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const numTurns = (payload as { readonly numTurns?: unknown }).numTurns;
  if (typeof numTurns !== "number") return undefined;
  return Number.isSafeInteger(numTurns) && numTurns >= 0 ? numTurns : undefined;
}

function updatedHistory(
  history: ToolResultIntegrityResponseItem[],
  historyDerivationWork: number,
): UpgradeHistoryOutcome {
  return { status: "updated", history, historyDerivationWork };
}

function positiveWorkLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CHECKPOINT_UPGRADE_HISTORY_WORK
  ) {
    throw new Error(
      `maxHistoryDerivationWork must be a positive safe integer no greater than ${MAX_CHECKPOINT_UPGRADE_HISTORY_WORK}`,
    );
  }
  return value;
}

function reserveHistoryDerivationWork(
  used: number,
  messageCount: number,
  passCount: number,
  limit: number,
): number | undefined {
  const remaining = limit - used;
  if (messageCount > Math.floor(remaining / passCount)) return undefined;
  return used + messageCount * passCount;
}

type SealResponseOutcome =
  | {
      readonly status: "sealed";
      readonly item: ToolResultIntegrityResponseItem;
      readonly changed: boolean;
    }
  | {
      readonly status: "invalid";
      readonly failure: Omit<DurableCheckpointUpgradeFailure, "itemIndex">;
    }
  | {
      readonly status: "deferred";
      readonly failure: Omit<DurableCheckpointUpgradeDeferral, "itemIndex">;
    };

function sealResponseItem(
  item: ToolResultIntegrityResponseItem,
  runId: string,
  sourceSchemaVersion: number,
): SealResponseOutcome {
  if (item.role !== "tool") {
    if (item.toolResultIntegrity !== undefined) {
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "tool_result_integrity_invalid",
          reason:
            "tool-result integrity metadata is attached to a non-tool message",
        },
      };
    }
    return { status: "sealed", item, changed: false };
  }
  if (
    typeof item.toolCallId !== "string" ||
    item.toolCallId.trim().length === 0
  ) {
    return {
      status: "invalid",
      failure: {
        kind: "integrity_failure",
        code: "tool_result_call_id_missing",
        reason: "tool result cannot be upgraded without a toolCallId",
      },
    };
  }
  if (item.toolResultIntegrity !== undefined) {
    const verified = verifyToolResultIntegrity({
      integrity: item.toolResultIntegrity,
      expectedRunId: runId,
      toolCallId: item.toolCallId,
      content: item.content,
    });
    if (verified.status === "invalid") {
      return {
        status: "invalid",
        failure: {
          kind: "integrity_failure",
          code: "tool_result_integrity_invalid",
          reason: verified.failure.reason,
          cause: verified.failure,
        },
      };
    }
    if (verified.status === "deferred") {
      return {
        status: "deferred",
        failure: {
          kind: "operational_deferral",
          code: "tool_result_integrity_deferred",
          reason: verified.failure.reason,
          cause: verified.failure,
        },
      };
    }
    return { status: "sealed", item, changed: false };
  }
  if (sourceSchemaVersion !== 1) {
    return {
      status: "invalid",
      failure: {
        kind: "integrity_failure",
        code: "tool_result_integrity_invalid",
        reason: "durable rollout tool result is missing integrity metadata",
      },
    };
  }
  try {
    return {
      status: "sealed",
      changed: true,
      item: {
        ...item,
        toolResultIntegrity: createToolResultIntegrity({
          runId,
          toolCallId: item.toolCallId,
          content: item.content,
        }),
      },
    };
  } catch (error) {
    if (error instanceof ToolResultCanonicalizationError) {
      if (error.kind === "operational_deferral") {
        return {
          status: "deferred",
          failure: {
            kind: "operational_deferral",
            code: "tool_result_integrity_deferred",
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
          code: "tool_result_integrity_invalid",
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
}

function findSourceSchemaVersion(items: ReadonlyArray<RolloutItem>): {
  readonly version: number;
  readonly mixed: boolean;
} {
  for (const item of items) {
    if (item.type === "session_meta") {
      return { version: item.payload.rolloutSchemaVersion, mixed: false };
    }
  }
  const checkpointVersions = new Set<number>();
  for (const item of items) {
    if (
      item.type !== "event_msg" ||
      item.payload.msg.type !== "turn_checkpoint"
    ) {
      continue;
    }
    const payload = item.payload.msg.payload as { checkpointVersion?: unknown };
    if (payload.checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION) {
      checkpointVersions.add(DURABLE_CHECKPOINT_READ_VERSION);
    } else if (payload.checkpointVersion === DURABLE_CHECKPOINT_V3) {
      checkpointVersions.add(DURABLE_CHECKPOINT_V3);
    } else if (payload.checkpointVersion === DURABLE_CHECKPOINT_V2) {
      checkpointVersions.add(DURABLE_CHECKPOINT_V2);
    } else {
      checkpointVersions.add(LEGACY_DURABLE_CHECKPOINT_VERSION);
    }
  }
  if (checkpointVersions.size > 1) {
    return { version: 1, mixed: true };
  }
  const [checkpointVersion = LEGACY_DURABLE_CHECKPOINT_VERSION] =
    checkpointVersions;
  if (checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION) {
    return { version: DURABLE_ROLLOUT_SCHEMA_VERSION, mixed: false };
  }
  if (checkpointVersion === DURABLE_CHECKPOINT_V3) {
    return { version: DURABLE_ROLLOUT_SCHEMA_V4, mixed: false };
  }
  if (checkpointVersion === DURABLE_CHECKPOINT_V2) {
    return { version: DURABLE_ROLLOUT_SCHEMA_V2, mixed: false };
  }
  return { version: 1, mixed: false };
}

function checkpointMatchesRolloutSchema(
  rolloutSchemaVersion: number,
  checkpointVersion: number,
): boolean {
  if (rolloutSchemaVersion === 1) {
    return checkpointVersion === LEGACY_DURABLE_CHECKPOINT_VERSION;
  }
  if (rolloutSchemaVersion === DURABLE_ROLLOUT_SCHEMA_V2) {
    return checkpointVersion === DURABLE_CHECKPOINT_V2;
  }
  if (rolloutSchemaVersion === DURABLE_ROLLOUT_SCHEMA_V3) {
    return checkpointVersion === DURABLE_CHECKPOINT_V2;
  }
  if (rolloutSchemaVersion === DURABLE_ROLLOUT_SCHEMA_V4) {
    return checkpointVersion === DURABLE_CHECKPOINT_V3;
  }
  return (
    rolloutSchemaVersion === DURABLE_ROLLOUT_SCHEMA_VERSION &&
    checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION
  );
}

function checkpointProjectionId(base: string): string {
  const hash = createHash("sha256");
  hash.update(UPGRADE_PROJECTION_ID_DOMAIN);
  hash.update("\0");
  hash.update(base);
  return `checkpoint-upgrade:${hash.digest("hex")}`;
}

function checkpointValidationFailure(
  validation: ReturnType<typeof validateCheckpointPrefix>,
  itemIndex: number,
): DurableCheckpointUpgradeOutcome | undefined {
  if (validation.status === "invalid") {
    return invalid(
      "checkpoint_invalid",
      itemIndex,
      validation.failure.reason,
      validation.failure,
    );
  }
  if (validation.status === "deferred") {
    return {
      status: "deferred",
      failure: {
        kind: "operational_deferral",
        code: "checkpoint_validation_deferred",
        itemIndex,
        reason: validation.failure.reason,
        cause: validation.failure,
      },
    };
  }
  return undefined;
}

function canonicalizationOutcome(
  error: unknown,
  itemIndex: number,
): DurableCheckpointUpgradeOutcome | undefined {
  if (!(error instanceof ToolResultCanonicalizationError)) return undefined;
  if (error.kind === "operational_deferral") {
    return {
      status: "deferred",
      failure: {
        kind: "operational_deferral",
        code: "tool_result_integrity_deferred",
        itemIndex,
        reason: error.message,
        cause: {
          kind: "operational_deferral",
          code: error.code as ToolResultIntegrityDeferral["code"],
          reason: error.message,
        },
      },
    };
  }
  return invalid("tool_result_integrity_invalid", itemIndex, error.message, {
    kind: "integrity_failure",
    code: error.code as ToolResultIntegrityFailure["code"],
    reason: error.message,
  });
}

function withItemIndex(
  outcome: Exclude<SealResponseOutcome, { readonly status: "sealed" }>,
  itemIndex: number,
): DurableCheckpointUpgradeOutcome {
  if (outcome.status === "invalid") {
    return {
      status: "invalid",
      failure: { ...outcome.failure, itemIndex },
    };
  }
  return {
    status: "deferred",
    failure: { ...outcome.failure, itemIndex },
  };
}

function invalid(
  code: DurableCheckpointUpgradeFailure["code"],
  itemIndex: number | null,
  reason: string,
  cause?: DurableCheckpointUpgradeFailure["cause"],
): {
  readonly status: "invalid";
  readonly failure: DurableCheckpointUpgradeFailure;
} {
  return {
    status: "invalid",
    failure: {
      kind: "integrity_failure",
      code,
      itemIndex,
      reason,
      ...(cause === undefined ? {} : { cause }),
    },
  };
}
