import { createHash } from "node:crypto";
import { computePrefixHash } from "./durable-turns.js";
import { emptyReducedState, reduce } from "./event-log-reducer.js";
import type { TurnCheckpointV2Event } from "./event-log.js";
import type {
  RolloutItem,
  ToolResultIntegrityResponseItem,
} from "./rollout-item.js";
import {
  DURABLE_CHECKPOINT_READ_VERSION,
  DURABLE_ROLLOUT_SCHEMA_V2,
  DurableCheckpointReadError,
  computeCheckpointPrefixHashV2,
  readTurnCheckpoint,
  validateCheckpointPrefixV2,
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

export interface DurableCheckpointUpgradePlan {
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: typeof DURABLE_ROLLOUT_SCHEMA_V2;
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
    "tool_result_integrity_deferred" | "checkpoint_validation_deferred";
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
 * Build (but never apply) an atomic legacy-to-v2 rollout transformation.
 * The caller owns publication in A3b. Running the planner over its own output
 * is deterministic and yields `changed: false`.
 */
export function planLegacyDurableCheckpointUpgrade(params: {
  readonly items: ReadonlyArray<RolloutItem>;
  readonly runId: string;
  readonly projection: ToolPairProjection;
  readonly projectionId: string;
  readonly sourceKey: string;
}): DurableCheckpointUpgradeOutcome {
  const sourceSchemaInfo = findSourceSchemaVersion(params.items);
  if (sourceSchemaInfo.mixed) {
    return invalid(
      "rollout_schema_mixed",
      null,
      "rollout without session metadata mixes legacy and v2 checkpoints",
    );
  }
  const sourceSchema = sourceSchemaInfo.version;
  if (sourceSchema > DURABLE_ROLLOUT_SCHEMA_V2 || sourceSchema < 1) {
    return invalid(
      "rollout_schema_unsupported",
      null,
      `rollout schema ${sourceSchema} cannot be upgraded to ${DURABLE_ROLLOUT_SCHEMA_V2}`,
    );
  }

  const transformed: RolloutItem[] = [];
  let state = emptyReducedState();
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
      if (schema === 1) {
        item = {
          ...item,
          payload: {
            ...item.payload,
            rolloutSchemaVersion: DURABLE_ROLLOUT_SCHEMA_V2,
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
        (sourceSchema === 1 && readable.version !== 1) ||
        (sourceSchema === DURABLE_ROLLOUT_SCHEMA_V2 &&
          readable.version !== DURABLE_CHECKPOINT_READ_VERSION)
      ) {
        return invalid(
          "rollout_schema_mixed",
          itemIndex,
          `rollout schema ${sourceSchema} contains checkpoint version ${readable.version}`,
        );
      }

      let checkpoint: TurnCheckpointV2Event;
      if (readable.version === 1) {
        if (readable.checkpoint.persistedMessageCount > state.history.length) {
          return invalid(
            "checkpoint_invalid",
            itemIndex,
            `checkpoint requires ${readable.checkpoint.persistedMessageCount} messages but only ${state.history.length} precede it`,
          );
        }
        let prefixHash: string;
        try {
          prefixHash = computeCheckpointPrefixHashV2(
            state.history,
            readable.checkpoint.persistedMessageCount,
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

      const validation = validateCheckpointPrefixV2({
        checkpoint,
        messages: state.history,
        projection: params.projection,
        projectionId: checkpointProjectionId(params.projectionId),
        sourceKey: params.sourceKey,
      });
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
      if (readable.version === 1) {
        const legacyPrefixHash = computePrefixHash(
          state.history,
          readable.checkpoint.persistedMessageCount,
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
      }
      checkpointsValidated += 1;
    }

    transformed.push(item);
    state = reduce(state, item).state;
  }

  return {
    status: "planned",
    plan: {
      sourceSchemaVersion: sourceSchema,
      targetSchemaVersion: DURABLE_ROLLOUT_SCHEMA_V2,
      sessionMetaPromotionRequired: !sawSessionMeta,
      changed,
      toolResultsSealed,
      checkpointsUpgraded,
      checkpointsValidated,
      upgradedItems: transformed,
    },
  };
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
        reason: "schema-v2 tool result is missing integrity metadata",
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
  let sawLegacy = false;
  let sawV2 = false;
  for (const item of items) {
    if (
      item.type !== "event_msg" ||
      item.payload.msg.type !== "turn_checkpoint"
    ) {
      continue;
    }
    const payload = item.payload.msg.payload as { checkpointVersion?: unknown };
    if (payload.checkpointVersion === DURABLE_CHECKPOINT_READ_VERSION) {
      sawV2 = true;
    } else {
      sawLegacy = true;
    }
  }
  return {
    version: sawV2 && !sawLegacy ? DURABLE_ROLLOUT_SCHEMA_V2 : 1,
    mixed: sawV2 && sawLegacy,
  };
}

function checkpointProjectionId(base: string): string {
  const hash = createHash("sha256");
  hash.update(UPGRADE_PROJECTION_ID_DOMAIN);
  hash.update("\0");
  hash.update(base);
  return `checkpoint-upgrade:${hash.digest("hex")}`;
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
