import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgenCDaemonRestartFollowDeadlineMs } from "../../app-server/daemon-restart-handoff.js";
import {
  AGENC_DAEMON_RESTART_RESULT_FILENAME,
  parseAgenCDaemonRestartResult,
  type AgenCDaemonRestartOutcome,
  type AgenCDaemonRestartResult,
} from "../../app-server/daemon-restart-outcome.js";
import { order } from "../../utils/semver.js";
import {
  getAgenCTuiAttachmentIds,
  getPendingUpdateFollow,
  setPendingUpdateFollow,
  type UpdateFollow,
  type UpdateNotice,
  type UpdateRelaunchRequest,
} from "../update-relaunch-state.js";

const FOLLOW_POLL_MS = 2_000;

/**
 * The daemon's runtime version from its sidecar: null when no daemon has
 * published one, undefined when the file cannot be read.
 */
export function readDaemonRuntimeVersion(agencHome: string): string | null | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(agencHome, "daemon-runtime.json"), "utf8")) as { runtimeVersion?: unknown };
    return typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

/** How the last restart step ended, from its result file; null when none can be read. */
export function readDaemonRestartResult(agencHome: string): AgenCDaemonRestartResult | null {
  try {
    return parseAgenCDaemonRestartResult(readFileSync(join(agencHome, AGENC_DAEMON_RESTART_RESULT_FILENAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a pending follow may relaunch now: after this turn, at once; after a
 * busy daemon, once it runs the new version, or once no daemon runs and no
 * restart is pending (a daemon between stop and start has no sidecar).
 */
export function updateFollowReady(
  follow: UpdateFollow,
  daemonVersion: string | null | undefined,
  restartPending: boolean,
): boolean {
  if (follow.when === "idle") return true;
  if (daemonVersion === follow.request.targetVersion) return true;
  return daemonVersion === null && !restartPending;
}

/** What one check of a follow saw. */
export interface UpdateFollowObservation {
  /** The daemon's version: null when none runs, undefined when unknown. */
  readonly daemonVersion: string | null | undefined;
  readonly restartPending: boolean;
  /** How the last restart step ended, when one recorded it. */
  readonly result: AgenCDaemonRestartResult | null;
  /** Milliseconds since the epoch. */
  readonly now: number;
}

export type UpdateFollowStep =
  | { readonly kind: "wait" }
  | { readonly kind: "relaunch" }
  /** The switch is not going to happen: stop following and say why. */
  | { readonly kind: "stop"; readonly notice: UpdateNotice };

/** Strictly newer; false when either version does not parse. */
function newerVersion(version: string, than: string): boolean {
  try {
    return order(version, than) === 1;
  } catch {
    return false;
  }
}

/**
 * The end of the restart this follow waits for, when the recorded result is
 * that one: it ended after the follow began and moved toward the follow's
 * version (or names none). An older target's end says nothing about this
 * update; a newer target's shows in the daemon's version.
 */
function followedRestartEnd(
  follow: UpdateFollow,
  result: AgenCDaemonRestartResult | null,
): AgenCDaemonRestartOutcome | undefined {
  if (result === null || follow.since === undefined) return undefined;
  if (Date.parse(result.finishedAt) < follow.since) return undefined;
  const toVersion = result.outcome.toVersion;
  return toVersion === undefined || toVersion === follow.request.targetVersion ? result.outcome : undefined;
}

function stop(kind: UpdateNotice["kind"], text: string): UpdateFollowStep {
  return { kind: "stop", notice: { kind, text } };
}

/**
 * The next step of a follow. Relaunch once the daemon runs the new version,
 * or once none runs and nothing is pending. Stop, and say why, once the
 * switch cannot happen: a newer version replaced the target, the restart
 * failed or was skipped, or it can no longer end (`deadlineMs` after
 * `since`).
 */
export function decideUpdateFollow(
  follow: UpdateFollow,
  seen: UpdateFollowObservation,
  deadlineMs: number,
): UpdateFollowStep {
  if (follow.when === "idle") return { kind: "relaunch" };
  const to = follow.request.targetVersion;
  const from = follow.request.fromVersion;
  const daemon = seen.daemonVersion;
  if (daemon === to) return { kind: "relaunch" };
  // One line each: the prompt shows a notice on one row, so what happened
  // and why come first, and what to do last.
  if (typeof daemon === "string" && newerVersion(daemon, to)) {
    return stop(
      "info",
      `The daemon now runs AgenC ${daemon}, newer than ${to}. This window stays on ${from}; quit and restart AgenC.`,
    );
  }
  const end = followedRestartEnd(follow, seen.result);
  if (end?.status === "failed") {
    return stop(
      "error",
      `Could not move to AgenC ${to}: ${end.reason ?? "the daemon restart failed"}. This window stays on ${from}; quit and restart AgenC.`,
    );
  }
  if (end?.status === "skipped" && end.code !== "already-current" && end.code !== "newer-daemon") {
    return stop(
      "info",
      `The daemon did not move to AgenC ${to}: ${end.reason ?? "no reason given"}. This window stays on ${from}; quit and restart AgenC.`,
    );
  }
  if (updateFollowReady(follow, daemon, seen.restartPending)) return { kind: "relaunch" };
  if (follow.since !== undefined && seen.now - follow.since >= deadlineMs) {
    return stop(
      "info",
      `The daemon did not move to AgenC ${to} within ${Math.round(deadlineMs / 3_600_000)} hours. This window stays on ${from}; quit and restart AgenC.`,
    );
  }
  return { kind: "wait" };
}

/**
 * One check of the pending follow: relaunch when it may and this session is
 * idle (`safe`), or stop following and say why. Returns the step taken.
 */
export function checkUpdateFollow({ agencHome, safe, now, deadlineMs, relaunch, notify }: {
  agencHome: string;
  safe: boolean;
  now: number;
  deadlineMs: number;
  relaunch: (request: UpdateRelaunchRequest) => void;
  notify: (notice: UpdateNotice) => void;
}): UpdateFollowStep["kind"] | "none" {
  let follow = getPendingUpdateFollow();
  if (follow === null) return "none";
  if (follow.when === "daemon" && follow.since === undefined) {
    // A follow made without a start counts from its first check.
    follow = { ...follow, since: now };
    setPendingUpdateFollow(follow);
  }
  const step: UpdateFollowStep = follow.when === "idle"
    ? { kind: "relaunch" }
    : decideUpdateFollow(follow, {
        daemonVersion: readDaemonRuntimeVersion(agencHome),
        restartPending: existsSync(join(agencHome, "daemon-restart-pending.json")),
        result: readDaemonRestartResult(agencHome),
        now,
      }, deadlineMs);
  if (step.kind === "stop") {
    setPendingUpdateFollow(null);
    notify(step.notice);
    return "stop";
  }
  if (step.kind === "wait" || !safe) return "wait";
  setPendingUpdateFollow(null);
  relaunch(follow.request);
  return "relaunch";
}

/**
 * After "Update after this turn", or when other work held the daemon back,
 * relaunch on the new version at the first idle moment that allows it, or
 * say why the switch is not going to happen.
 */
export function useUpdateFollow({ safe, agencHome, relaunch, notify }: {
  safe: boolean;
  agencHome: string;
  relaunch: (request: UpdateRelaunchRequest) => void;
  /** Shows why this window stopped following. */
  notify: (notice: UpdateNotice) => void;
}): void {
  const safeRef = React.useRef(safe);
  safeRef.current = safe;
  const relaunchRef = React.useRef(relaunch);
  relaunchRef.current = relaunch;
  const notifyRef = React.useRef(notify);
  notifyRef.current = notify;
  React.useEffect(() => {
    let syncing = false;
    const deadlineMs = resolveAgenCDaemonRestartFollowDeadlineMs(process.env, process.platform);
    const timer = setInterval(() => {
      const follow = getPendingUpdateFollow();
      if (follow === null) return;
      if (follow.when === "daemon" && !syncing) {
        // Keep the pending restart's exemption on exactly this TUI's current
        // attachments (they change when it reconnects).
        syncing = true;
        void import("../../app-server/daemon-restart-when-idle.js")
          .then(({ updateAgenCDaemonRestartRequesterAttachments }) =>
            updateAgenCDaemonRestartRequesterAttachments(
              { env: process.env, userHome: homedir() },
              process.pid,
              getAgenCTuiAttachmentIds(),
            ))
          .catch(() => false)
          .finally(() => { syncing = false; });
      }
      checkUpdateFollow({
        agencHome,
        safe: safeRef.current,
        now: Date.now(),
        deadlineMs,
        relaunch: (request) => relaunchRef.current(request),
        notify: (notice) => notifyRef.current(notice),
      });
    }, FOLLOW_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [agencHome]);
}
