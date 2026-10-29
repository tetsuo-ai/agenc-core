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
    expect(h.reopened[0]?.follow).toEqual({ request, when: "daemon" });
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
