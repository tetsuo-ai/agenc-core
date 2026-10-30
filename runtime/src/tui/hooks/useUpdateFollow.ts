import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAgenCTuiAttachmentIds,
  getPendingUpdateFollow,
  setPendingUpdateFollow,
  type UpdateFollow,
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

/**
 * After "Update after this turn", or when other work held the daemon back,
 * relaunch on the new version at the first idle moment that allows it.
 */
export function useUpdateFollow({ safe, agencHome, relaunch }: {
  safe: boolean;
  agencHome: string;
  relaunch: (request: UpdateRelaunchRequest) => void;
}): void {
  const safeRef = React.useRef(safe);
  safeRef.current = safe;
  const relaunchRef = React.useRef(relaunch);
  relaunchRef.current = relaunch;
  React.useEffect(() => {
    let syncing = false;
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
      if (!safeRef.current) return;
      const ready = follow.when === "idle" || updateFollowReady(
        follow,
        readDaemonRuntimeVersion(agencHome),
        existsSync(join(agencHome, "daemon-restart-pending.json")),
      );
      if (!ready) return;
      setPendingUpdateFollow(null);
      relaunchRef.current(follow.request);
    }, FOLLOW_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [agencHome]);
}
