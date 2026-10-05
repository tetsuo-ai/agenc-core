/** Workflow controls preserve the run identity, evidence, and budget authority. */

import type {
  RunPauseParams,
  RunPauseResult,
  RunResumeParams,
  RunResumeResult,
} from "../protocol/index.js";
import { runWithBootstrapSessionScope } from "../../session/current-session.js";

/** Structural seam: the controller owns persistence and every lifecycle decision. */
export interface WorkflowControlController {
  requestPause(params: RunPauseParams): Promise<RunPauseResult>;
  resumePaused(params: RunResumeParams): Promise<RunResumeResult>;
}

export type WorkflowControlErrorCode =
  | "INVALID_ARGUMENT"
  | "RUN_NOT_FOUND"
  | "WORKFLOW_NOT_PAUSED"
  | "WORKFLOW_CONTROL_CONFLICT"
  | "WORKFLOW_CONTROL_FAILED";

export class AgenCDaemonWorkflowControlError extends Error {
  constructor(readonly code: WorkflowControlErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonWorkflowControlError";
  }
}

export class DaemonWorkflowControlService {
  constructor(private readonly controller: WorkflowControlController) {}

  pauseRun(params: RunPauseParams): Promise<RunPauseResult> {
    return runWithBootstrapSessionScope(() => this.controller.requestPause(params));
  }

  resumeRun(params: RunResumeParams): Promise<RunResumeResult> {
    // Resume may bootstrap a daemon-owned Session. It is not a turn of an
    // arbitrary foreground chat, and must not inherit that chat's authority.
    return runWithBootstrapSessionScope(() => this.controller.resumePaused(params));
  }
}
