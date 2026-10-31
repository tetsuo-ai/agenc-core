import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_RESTART_MAX_WAIT_MS,
  resolveAgenCDaemonRestartFollowDeadlineMs,
  resolveAgenCDaemonRestartHandoffTimeoutMs,
} from "../../src/app-server/daemon-restart-handoff.js";
import type { AgenCDaemonRestartOutcome, AgenCDaemonRestartResult } from "../../src/app-server/daemon-restart-outcome.js";
import { recordAgenCDaemonRestartResult } from "../../src/app-server/daemon-restart-when-idle.js";
import { runUpdateRelaunch, type UpdateRelaunchDeps } from "../../src/bin/update-relaunch.js";
import {
  checkUpdateFollow,
  decideUpdateFollow,
  readDaemonRestartResult,
  readDaemonRuntimeVersion,
  updateFollowReady,
  type UpdateFollowObservation,
} from "../../src/tui/hooks/useUpdateFollow.js";
import {
  AGENC_UPDATE_RELAUNCH_ENV,
  encodeUpdateRelaunchMarker,
  getPendingUpdateFollow,
  resetUpdateRelaunchStateForTestingOnly,
  setPendingUpdateFollow,
  type UpdateFollow,
  type UpdateNotice,
  type UpdateRelaunchRequest,
} from "../../src/tui/update-relaunch-state.js";

const request = {
  fromVersion: "0.19.25", targetVersion: "0.19.26", command: "/w/agenc", installType: "install.sh" as const, cwd: "/w",
};

const SINCE = Date.parse("2026-10-31T12:00:00.000Z");
const DEADLINE = resolveAgenCDaemonRestartFollowDeadlineMs({}, "linux");
const following: UpdateFollow = { request, when: "daemon", since: SINCE };

function ended(outcome: AgenCDaemonRestartOutcome, at = SINCE + 60_000): AgenCDaemonRestartResult {
  return { finishedAt: new Date(at).toISOString(), outcome };
}

function seen(overrides: Partial<UpdateFollowObservation> = {}): UpdateFollowObservation {
  return { daemonVersion: "0.19.25", restartPending: false, result: null, now: SINCE + 120_000, ...overrides };
}

afterEach(() => resetUpdateRelaunchStateForTestingOnly());

describe("following an update", () => {
  it("waits only for idle after this turn, and for the daemon after a busy restart", () => {
    expect(updateFollowReady({ request, when: "idle" }, "0.19.25", true)).toBe(true);
    expect(updateFollowReady({ request, when: "daemon" }, "0.19.25", true)).toBe(false);
    expect(updateFollowReady({ request, when: "daemon" }, undefined, true)).toBe(false);
    expect(updateFollowReady({ request, when: "daemon" }, "0.19.26", true)).toBe(true);
    // Between stop and start the sidecar is gone but the restart is pending.
    expect(updateFollowReady({ request, when: "daemon" }, null, true)).toBe(false);
    // No daemon and nothing pending: the new version starts its own.
    expect(updateFollowReady({ request, when: "daemon" }, null, false)).toBe(true);
  });

  it("reads the daemon's version from its sidecar", () => {
    const home = mkdtempSync(join(tmpdir(), "follow-"));
    try {
      expect(readDaemonRuntimeVersion(home)).toBeNull();
      writeFileSync(join(home, "daemon-runtime.json"), JSON.stringify({ pid: 5, runtimeVersion: "0.19.26" }));
      expect(readDaemonRuntimeVersion(home)).toBe("0.19.26");
      writeFileSync(join(home, "daemon-runtime.json"), "{");
      expect(readDaemonRuntimeVersion(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("following the daemon after the update stopped waiting for its restart", () => {
  let home: string;
  let notices: UpdateNotice[];
  let relaunched: UpdateRelaunchRequest[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "follow-"));
    notices = [];
    relaunched = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const check = (now: number, safe = true) => checkUpdateFollow({
    agencHome: home,
    safe,
    now,
    deadlineMs: DEADLINE,
    relaunch: (r) => relaunched.push(r),
    notify: (notice) => notices.push(notice),
  });

  const daemonRuns = (version: string): void => {
    writeFileSync(join(home, "daemon-runtime.json"), JSON.stringify({ pid: 4242, runtimeVersion: version }));
  };

  /** "Update now" whose daemon step outlives the update's wait, as the TUI runs it. */
  async function updateWhoseRestartStillRuns(): Promise<UpdateFollow> {
    let follow: UpdateFollow | null = null;
    const deps: UpdateRelaunchDeps = {
      pid: 4321,
      platform: "linux",
      env: {},
      now: () => SINCE,
      runDaemonStep: async () => ({
        status: "deferred",
        code: "still-running",
        reason: "no result after 36 minutes",
        toVersion: "0.19.26",
      }),
      execve: () => {
        throw new Error("this window stays");
      },
      chdir: () => {},
      reopen: async (_request, _notice, next) => {
        follow = next;
        return 0;
      },
      markerName: AGENC_UPDATE_RELAUNCH_ENV,
      encodeMarker: encodeUpdateRelaunchMarker,
      write: () => {},
    };
    await runUpdateRelaunch(request, deps);
    expect(follow).toEqual({ request, when: "daemon", since: SINCE });
    // The reopened TUI picks the follow up.
    setPendingUpdateFollow(follow);
    return follow!;
  }

  it("reports a restart that fails after the update stopped waiting, then stops following", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    expect(check(SINCE + 37 * 60_000)).toBe("wait");
    // The restart step the update handed off ends later, and fails.
    recordAgenCDaemonRestartResult(home, {
      status: "failed",
      reason: "the daemon could not be stopped",
      fromVersion: "0.19.25",
      toVersion: "0.19.26",
    }, new Date(SINCE + 40 * 60_000));
    // Reported at once, even in the middle of a turn.
    expect(check(SINCE + 41 * 60_000, false)).toBe("stop");
    expect(notices).toEqual([{
      kind: "error",
      text: "The daemon could not move to AgenC 0.19.26 (the daemon could not be stopped). This window keeps running 0.19.25. Quit AgenC and start it again to use 0.19.26.",
    }]);
    expect(relaunched).toEqual([]);
    expect(getPendingUpdateFollow()).toBeNull();
    expect(check(SINCE + 43 * 60_000)).toBe("none");
    expect(notices).toHaveLength(1);
  });

  it("stops, without an error, when a newer daemon supersedes the target", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    expect(check(SINCE + 60_000)).toBe("wait");
    // Another update moved the daemon past this one's version.
    daemonRuns("0.19.27");
    expect(check(SINCE + 62_000)).toBe("stop");
    expect(notices).toEqual([{
      kind: "info",
      text: "The daemon moved to AgenC 0.19.27, which is newer than 0.19.26. This window keeps running 0.19.25. Quit AgenC and start it again to use 0.19.27.",
    }]);
    expect(relaunched).toEqual([]);
    expect(getPendingUpdateFollow()).toBeNull();
  });

  it("gives up once the restart can no longer end, and says so", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    expect(check(SINCE + DEADLINE - 1)).toBe("wait");
    expect(check(SINCE + DEADLINE)).toBe("stop");
    expect(notices).toEqual([{
      kind: "info",
      text: "Stopped waiting for the daemon to move to AgenC 0.19.26 after 13 hours. This window keeps running 0.19.25. Quit AgenC and start it again to use 0.19.26.",
    }]);
    expect(getPendingUpdateFollow()).toBeNull();
  });

  it("still relaunches once the daemon runs the new version, at a safe moment", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.26");
    expect(check(SINCE + 60_000, false)).toBe("wait");
    expect(getPendingUpdateFollow()).not.toBeNull();
    expect(check(SINCE + 62_000)).toBe("relaunch");
    expect(relaunched).toEqual([request]);
    expect(notices).toEqual([]);
    expect(getPendingUpdateFollow()).toBeNull();
  });

  it("counts a follow made without a start from its first check", () => {
    setPendingUpdateFollow({ request, when: "daemon" });
    daemonRuns("0.19.25");
    expect(check(SINCE)).toBe("wait");
    expect(getPendingUpdateFollow()).toEqual({ request, when: "daemon", since: SINCE });
    expect(check(SINCE + DEADLINE)).toBe("stop");
  });

  it("reads the restart result the restart step writes", () => {
    expect(readDaemonRestartResult(home)).toBeNull();
    recordAgenCDaemonRestartResult(home, { status: "restarted", fromVersion: "0.19.25", toVersion: "0.19.26", pid: 9 }, new Date(SINCE));
    expect(readDaemonRestartResult(home)).toEqual({
      finishedAt: new Date(SINCE).toISOString(),
      outcome: { status: "restarted", fromVersion: "0.19.25", toVersion: "0.19.26", pid: 9 },
    });
    writeFileSync(join(home, "daemon-restart-result.json"), "{");
    expect(readDaemonRestartResult(home)).toBeNull();
  });
});

describe("the follow decision", () => {
  const failed = (toVersion?: string): AgenCDaemonRestartOutcome => ({
    status: "failed",
    reason: "the daemon stopped but did not start again",
    ...(toVersion === undefined ? {} : { toVersion }),
  });

  it("reads only this update's end: after its step began, toward its version or none", () => {
    // An earlier restart's end.
    expect(decideUpdateFollow(following, seen({ result: ended(failed("0.19.26"), SINCE - 1) }), DEADLINE))
      .toEqual({ kind: "wait" });
    // A restart toward an older version says nothing about this one.
    expect(decideUpdateFollow(following, seen({ result: ended(failed("0.19.24")) }), DEADLINE))
      .toEqual({ kind: "wait" });
    // A newer target's failure: this restart may still come.
    expect(decideUpdateFollow(following, seen({ result: ended(failed("0.19.27")) }), DEADLINE))
      .toEqual({ kind: "wait" });
    // A step that stopped on an unexpected error names no version.
    expect(decideUpdateFollow(following, seen({ result: ended(failed()) }), DEADLINE))
      .toMatchObject({ kind: "stop", notice: { kind: "error" } });
    expect(decideUpdateFollow(following, seen({ result: ended(failed("0.19.26"), SINCE) }), DEADLINE))
      .toMatchObject({ kind: "stop", notice: { kind: "error" } });
  });

  it("stops with the reason when the restart was skipped, and waits on the daemon for current or newer", () => {
    const replaced = decideUpdateFollow(following, seen({
      result: ended({ status: "skipped", reason: "a newer update replaced this restart", toVersion: "0.19.26" }),
    }), DEADLINE);
    expect(replaced).toEqual({
      kind: "stop",
      notice: {
        kind: "info",
        text: "The daemon did not move to AgenC 0.19.26 (a newer update replaced this restart). This window keeps running 0.19.25. Quit AgenC and start it again to use the installed version.",
      },
    });
    for (const code of ["already-current", "newer-daemon"] as const) {
      expect(decideUpdateFollow(following, seen({
        daemonVersion: undefined,
        result: ended({ status: "skipped", code, reason: "r", toVersion: "0.19.26" }),
      }), DEADLINE)).toEqual({ kind: "wait" });
    }
  });

  it("relaunches when the daemon runs the target, whatever the last result says", () => {
    expect(decideUpdateFollow(following, seen({ daemonVersion: "0.19.26", result: ended(failed("0.19.26")) }), DEADLINE))
      .toEqual({ kind: "relaunch" });
    // No daemon and nothing pending, as before, unless this restart failed.
    expect(decideUpdateFollow(following, seen({ daemonVersion: null }), DEADLINE)).toEqual({ kind: "relaunch" });
    expect(decideUpdateFollow(following, seen({ daemonVersion: null, result: ended(failed("0.19.26")) }), DEADLINE))
      .toMatchObject({ kind: "stop", notice: { kind: "error" } });
    expect(decideUpdateFollow({ request, when: "idle" }, seen(), DEADLINE)).toEqual({ kind: "relaunch" });
  });

  it("treats only a strictly newer daemon as superseding", () => {
    expect(decideUpdateFollow(following, seen({ daemonVersion: "0.19.27", restartPending: true }), DEADLINE))
      .toMatchObject({ kind: "stop", notice: { kind: "info" } });
    expect(decideUpdateFollow(following, seen({ daemonVersion: "0.19.25", restartPending: true }), DEADLINE))
      .toEqual({ kind: "wait" });
    expect(decideUpdateFollow(following, seen({ daemonVersion: "not a version" }), DEADLINE)).toEqual({ kind: "wait" });
  });

  it("outlasts every restart that can still end: the step, the waiting process and its restart", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const handoff = resolveAgenCDaemonRestartHandoffTimeoutMs({}, platform);
      expect(resolveAgenCDaemonRestartFollowDeadlineMs({}, platform)).toBe(AGENC_DAEMON_RESTART_MAX_WAIT_MS + 2 * handoff);
    }
    expect(DEADLINE).toBe(12 * 3_600_000 + 2 * 2_131_000);
    expect(decideUpdateFollow(following, seen({ now: SINCE + DEADLINE - 1 }), DEADLINE)).toEqual({ kind: "wait" });
  });
});
