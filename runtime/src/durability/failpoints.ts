/**
 * Process-level crash injection for the M4 durability acceptance matrix.
 *
 * These hooks are deliberately inert unless all three test-only environment
 * controls are present. Production configuration cannot accidentally turn a
 * boundary probe into a daemon kill. The child-process acceptance harness sets
 * the controls, waits for the fsynced marker, and then inspects recovery state
 * after the process exits.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";

export const M4_DURABILITY_FAILPOINTS = [
  "after_admission_sqlite_commit_before_canonical_append",
  "before_reservation_commit",
  "after_reservation_commit",
  "before_model_response_commit",
  "after_model_response_commit",
  "before_tool_spawn",
  "after_tool_spawn",
  "before_tool_ack_commit",
  "after_tool_ack_commit",
  "before_artifact_commit",
  "after_artifact_commit",
  "before_event_publish",
  "after_event_publish",
  "before_terminal_commit",
  "after_terminal_commit",
] as const;

export type M4DurabilityFailpoint =
  (typeof M4_DURABILITY_FAILPOINTS)[number];

const FAILPOINT_ENV = "AGENC_TEST_DURABILITY_FAILPOINT";
const FAILPOINT_TOKEN_ENV = "AGENC_TEST_DURABILITY_FAILPOINT_TOKEN";
const FAILPOINT_ACTION_ENV = "AGENC_TEST_DURABILITY_FAILPOINT_ACTION";
const FAILPOINT_MARKER_ENV = "AGENC_TEST_DURABILITY_FAILPOINT_MARKER";
const FAILPOINT_TOKEN = "m4-durability-child";

export class M4DurabilityFailpointError extends Error {
  readonly failpoint: M4DurabilityFailpoint;

  constructor(failpoint: M4DurabilityFailpoint) {
    super(`M4 durability failpoint reached: ${failpoint}`);
    this.name = "M4DurabilityFailpointError";
    this.failpoint = failpoint;
  }
}

/**
 * Crash (the default) or throw at one named durability boundary.
 *
 * `throw` exists for focused unit tests. Acceptance tests use the default
 * SIGKILL action so no finally block, shutdown hook, or buffered write can
 * make the simulated crash safer than a real daemon loss.
 */
export function hitM4DurabilityFailpoint(
  failpoint: M4DurabilityFailpoint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[FAILPOINT_ENV] !== failpoint) return;
  if (env[FAILPOINT_TOKEN_ENV] !== FAILPOINT_TOKEN) return;

  const markerPath = env[FAILPOINT_MARKER_ENV];
  if (markerPath !== undefined && markerPath.length > 0) {
    writeMarkerDurably(markerPath, failpoint);
  }

  if (env[FAILPOINT_ACTION_ENV] === "throw") {
    throw new M4DurabilityFailpointError(failpoint);
  }

  process.kill(process.pid, "SIGKILL");
}

/**
 * M5 verified-change workflow failpoints — one per durable pipeline
 * boundary. Same inert-unless-armed mechanism as M4, with a distinct token
 * so an M4 harness can never trip an M5 boundary by accident.
 */
export const M5_WORKFLOW_FAILPOINTS = [
  "before_intake_commit",
  "after_intake_commit",
  "before_worktree_provision",
  "after_worktree_provision",
  "after_spawn_before_effect_result",
  "before_verify_commit",
  "after_verify_commit",
  "before_review_commit",
  "after_review_commit",
  "before_patch_export",
  "after_patch_export_before_seal",
  "after_seal_before_terminal",
  "after_terminal_before_cleanup",
] as const;

export type M5WorkflowFailpoint = (typeof M5_WORKFLOW_FAILPOINTS)[number];

const M5_FAILPOINT_TOKEN = "m5-workflow-child";

export class M5WorkflowFailpointError extends Error {
  readonly failpoint: M5WorkflowFailpoint;

  constructor(failpoint: M5WorkflowFailpoint) {
    super(`M5 workflow failpoint reached: ${failpoint}`);
    this.name = "M5WorkflowFailpointError";
    this.failpoint = failpoint;
  }
}

/** Crash (default) or throw at one named M5 workflow boundary. */
export function hitM5WorkflowFailpoint(
  failpoint: M5WorkflowFailpoint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[FAILPOINT_ENV] !== failpoint) return;
  if (env[FAILPOINT_TOKEN_ENV] !== M5_FAILPOINT_TOKEN) return;

  const markerPath = env[FAILPOINT_MARKER_ENV];
  if (markerPath !== undefined && markerPath.length > 0) {
    writeMarkerDurably(markerPath, failpoint);
  }

  if (env[FAILPOINT_ACTION_ENV] === "throw") {
    throw new M5WorkflowFailpointError(failpoint);
  }

  process.kill(process.pid, "SIGKILL");
}

function writeMarkerDurably(
  markerPath: string,
  failpoint: M4DurabilityFailpoint | M5WorkflowFailpoint,
): void {
  const fd = openSync(markerPath, "w", 0o600);
  try {
    writeSync(
      fd,
      `${JSON.stringify({ failpoint, pid: process.pid })}\n`,
      undefined,
      "utf8",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
