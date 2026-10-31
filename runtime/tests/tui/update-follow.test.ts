import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENC_DAEMON_RESTART_MAX_WAIT_MS,
  resolveAgenCDaemonRestartFollowDeadlineMs,
  resolveAgenCDaemonRestartHandoffTimeoutMs,
} from "../../src/app-server/daemon-restart-handoff.js";
import {
  AGENC_DAEMON_RESTART_RESULTS_KEPT,
  type AgenCDaemonRestartOutcome,
  type AgenCDaemonRestartResult,
} from "../../src/app-server/daemon-restart-outcome.js";
import { publishAgenCDaemonRestartResult } from "../../src/app-server/daemon-restart-when-idle.js";
import { runUpdateRelaunch, type UpdateRelaunchDeps } from "../../src/bin/update-relaunch.js";
import {
  checkUpdateFollow,
  decideUpdateFollow,
  readDaemonRestartResults,
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

/** Monotonic clock values (performance.now), not wall-clock times. */
const SINCE = 50_000;
const DEADLINE = resolveAgenCDaemonRestartFollowDeadlineMs({}, "linux");
const MINE = "4a1b2c3d-0000-4000-8000-000000000001";
const OTHER = "4a1b2c3d-0000-4000-8000-000000000002";
const following: UpdateFollow = { request, when: "daemon", since: SINCE, requestId: MINE };

function ended(
  requestId: string,
  outcome: AgenCDaemonRestartOutcome,
  extra: { readonly finishedAt?: string; readonly continuedBy?: string } = {},
): AgenCDaemonRestartResult {
  return { requestId, finishedAt: extra.finishedAt ?? "2026-10-31T12:00:00.000Z", outcome, ...(extra.continuedBy ? { continuedBy: extra.continuedBy } : {}) };
}

function seen(overrides: Partial<UpdateFollowObservation> = {}): UpdateFollowObservation {
  return { daemonVersion: "0.19.25", restartPending: true, results: [], now: SINCE + 120_000, ...overrides };
}

const failed = (toVersion = "0.19.26"): AgenCDaemonRestartOutcome => ({
  status: "failed",
  reason: "the daemon stopped but did not start again",
  toVersion,
});

afterEach(() => {
  resetUpdateRelaunchStateForTestingOnly();
  vi.useRealTimers();
});

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

  const pending = (present: boolean): void => {
    const path = join(home, "daemon-restart-pending.json");
    if (present) writeFileSync(path, "{}");
    else rmSync(path, { force: true });
  };

  /** "Update now" whose daemon step outlives the update's wait, as the TUI runs it. */
  async function updateWhoseRestartStillRuns(): Promise<UpdateFollow> {
    let follow: UpdateFollow | null = null;
    let stepArgs: readonly string[] = [];
    const deps: UpdateRelaunchDeps = {
      pid: 4321,
      platform: "linux",
      env: {},
      now: () => SINCE,
      newRequestId: () => MINE,
      runDaemonStep: async (_request, extraArgs) => {
        stepArgs = extraArgs;
        return { status: "deferred", code: "still-running", reason: "no result after 36 minutes", toVersion: "0.19.26" };
      },
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
    expect(stepArgs).toEqual(["--requester-pid", "4321", "--request-id", MINE]);
    expect(follow).toEqual({ request, when: "daemon", since: SINCE, requestId: MINE });
    // The reopened TUI picks the follow up.
    setPendingUpdateFollow(follow);
    return follow!;
  }

  it("reports a restart that fails after the update stopped waiting, then stops following", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    pending(true);
    expect(check(SINCE + 37 * 60_000)).toBe("wait");
    // The step the update handed off ends later, and fails.
    await publishAgenCDaemonRestartResult(home, ended(MINE, {
      status: "failed",
      reason: "the daemon could not be stopped",
      fromVersion: "0.19.25",
      toVersion: "0.19.26",
    }));
    // Reported at once, even in the middle of a turn.
    expect(check(SINCE + 41 * 60_000, false)).toBe("stop");
    expect(notices).toEqual([{
      kind: "error",
      text: "Could not move to AgenC 0.19.26: the daemon could not be stopped. This window stays on 0.19.25; quit and restart AgenC.",
    }]);
    expect(relaunched).toEqual([]);
    expect(getPendingUpdateFollow()).toBeNull();
    expect(check(SINCE + 43 * 60_000)).toBe("none");
    expect(notices).toHaveLength(1);
  });

  it("keeps the follow's own failure when another request ends before the next poll", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    pending(false);
    // Two ends between two polls: this request's failure, then another one's.
    await publishAgenCDaemonRestartResult(home, ended(MINE, failed()));
    await publishAgenCDaemonRestartResult(home, ended(OTHER, { status: "restarted", toVersion: "0.19.27", pid: 7 }));
    expect(readDaemonRestartResults(home).map((result) => result.requestId)).toEqual([MINE, OTHER]);
    expect(check(SINCE + 60_000)).toBe("stop");
    expect(notices[0]?.text).toContain("the daemon stopped but did not start again");
  });

  it("keeps the last results of 8 requests, one per request, and the first end of each", async () => {
    const ids = Array.from({ length: AGENC_DAEMON_RESTART_RESULTS_KEPT + 1 }, (_, n) => `4a1b2c3d-0000-4000-a000-${String(n).padStart(12, "0")}`);
    for (const id of ids) await publishAgenCDaemonRestartResult(home, ended(id, failed()));
    // A later end of the same request never replaces its first.
    await publishAgenCDaemonRestartResult(home, ended(ids[3]!, { status: "skipped", reason: "a newer update replaced this restart", toVersion: "0.19.26" }));
    const kept = readDaemonRestartResults(home);
    expect(kept).toHaveLength(AGENC_DAEMON_RESTART_RESULTS_KEPT);
    expect(kept.map((result) => result.requestId)).toEqual(ids.slice(1));
    expect(kept.find((result) => result.requestId === ids[3])?.outcome.status).toBe("failed");
    // A hand-over is not an end: the request's end still lands.
    await publishAgenCDaemonRestartResult(home, ended(MINE, { status: "deferred", toVersion: "0.19.27" }, { continuedBy: OTHER }));
    await publishAgenCDaemonRestartResult(home, ended(MINE, { status: "restarted", toVersion: "0.19.26", pid: 9 }));
    expect(readDaemonRestartResults(home).find((result) => result.requestId === MINE)).toMatchObject({ outcome: { status: "restarted" } });
    expect(readDaemonRestartResults(home).find((result) => result.requestId === MINE)?.continuedBy).toBeUndefined();
  });

  it("known limit: eight newer ends before the next poll evict an unread one, and the follow falls back to its deadline", async () => {
    await updateWhoseRestartStillRuns();
    rmSync(join(home, "daemon-runtime.json"), { force: true });
    pending(false);
    await publishAgenCDaemonRestartResult(home, ended(MINE, failed()));
    for (let n = 0; n < AGENC_DAEMON_RESTART_RESULTS_KEPT; n += 1) {
      await publishAgenCDaemonRestartResult(home, ended(`4a1b2c3d-0000-4000-9000-${String(n).padStart(12, "0")}`, failed("0.19.27")));
    }
    expect(check(SINCE + 60_000)).toBe("wait");
    expect(check(SINCE + DEADLINE)).toBe("stop");
    expect(notices.at(-1)?.text).toContain("within 13 hours");
  });

  it("does not relaunch between a restart's stop and its end: no daemon and nothing pending is not enough", async () => {
    await updateWhoseRestartStillRuns();
    rmSync(join(home, "daemon-runtime.json"), { force: true });
    pending(false);
    // The handed-off step sits between stop and start: no result yet.
    expect(check(SINCE + 60_000)).toBe("wait");
    // Its end is published before anything is cleared; then the new version starts its own daemon.
    await publishAgenCDaemonRestartResult(home, ended(MINE, { status: "not-running", toVersion: "0.19.26" }));
    expect(check(SINCE + 62_000)).toBe("relaunch");
    expect(relaunched).toEqual([request]);
  });

  it("sees a failure published before the pending record is cleared", async () => {
    await updateWhoseRestartStillRuns();
    rmSync(join(home, "daemon-runtime.json"), { force: true });
    // Published, not yet cleared: the record is still there.
    pending(true);
    await publishAgenCDaemonRestartResult(home, ended(MINE, failed()));
    expect(check(SINCE + 60_000)).toBe("stop");
    expect(relaunched).toEqual([]);
    expect(notices[0]?.kind).toBe("error");
  });

  it("follows a newer request that took this one's place", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    pending(true);
    await publishAgenCDaemonRestartResult(home, ended(MINE, {
      status: "skipped",
      reason: "a newer update replaced this restart",
      toVersion: "0.19.26",
    }, { continuedBy: OTHER }));
    expect(check(SINCE + 60_000)).toBe("continue");
    expect(getPendingUpdateFollow()).toEqual({ request, when: "daemon", since: SINCE, requestId: OTHER });
    expect(check(SINCE + 62_000)).toBe("wait");
    // That request's restart then succeeds.
    await publishAgenCDaemonRestartResult(home, ended(OTHER, { status: "restarted", toVersion: "0.19.26", pid: 5 }));
    daemonRuns("0.19.26");
    expect(check(SINCE + 64_000)).toBe("relaunch");
    expect(notices).toEqual([]);
  });

  it("stops, without an error, when a newer daemon supersedes the target", async () => {
    await updateWhoseRestartStillRuns();
    daemonRuns("0.19.25");
    expect(check(SINCE + 60_000)).toBe("wait");
    daemonRuns("0.19.27");
    expect(check(SINCE + 62_000)).toBe("stop");
    expect(notices).toEqual([{
      kind: "info",
      text: "The daemon now runs AgenC 0.19.27, newer than 0.19.26. This window stays on 0.19.25; quit and restart AgenC.",
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
      text: "The daemon did not move to AgenC 0.19.26 within 13 hours. This window stays on 0.19.25; quit and restart AgenC.",
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
    setPendingUpdateFollow({ request, when: "daemon", requestId: MINE });
    daemonRuns("0.19.25");
    expect(check(SINCE)).toBe("wait");
    expect(getPendingUpdateFollow()).toEqual({ request, when: "daemon", since: SINCE, requestId: MINE });
    expect(check(SINCE + DEADLINE)).toBe("stop");
  });
});

describe("the follow decision", () => {
  it("reads only its own request's end, by id", () => {
    // Another request's failure, even for the same version.
    expect(decideUpdateFollow(following, seen({ results: [ended(OTHER, failed())] }), DEADLINE)).toEqual({ kind: "wait" });
    expect(decideUpdateFollow(following, seen({ results: [ended(OTHER, failed()), ended(MINE, failed())] }), DEADLINE))
      .toMatchObject({ kind: "stop", notice: { kind: "error" } });
    // A follow without an id reads no results.
    expect(decideUpdateFollow({ request, when: "daemon", since: SINCE }, seen({ results: [ended(MINE, failed())] }), DEADLINE))
      .toEqual({ kind: "wait" });
  });

  it("is not moved by clock changes: no result time is compared, the deadline uses the monotonic clock", () => {
    vi.useFakeTimers();
    const results = [
      ended(OTHER, failed(), { finishedAt: "2099-01-01T00:00:00.000Z" }),
      ended(MINE, { status: "restarted", toVersion: "0.19.26", pid: 5 }, { finishedAt: "1999-01-01T00:00:00.000Z" }),
    ];
    for (const wallClock of ["1990-01-01T00:00:00.000Z", "2026-10-31T12:00:00.000Z", "2100-01-01T00:00:00.000Z"]) {
      vi.setSystemTime(new Date(wallClock));
      // An end from "the past" still counts; a "newer" one of another request does not.
      expect(decideUpdateFollow(following, seen({ daemonVersion: null, restartPending: false, results }), DEADLINE))
        .toEqual({ kind: "relaunch" });
      expect(decideUpdateFollow(following, seen({ results: [] }), DEADLINE)).toEqual({ kind: "wait" });
    }
  });

  it("stops with the reason when its restart was skipped, and waits on the daemon for current or newer", () => {
    const replaced = decideUpdateFollow(following, seen({
      results: [ended(MINE, { status: "skipped", reason: "the daemon stayed busy until the waiting time ran out", toVersion: "0.19.26" })],
    }), DEADLINE);
    expect(replaced).toEqual({
      kind: "stop",
      notice: {
        kind: "info",
        text: "The daemon did not move to AgenC 0.19.26: the daemon stayed busy until the waiting time ran out. This window stays on 0.19.25; quit and restart AgenC.",
      },
    });
    for (const code of ["already-current", "newer-daemon"] as const) {
      expect(decideUpdateFollow(following, seen({
        daemonVersion: undefined,
        results: [ended(MINE, { status: "skipped", code, reason: "r", toVersion: "0.19.26" })],
      }), DEADLINE)).toEqual({ kind: "wait" });
    }
  });

  it("relaunches when the daemon runs the target, whatever its results say", () => {
    expect(decideUpdateFollow(following, seen({ daemonVersion: "0.19.26", results: [ended(MINE, failed())] }), DEADLINE))
      .toEqual({ kind: "relaunch" });
    expect(decideUpdateFollow(following, seen({ daemonVersion: null, restartPending: false, results: [ended(MINE, failed())] }), DEADLINE))
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

  it("fits each notice without a reason on the prompt's one notification row of a 120-column terminal", () => {
    const notices = [
      decideUpdateFollow(following, seen({ daemonVersion: "10.20.300" }), DEADLINE),
      decideUpdateFollow(following, seen({ now: SINCE + DEADLINE }), DEADLINE),
      decideUpdateFollow(following, seen({ results: [ended(MINE, { status: "failed", toVersion: "0.19.26" })] }), DEADLINE),
      decideUpdateFollow(following, seen({ results: [ended(MINE, { status: "skipped", toVersion: "0.19.26" })] }), DEADLINE),
    ];
    for (const step of notices) {
      expect(step.kind).toBe("stop");
      expect(step.kind === "stop" && step.notice.text.length).toBeLessThanOrEqual(117);
    }
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
