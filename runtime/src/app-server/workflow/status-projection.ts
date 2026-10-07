/**
 * M5 Phase 4 — pure workflow status projection.
 *
 * `run_effects` rows plus the durable terminal record ARE the workflow's
 * step state (D2: no parallel state store). This module folds them into the
 * `RunStatusResult.workflow` shape the daemon's `run.status` method serves:
 * one entry per fixed pipeline stage with attempt counts, machine verdicts,
 * and content-addressed artifact pointers.
 */

import {
  WORKFLOW_STEP_IDS,
  WORKFLOW_STEP_PREREQUISITES,
  WORKFLOW_STOP_REASONS,
  type RunArtifactPointer,
  type RunTerminalStatus,
  type WorkflowStepId,
  type WorkflowStepStatus,
  type WorkflowStopReason,
  type WorkflowSpec,
} from "../../contracts/run-contracts.js";
import type {
  DurableRunEffect,
  DurableRunTerminalRecord,
  DurableRunSuspension,
} from "../../state/run-durability.js";
import { deriveAllStageProjections, readWorkflowStepEvidence } from "./steps.js";
import type { ProviderWait } from "../../recovery/provider-wait.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { RunWorkflowCompletedResult, RunWorkflowControlState, RunWorkflowRuntimeFailure } from "../protocol/index.js";
import { workflowControlState } from "./control-state.js";

export interface WorkflowStatusStep {
  readonly stepId: string;
  readonly stage: WorkflowStepId;
  readonly status: WorkflowStepStatus;
  readonly attempts: number;
  readonly providerWait?: ProviderWait;
  readonly verdict?: string;
  readonly artifacts?: readonly RunArtifactPointer[];
}

export interface WorkflowRunStatus {
  readonly runId: string;
  readonly lightMode?: boolean;
  readonly control: RunWorkflowControlState;
  /** Volatile execution health; never substitutes for the durable terminal. */
  readonly runtimeFailure?: RunWorkflowRuntimeFailure;
  readonly continuationOf?: WorkflowSpec["continuationOf"];
  readonly completedResult?: RunWorkflowCompletedResult;
  readonly requestedPermissionMode?: WorkflowSpec["permissionMode"];
  /** Only a live, owned Session can supply this field; durable projection cannot. */
  readonly effectivePermissionMode?: PermissionMode;
  readonly steps: readonly WorkflowStatusStep[];
  readonly terminal?: {
    readonly status: RunTerminalStatus;
    readonly stopReason: string | null;
    readonly finalMessage: string | null;
    readonly finishedAt: string;
  };
  /** Present when the run terminated with a frozen workflow stop reason. */
  readonly stopReason?: WorkflowStopReason;
}

const BAD_STAGE_STATUSES: readonly WorkflowStepStatus[] = [
  "failed",
  "cancelled",
  "unknown_outcome",
  "blocked",
];

/**
 * Fold durable rows + terminal record into the workflow status shape.
 *
 * `blocked` derivation: a stage that never began is `blocked` (never
 * `pending`) once the run is terminal, or once a prerequisite stage is in a
 * terminally-bad state while the run is terminal. While the run is still
 * live, a not-yet-started stage stays `pending` — a failed prerequisite may
 * still be retried under a new attempt id.
 */
export function projectWorkflowStatus(input: {
  readonly runId: string;
  readonly effects: readonly DurableRunEffect[];
  readonly terminal?: DurableRunTerminalRecord;
  readonly suspensions?: readonly DurableRunSuspension[];
}): WorkflowRunStatus {
  const projections = deriveAllStageProjections(input.effects);
  const steps: WorkflowStatusStep[] = [];
  for (const stage of WORKFLOW_STEP_IDS) {
    const projection = projections.get(stage)!;
    let status = projection.status;
    if (status === "pending" && input.terminal !== undefined) {
      const prerequisitesBad = WORKFLOW_STEP_PREREQUISITES[stage].some(
        (prerequisite) => {
          const parent = projections.get(prerequisite)!;
          return (
            BAD_STAGE_STATUSES.includes(parent.status) ||
            parent.status === "pending" ||
            (parent.status === "committed" && parent.verdictPassed === false)
          );
        },
      );
      status =
        input.terminal.status === "completed" && !prerequisitesBad
          ? "pending"
          : "blocked";
    }
    steps.push({
      stepId: projection.latestStepId,
      stage,
      status,
      attempts: projection.attempts,
      ...(projection.verdict !== undefined
        ? { verdict: projection.verdict }
        : {}),
      ...(projection.artifacts.length > 0
        ? { artifacts: projection.artifacts }
        : {}),
    });
  }
  const stopReason =
    input.terminal?.stopReason !== undefined &&
    input.terminal?.stopReason !== null &&
    (WORKFLOW_STOP_REASONS as readonly string[]).includes(
      input.terminal.stopReason,
    )
      ? (input.terminal.stopReason as WorkflowStopReason)
      : undefined;
  const intake = input.effects.find((effect) => effect.stepId === "workflow.intake");
  const spec = intake === undefined ? undefined : readWorkflowStepEvidence(intake).spec;
  const permissionMode = spec !== null && typeof spec === "object"
    ? (spec as Record<string, unknown>).permissionMode
    : undefined;
  const finalized = input.effects.find(effect => effect.stepId === "workflow.finalize" && effect.outcome === "committed");
  const delivered = finalized === undefined ? undefined : readWorkflowStepEvidence(finalized).finalize;
  const sourceSpec = spec !== null && typeof spec === "object" ? spec as WorkflowSpec : undefined;
  const sourceDigest = intake === undefined ? undefined : readWorkflowStepEvidence(intake).specDigest;
  const previousCost = sourceSpec?.continuationOf === undefined ? 0 : sourceSpec.continuationOf.previousCostUsd;
  const usage = input.terminal?.usage;
  const totalCost = usage != null && usage.costKnown !== false && previousCost !== null
    && Number.isFinite(previousCost) && previousCost >= 0 && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
    ? previousCost + usage.costUsd : null;
  const completedResult = input.terminal?.status === "completed" && sourceSpec !== undefined
    && sourceDigest !== undefined && delivered?.headCommit !== undefined
    ? { headCommit: delivered.headCommit, specDigest: sourceDigest, baseCommit: sourceSpec.baseCommit,
        cumulativeCostUsd: totalCost !== null && Number.isFinite(totalCost) ? totalCost : null,
        ...(usage?.costEstimated === true || sourceSpec.continuationOf?.previousCostEstimated === true
          ? { cumulativeCostEstimated: true } : {}) } : undefined;
  return {
    runId: input.runId,
    ...(sourceSpec !== undefined ? { lightMode: sourceSpec.lightMode === true } : {}),
    ...(completedResult !== undefined ? { completedResult } : {}),
    ...((spec as WorkflowSpec | undefined)?.continuationOf !== undefined
      ? { continuationOf: (spec as WorkflowSpec).continuationOf } : {}),
    control: workflowControlState({ ...input, suspensions: input.suspensions ?? [], terminal: input.terminal !== undefined }),
    ...(permissionMode === "default" || permissionMode === "plan" || permissionMode === "acceptEdits" || permissionMode === "bypassPermissions"
      ? { requestedPermissionMode: permissionMode }
      : {}),
    steps,
    ...(input.terminal !== undefined
      ? {
          terminal: {
            status: input.terminal.status,
            stopReason: input.terminal.stopReason,
            finalMessage: input.terminal.finalMessage,
            finishedAt: input.terminal.finishedAt,
          },
        }
      : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
