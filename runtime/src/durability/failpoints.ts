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

function writeMarkerDurably(
  markerPath: string,
  failpoint: M4DurabilityFailpoint,
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
