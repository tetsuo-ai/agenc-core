import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import { resolveLatestSessionId } from "../bin/resume-session.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { canonicalRolloutHoldsNoInput } from "../session/rollout-input.js";
import { UNUSED_TUI_PREWARM_STOP_REASON } from "./agent-stop-reasons.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { resolveAgentRuntimeOptions } from "../session/runtime-options.js";

// The TUI creates its daemon session while the user types the first prompt.
// When nobody uses that session (the TUI closes first, a staged startup choice
// replaces it, or the daemon restarts under it), its stop must leave nothing
// behind: no session in the daemon's list, none for `--continue`, no session
// directory, across a daemon restart. A thread that holds any input is never
// archived this way, and `--continue` never picks an untouched thread the TUI
// could not retire (it crashed or was killed).

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function dirs(): { readonly cwd: string; readonly home: string } {
  const cwd = mkdtempSync(join(canonicalTmpdir(), "agenc-prewarm-stop-cwd-"));
  const home = mkdtempSync(join(canonicalTmpdir(), "agenc-prewarm-stop-home-"));
  const previous = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.AGENC_HOME;
    else process.env.AGENC_HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, home };
}

type Activity = "untouched" | "prompted" | "shell";

/** Persist a root TUI thread the way the daemon leaves one after its stop. */
function persistThread(
  cwd: string,
  home: string,
  threadId: string,
  activity: Activity,
): string {
  const rollout = new RolloutStore({
    cwd,
    agencHome: home,
    sessionId: threadId,
    agencVersion: "0.2.0",
    sessionTempRoot: canonicalTmpdir(),
  });
  rollout.open({
    sessionId: threadId,
    timestamp: "2026-10-15T19:41:00.680Z",
    cwd,
    originator: "agenc-cli",
    source: "interactive-root",
    agencVersion: "0.2.0",
    model: "deepseek-flash",
    modelProvider: "deepseek",
  });
  const store = new FileThreadStore({ cwd, agencHome: home });
  try {
    store.createThread({ threadId, rolloutStore: rollout, source: "cli_main", cwd });
    let seq = 0;
    const event = (msg: Record<string, unknown>): void => {
      seq += 1;
      rollout.appendRollout({
        type: "event_msg",
        payload: { id: `event-${seq}`, eventId: `event:${seq}`, seq, msg },
      } as never);
    };
    // What an untouched provisioned session records: bookkeeping only.
    event({ type: "session_usage", payload: {} });
    event({ type: "session_configured", payload: { sessionId: threadId } });
    if (activity === "prompted") {
      event({
        type: "message_submission",
        payload: { contentFingerprint: "x", messageId: "m-1", streamId: "s-1", acceptedAt: "2026-10-15T19:41:02.000Z" },
      });
      event({ type: "user_message", payload: { message: "fix the tests" } });
    }
    if (activity === "shell") {
      event({
        type: "message_submission",
        payload: { contentFingerprint: "y", messageId: "shell-1", streamId: "session.shell.execute", acceptedAt: "2026-10-15T19:41:02.000Z" },
      });
    }
    event({ type: "run_terminal", payload: { status: "stopped" } });
    rollout.flushDurable();
    store.shutdownThread(threadId);
    return rollout.rolloutPath;
  } finally {
    store.close();
    rollout.close();
  }
}

async function listedSessionIds(cwd: string, home: string): Promise<string[]> {
  // A fresh store and session manager: what a restarted daemon lists.
  const store = new FileThreadStore({ cwd, agencHome: home });
  try {
    const sessions = new AgenCDaemonSessionManager({ threadStore: store });
    const page = await sessions.listSessions();
    return page.sessions.map(({ sessionId }) => sessionId);
  } finally {
    store.close();
  }
}

async function stopWith(
  cwd: string,
  home: string,
  agentId: string,
  reason: string,
): Promise<unknown> {
  const store = new FileThreadStore({ cwd, agencHome: home });
  try {
    const sessions = new AgenCDaemonSessionManager({ threadStore: store });
    const agents = new AgenCDaemonAgentManager({ threadStore: store, sessionManager: sessions });
    return await agents.stopAgent({ agentId, reason }).catch((error: unknown) => error);
  } finally {
    store.close();
  }
}

describe("stopping an unused TUI prewarm session", () => {
  it("archives the untouched thread so no list or --continue finds it after a restart", async () => {
    const { cwd, home } = dirs();
    const rolloutPath = persistThread(cwd, home, "conv-prewarmed", "untouched");
    expect(await listedSessionIds(cwd, home)).toContain("conv-prewarmed");
    // --continue already passes over an untouched thread.
    expect(resolveLatestSessionId(cwd, home)).toEqual({ kind: "none" });

    await expect(
      stopWith(cwd, home, "conv-prewarmed", UNUSED_TUI_PREWARM_STOP_REASON),
    ).resolves.toEqual({ agentId: "conv-prewarmed", stopped: false });

    expect(await listedSessionIds(cwd, home)).not.toContain("conv-prewarmed");
    expect(resolveLatestSessionId(cwd, home)).toEqual({ kind: "none" });
    expect(existsSync(rolloutPath)).toBe(false);
    expect(existsSync(dirname(rolloutPath))).toBe(false);
  });

  it("continues the newest used thread when a newer one was left untouched", () => {
    const { cwd, home } = dirs();
    persistThread(cwd, home, "conv-used", "prompted");
    const untouched = persistThread(cwd, home, "conv-left", "untouched");
    const later = new Date(Date.now() + 60_000);
    utimesSync(untouched, later, later);

    expect(resolveLatestSessionId(cwd, home)).toMatchObject({ kind: "ok", sessionId: "conv-used" });
  });

  it("keeps a thread that received a prompt", async () => {
    const { cwd, home } = dirs();
    persistThread(cwd, home, "conv-prompted", "prompted");

    await stopWith(cwd, home, "conv-prompted", UNUSED_TUI_PREWARM_STOP_REASON);

    expect(await listedSessionIds(cwd, home)).toContain("conv-prompted");
    expect(resolveLatestSessionId(cwd, home)).toMatchObject({ kind: "ok", sessionId: "conv-prompted" });
  });

  it("keeps a thread that ran a shell command", async () => {
    const { cwd, home } = dirs();
    persistThread(cwd, home, "conv-shell", "shell");

    await stopWith(cwd, home, "conv-shell", UNUSED_TUI_PREWARM_STOP_REASON);

    expect(await listedSessionIds(cwd, home)).toContain("conv-shell");
  });

  it("leaves every other stop reason as it was", async () => {
    const { cwd, home } = dirs();
    persistThread(cwd, home, "conv-closed", "untouched");

    await stopWith(cwd, home, "conv-closed", "tui_closed_before_submit");

    expect(await listedSessionIds(cwd, home)).toContain("conv-closed");
  });

  it("stops a live agent first, then archives its untouched thread", async () => {
    const { cwd, home } = dirs();
    persistThread(cwd, home, "conv-live", "untouched");
    const store = new FileThreadStore({ cwd, agencHome: home });
    cleanups.push(() => store.close());
    const sessions = new AgenCDaemonSessionManager({ threadStore: store });
    const stopAgent = vi.fn(async () => {});
    const agents = new AgenCDaemonAgentManager({
      threadStore: store,
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "conv-live",
          startedAt: "2026-10-15T19:41:01.000Z",
          status: "running",
        }),
        stopAgent,
      },
    });
    await agents.createAgent({
      cwd,
      objective: "Interactive session",
      runtimeOptions: resolveAgentRuntimeOptions({
        simpleMode: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        nonInteractive: false,
        stdinDataMode: false,
        remoteMode: false,
      } as never),
    } as never);

    await expect(
      agents.stopAgent({ agentId: "conv-live", reason: UNUSED_TUI_PREWARM_STOP_REASON }),
    ).resolves.toEqual({ agentId: "conv-live", stopped: true });

    expect(stopAgent).toHaveBeenCalledWith("conv-live", UNUSED_TUI_PREWARM_STOP_REASON);
    expect(await listedSessionIds(cwd, home)).not.toContain("conv-live");
  });

  it("reads only provably untouched rollouts as untouched", () => {
    const { cwd, home } = dirs();
    expect(canonicalRolloutHoldsNoInput(persistThread(cwd, home, "conv-a", "untouched"))).toBe(true);
    expect(canonicalRolloutHoldsNoInput(persistThread(cwd, home, "conv-b", "prompted"))).toBe(false);
    expect(canonicalRolloutHoldsNoInput(persistThread(cwd, home, "conv-c", "shell"))).toBe(false);
    expect(canonicalRolloutHoldsNoInput(join(cwd, "missing.jsonl"))).toBe(false);
  });
});
