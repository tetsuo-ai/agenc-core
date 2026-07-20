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
} from "../../contracts/run-contracts.js";
import type {
  DurableRunEffect,
  DurableRunTerminalRecord,
} from "../../state/run-durability.js";
import { deriveAllStageProjections } from "./steps.js";

export interface WorkflowStatusStep {
  readonly stepId: string;
  readonly stage: WorkflowStepId;
  readonly status: WorkflowStepStatus;
  readonly attempts: number;
  readonly verdict?: string;
  readonly artifacts?: readonly RunArtifactPointer[];
}

export interface WorkflowRunStatus {
  readonly runId: string;
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
  return {
    runId: input.runId,
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
