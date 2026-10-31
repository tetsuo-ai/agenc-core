import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideUpdateRelaunch,
  runUpdateRelaunch,
  updateDaemonStepArgs,
  updateRelaunchArgs,
  updateRelaunchEnvironment,
  type UpdateRelaunchDeps,
} from "../../src/bin/update-relaunch.js";
import {
  AGENC_UPDATE_RELAUNCH_ENV,
  consumePendingUpdateNotice,
  encodeUpdateRelaunchMarker,
  resetUpdateRelaunchStateForTestingOnly,
  takeUpdateRelaunchMarker,
  type UpdateFollow,
  type UpdateNotice,
  type UpdateRelaunchRequest,
} from "../../src/tui/update-relaunch-state.js";
import type { AgenCDaemonRestartOutcome } from "../../src/app-server/daemon-restart-outcome.js";
import type { AgenCDaemonCliHost } from "../../src/app-server/daemon-control.js";
import {
  restartAgenCDaemonWhenIdle,
  writeAgenCDaemonPendingRestart,
} from "../../src/app-server/daemon-restart-when-idle.js";
import { updateFollowReady } from "../../src/tui/hooks/useUpdateFollow.js";

const request: UpdateRelaunchRequest = {
  fromVersion: "0.19.25",
  targetVersion: "0.19.26",
  command: "/home/u/.local/bin/agenc",
  installType: "install.sh",
  conversationId: "conv-abc123",
  cwd: "/work/project",
};

afterEach(() => resetUpdateRelaunchStateForTestingOnly());

function harness(outcome: AgenCDaemonRestartOutcome | Error, options: {
  readonly platform?: NodeJS.Platform;
  readonly execError?: Error;
} = {}) {
  const calls: string[] = [];
  const reopened: Array<{ notice: UpdateNotice; follow: UpdateFollow | null }> = [];
  let exec: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  let stepArgs: readonly string[] | undefined;
  const deps: UpdateRelaunchDeps = {
    pid: 4321,
    platform: options.platform ?? "darwin",
    env: { HOME: "/home/u", AGENC_TASK_LIST_ID: "t1", AGENC_DAEMON_AUTOSTART_FAILURE: "x", KEEP: "1" },
    runDaemonStep: async (_request, extraArgs) => {
      calls.push("daemon-step");
      stepArgs = extraArgs;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    execve: (file, args, env) => {
      calls.push("execve");
      if (options.execError !== undefined) throw options.execError;
      exec = { file, args, env };
    },
    chdir: (cwd) => calls.push(`chdir:${cwd}`),
    reopen: async (_request, notice, follow) => {
      calls.push("reopen");
      reopened.push({ notice, follow });
      return 0;
    },
    markerName: AGENC_UPDATE_RELAUNCH_ENV,
    encodeMarker: encodeUpdateRelaunchMarker,
    write: () => {},
    now: () => 1_000,
  };
  return { calls, deps, reopened, exec: () => exec, stepArgs: () => stepArgs };
}

describe("update relaunch decisions", () => {
  it.each([
    [{ status: "restarted", toVersion: "0.19.26", pid: 9 }],
    [{ status: "not-running", toVersion: "0.19.26" }],
    [{ status: "skipped", code: "already-current", toVersion: "0.19.26" }],
    [{ status: "skipped", code: "newer-daemon", toVersion: "0.19.26" }],
  ] as const)("starts the new version when the daemon is on it or free: %o", (outcome) => {
    expect(decideUpdateRelaunch(outcome as AgenCDaemonRestartOutcome, request)).toEqual({ kind: "exec" });
  });

  it("stays and follows when the daemon is busy, and says why", () => {
    const decision = decideUpdateRelaunch({ status: "deferred", reason: "1 client attached", toVersion: "0.19.26" }, request);
    expect(decision).toMatchObject({ kind: "stay", follow: "daemon", notice: { kind: "info" } });
    expect(decision.kind === "stay" && decision.notice.text).toBe(
      "Installed AgenC 0.19.26. The daemon is busy (1 client attached), so AgenC switches to 0.19.26 once that work is done. This window keeps running 0.19.25 until then.",
    );
  });

  it("follows the daemon, with no error, when the restart still runs past the update's wait", () => {
    const decision = decideUpdateRelaunch({
      status: "deferred",
      code: "still-running",
      reason: "no result after 36 minutes",
      toVersion: "0.19.26",
    }, request);
    expect(decision).toMatchObject({ kind: "stay", follow: "daemon", notice: { kind: "info" } });
    expect(decision.kind === "stay" && decision.notice.text).toBe(
      "Installed AgenC 0.19.26. The daemon restart is still running, so AgenC switches to 0.19.26 once it finishes. This window keeps running 0.19.25 until then.",
    );
  });

  it.each([
    [{ status: "failed", reason: "the daemon could not be stopped" }],
    [{ status: "skipped", reason: "the daemon runs from outside this install (for example the Desktop app)" }],
    [{ status: "skipped", code: "unsupported", reason: "AgenC 0.19.26 cannot restart the daemon by itself" }],
  ] as const)("stays with the reason when the daemon cannot move: %o", (outcome) => {
    const decision = decideUpdateRelaunch(outcome as AgenCDaemonRestartOutcome, request);
    expect(decision).toMatchObject({ kind: "stay", notice: { kind: "error" } });
    expect(decision.kind === "stay" && decision.follow).toBeUndefined();
    expect(decision.kind === "stay" && decision.notice.text).toContain(outcome.reason);
  });

  it("reopens the same conversation and names this TUI as the requester", () => {
    expect(updateRelaunchArgs(request)).toEqual(["--resume", "conv-abc123"]);
    expect(updateRelaunchArgs({ ...request, conversationId: undefined })).toEqual([]);
    expect(updateDaemonStepArgs(request, 4321)).toEqual(["--requester-pid", "4321", "--requester-agent", "conv-abc123"]);
    expect(updateDaemonStepArgs({ ...request, conversationId: undefined }, 4321)).toEqual(["--requester-pid", "4321"]);
  });

  it("drops this session's own values and adds the marker", () => {
    const env = updateRelaunchEnvironment({ A: "1", AGENC_TASK_LIST_ID: "t", AGENC_DAEMON_AUTOSTART_FAILURE: "f" }, "M", "v");
    expect(env).toEqual({ A: "1", M: "v" });
  });
});

describe("runUpdateRelaunch", () => {
  it("replaces this process with the new version in the conversation's directory", async () => {
    const h = harness({ status: "restarted", toVersion: "0.19.26", pid: 9 });
    await runUpdateRelaunch(request, h.deps);
    expect(h.calls).toEqual(["daemon-step", "chdir:/work/project", "execve"]);
    expect(h.stepArgs()).toEqual(["--requester-pid", "4321", "--requester-agent", "conv-abc123"]);
    expect(h.exec()).toEqual({
      file: "/home/u/.local/bin/agenc",
      args: ["/home/u/.local/bin/agenc", "--resume", "conv-abc123"],
      env: { HOME: "/home/u", KEEP: "1", [AGENC_UPDATE_RELAUNCH_ENV]: JSON.stringify({ version: "0.19.26" }) },
    });
  });

  it("reopens this version and follows when the daemon is busy", async () => {
    const h = harness({ status: "deferred", reason: "1 client attached", toVersion: "0.19.26" });
    await runUpdateRelaunch(request, h.deps);
    expect(h.calls).toEqual(["daemon-step", "reopen"]);
    expect(h.reopened[0]?.follow).toEqual({ request, when: "daemon", since: 1_000 });
  });

  it("stamps the follow with when the daemon step began, before the step runs", async () => {
    let clock = 5_000;
    const h = harness({ status: "deferred", code: "still-running", reason: "no result after 36 minutes", toVersion: "0.19.26" });
    const step = h.deps.runDaemonStep;
    await runUpdateRelaunch(request, {
      ...h.deps,
      now: () => clock,
      // The step takes a while: results that end during it are this update's.
      runDaemonStep: async (r, args) => {
        clock = 5_000 + 36 * 60_000;
        return step(r, args);
      },
    });
    expect(h.reopened[0]?.follow).toEqual({ request, when: "daemon", since: 5_000 });
  });

  it("reopens this version with the reason when the new one cannot start", async () => {
    const h = harness({ status: "restarted", toVersion: "0.19.26", pid: 9 }, { execError: new Error("ENOENT") });
    await runUpdateRelaunch(request, h.deps);
    expect(h.calls).toEqual(["daemon-step", "chdir:/work/project", "execve", "reopen"]);
    expect(h.reopened[0]).toEqual({
      notice: { kind: "error", text: "Could not start AgenC 0.19.26 (ENOENT). This window keeps running 0.19.25." },
      follow: null,
    });
  });

  it("treats a daemon step that throws as a failed restart", async () => {
    const h = harness(new Error("spawn EACCES"));
    await runUpdateRelaunch(request, h.deps);
    expect(h.calls).toEqual(["daemon-step", "reopen"]);
    expect(h.reopened[0]?.notice.text).toContain("spawn EACCES");
  });

  it("keeps the restart message on Windows", async () => {
    const h = harness({ status: "restarted", toVersion: "0.19.26", pid: 9 }, { platform: "win32" });
    await runUpdateRelaunch(request, h.deps);
    expect(h.calls).toEqual(["reopen"]);
    expect(h.reopened[0]?.notice.text).toBe("Installed AgenC 0.19.26. Quit AgenC and start it again to use it.");
  });
});

describe("the relaunch marker", () => {
  it("is read once, removed from the environment, and becomes the notice", () => {
    const env: NodeJS.ProcessEnv = { [AGENC_UPDATE_RELAUNCH_ENV]: encodeUpdateRelaunchMarker("0.19.26") };
    expect(takeUpdateRelaunchMarker(env)).toBe("0.19.26");
    expect(env[AGENC_UPDATE_RELAUNCH_ENV]).toBeUndefined();
    expect(consumePendingUpdateNotice()).toEqual({ kind: "info", text: "Updated to AgenC 0.19.26." });
    expect(consumePendingUpdateNotice()).toBeNull();
  });

  it("ignores a malformed marker", () => {
    const env: NodeJS.ProcessEnv = { [AGENC_UPDATE_RELAUNCH_ENV]: "{not json" };
    expect(takeUpdateRelaunchMarker(env)).toBeNull();
    expect(env[AGENC_UPDATE_RELAUNCH_ENV]).toBeUndefined();
    expect(takeUpdateRelaunchMarker({ [AGENC_UPDATE_RELAUNCH_ENV]: JSON.stringify({ version: "../x y" }) })).toBeNull();
  });
});

describe("a restart onto a newer build that another update left waiting", () => {
  it("makes this window follow the daemon to that build, not to its own", async () => {
    const home = mkdtempSync(join(tmpdir(), "urn-"));
    try {
      const daemon = {
        pid: 4242,
        instanceId: "instance-4242",
        processStart: "start-4242",
        runtimeVersion: "0.19.25",
        commit: "c25",
        buildTime: "2026-10-01T00:00:00.000Z",
      };
      writeAgenCDaemonPendingRestart(home, {
        schemaVersion: 1,
        token: "1b8f5f3c-2b1a-4d6e-9f00-0123456789ab",
        createdAt: new Date().toISOString(),
        notAfter: new Date(Date.now() + 3_600_000).toISOString(),
        daemon: { pid: daemon.pid, instanceId: daemon.instanceId },
        target: { runtimeVersion: "0.19.27", commit: "c27", buildTime: "2026-10-30T00:00:00.000Z" },
      });
      const host = {
        env: { AGENC_HOME: home },
        userHome: home,
        platform: "darwin",
        pid: 7000,
        isPidRunning: () => true,
      } as unknown as AgenCDaemonCliHost;
      // The real step of the 0.19.26 runtime this window installed, with the daemon busy.
      const outcome = await restartAgenCDaemonWhenIdle(host, {}, {
        ownBuild: () => ({ runtimeVersion: "0.19.26", commit: "c26", buildTime: "2026-10-29T00:00:00.000Z" }),
        readState: async () => ({ kind: "running", identity: daemon }),
        daemonCommand: () => `${home}/runtime/0.19.25/tree/node_modules/@tetsuo-ai/runtime/bin/agenc daemon start --foreground`,
        probe: async () => ({ idle: false, reason: "1 client attached" }),
        withLifecycleLock: async (_host, operation) => operation(),
        spawnWaiter: () => {
          throw new Error("the restart onto 0.19.27 already waits");
        },
        requester: { pid: 4321, agentId: "conv-abc123" },
      });
      const h = harness(outcome);
      await runUpdateRelaunch(request, h.deps);
      const follow = h.reopened[0]?.follow;
      expect(follow?.request.targetVersion).toBe("0.19.27");
      expect(h.reopened[0]?.notice.text).toBe(
        "Installed AgenC 0.19.26. The daemon is busy (1 client attached), so AgenC switches to 0.19.27 once that work is done. This window keeps running 0.19.25 until then.",
      );
      // The window moves once the daemon runs 0.19.27, the build it really goes to.
      expect(updateFollowReady(follow!, "0.19.27", false)).toBe(true);
      expect(updateFollowReady(follow!, "0.19.25", true)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
