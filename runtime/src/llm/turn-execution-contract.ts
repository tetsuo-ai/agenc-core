/**
 * Turn execution contract — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 801-LOC turn-classification + delegation
 * inference + workflow contract synthesis machinery. The planner
 * subsystem that consumed this output has been deleted, so the runtime
 * now produces a default `dialogue` contract for every turn. The
 * exported function shapes are preserved so chat-executor and the
 * gateway initialization paths still link.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type {
  ActiveTaskContext,
  TurnExecutionContract,
} from "./turn-execution-contract-types.js";

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function buildDefaultContract(): TurnExecutionContract {
  const fingerprint = stableHash({ shape: "default", t: 0 });
  return {
    version: 1,
    turnClass: "dialogue",
    ownerMode: "none",
    sourceArtifacts: [],
    targetArtifacts: [],
    delegationPolicy: "planner_allowed",
    contractFingerprint: fingerprint,
    taskLineageId: fingerprint,
  };
}

export function resolveTurnExecutionContract(_params: {
  readonly message: ChatExecuteParams["message"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
}): TurnExecutionContract {
  return buildDefaultContract();
}

export function mergeTurnExecutionRequiredToolEvidence(params: {
  readonly base?: ChatExecuteParams["requiredToolEvidence"];
  readonly turnExecutionContract: TurnExecutionContract;
}): ChatExecuteParams["requiredToolEvidence"] {
  return params.base;
}

export function deriveActiveTaskContext(
  contract: TurnExecutionContract,
): ActiveTaskContext {
  return {
    version: 1,
    taskLineageId: contract.taskLineageId,
    contractFingerprint: contract.contractFingerprint,
    turnClass: contract.turnClass,
    ownerMode: contract.ownerMode,
    workspaceRoot: contract.workspaceRoot,
    sourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
  };
}
