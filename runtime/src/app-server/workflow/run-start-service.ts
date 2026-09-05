/**
 * M5 Phase 5 — the daemon `run.start` service.
 *
 * Thin adapter between the JSON-RPC dispatcher and the verified-change
 * workflow controller: resolve the target git root, translate wire params
 * into the controller's `WorkflowStartParams`, surface intake failures as
 * typed protocol errors, and register the started run on the daemon agents
 * rail through the existing `recordAgentRun` path.
 */

import { findGitRoot } from "../../agents/worktree.js";
import type {
  RunStartParams,
  RunStartResult,
} from "../protocol/index.js";
import type { AgenCStateAgentRunRecord } from "../../state/agent-runs.js";
import {
  type WorkflowDetachedCancelOutcome,
  VerifiedChangeWorkflowController,
  WorkflowIntakeError,
  type WorkflowStartParams,
} from "./verified-change-controller.js";
import { runWithBootstrapSessionScope } from "../../session/current-session.js";

export type AgenCDaemonWorkflowStartErrorCode =
  | "INVALID_ARGUMENT"
  | "WORKFLOW_START_FAILED";

/** Typed `run.start` failure the dispatcher maps to a JSON-RPC error. */
export class AgenCDaemonWorkflowStartError extends Error {
  readonly code: AgenCDaemonWorkflowStartErrorCode;

  constructor(code: AgenCDaemonWorkflowStartErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonWorkflowStartError";
    this.code = code;
  }
}

/** Agents-rail registration payload for a started workflow run. */
export interface WorkflowStartedRunRecord extends AgenCStateAgentRunRecord {
  /** Snapshot route: the run's repository root (its project state database). */
  readonly cwd: string;
}

const OBJECTIVE_GOAL_PREFIX_LIMIT = 80;

export function workflowRunObjective(goal: string): string {
  const flattened = goal.replace(/\s+/g, " ").trim();
  const prefix =
    flattened.length > OBJECTIVE_GOAL_PREFIX_LIMIT
      ? `${flattened.slice(0, OBJECTIVE_GOAL_PREFIX_LIMIT)}…`
      : flattened;
  return `verified-change: ${prefix}`;
}

export interface DaemonWorkflowStartServiceOptions {
  readonly controller: VerifiedChangeWorkflowController;
  /** Default repository directory when `run.start` omits `cwd`. */
  readonly primaryCwd: string;
  /**
   * Existing daemon agents-rail registration (agent_runs upsert + initial
   * lifecycle epoch + session tracking). Failures are surfaced through
   * `warn` — a missing rail row never fails a durably started run.
   */
  readonly recordAgentRun?: (
    run: WorkflowStartedRunRecord,
  ) => void | Promise<void>;
  readonly warn: (message: string) => void;
  readonly now?: () => Date;
}

export class DaemonWorkflowStartService {
  readonly #options: DaemonWorkflowStartServiceOptions;
  readonly #now: () => Date;

  constructor(options: DaemonWorkflowStartServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** See VerifiedChangeWorkflowController.cancelDetached. */
  cancelDetachedRun(params: {
    readonly runId: string;
    readonly reason: string;
  }): WorkflowDetachedCancelOutcome {
    return this.#options.controller.cancelDetached(params.runId, params.reason);
  }

  async startRun(params: RunStartParams): Promise<RunStartResult> {
    const cwd = params.cwd ?? this.#options.primaryCwd;
    const repoPath = findGitRoot(cwd);
    if (repoPath === null) {
      throw new AgenCDaemonWorkflowStartError(
        "INVALID_ARGUMENT",
        `run.start cwd is not inside a git repository: ${cwd}`,
      );
    }
    const budget = {
      ...(params.maxCostUsd !== undefined
        ? { maxCostUsd: params.maxCostUsd }
        : {}),
      ...(params.maxTokens !== undefined
        ? { maxTokens: params.maxTokens }
        : {}),
      ...(params.deadlineAt !== undefined
        ? { deadlineAt: params.deadlineAt }
        : {}),
    };
    const startParams: WorkflowStartParams = {
      goal: params.goal,
      repoPath,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined
        ? { provider: params.provider }
        : {}),
      ...(params.reviewerModel !== undefined
        ? { reviewerModel: params.reviewerModel }
        : {}),
      ...(params.permissionMode !== undefined
        ? { permissionMode: params.permissionMode }
        : {}),
      ...(params.unattendedAllow !== undefined
        ? { unattendedAllow: params.unattendedAllow }
        : {}),
      ...(params.unattendedDeny !== undefined
        ? { unattendedDeny: params.unattendedDeny }
        : {}),
      ...(Object.keys(budget).length > 0 ? { budget } : {}),
      // Pass through exactly what the caller gave; the controller owns the
      // "at least one verification command" policy and its error text.
      requiredVerification: params.requiredVerification ?? [],
      ...(params.maxImplementAttempts !== undefined
        ? { maxImplementAttempts: params.maxImplementAttempts }
        : {}),
    };
    let started;
    try {
      // A goal run is daemon work, not a turn of any session. Utilities on its
      // path fall back to the ambient "current session", which refuses when
      // the daemon tracks more than one session, as a desktop daemon always
      // does: every run.start then failed with "Ambiguous runtime session".
      // Inside this scope the fallback yields no session and the utilities
      // use their environment defaults; the run's own sessions bind their
      // scopes as they start.
      started = await runWithBootstrapSessionScope(() =>
        this.#options.controller.start(startParams),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        // Pre-intake parameter refusal (e.g. no verification commands):
        // nothing durable happened yet — a clean invalid-argument error.
        throw new AgenCDaemonWorkflowStartError(
          "INVALID_ARGUMENT",
          error.message,
        );
      }
      if (error instanceof WorkflowIntakeError) {
        // The intake failure is durably terminalized under the run id; the
        // wire error carries the same diagnostic.
        throw new AgenCDaemonWorkflowStartError(
          "WORKFLOW_START_FAILED",
          error.message,
        );
      }
      throw error;
    }
    if (this.#options.recordAgentRun !== undefined) {
      const at = this.#now().toISOString();
      try {
        await this.#options.recordAgentRun({
          id: started.runId,
          objective: workflowRunObjective(params.goal),
          status: "running",
          startedAt: at,
          lastActiveAt: at,
          currentSessionId: started.runId,
          metadata: { kind: "verified-change-workflow" },
          cwd: repoPath,
        });
      } catch (error) {
        this.#options.warn(
          `workflow run ${started.runId} agents-rail registration failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      runId: started.runId,
      specDigest: started.specDigest,
      baseCommit: started.baseCommit,
      baseDirty: {
        dirty: started.baseDirty.dirty,
        fileCount: started.baseDirty.fileCount,
      },
    };
  }
}
