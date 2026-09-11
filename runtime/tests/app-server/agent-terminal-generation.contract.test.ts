import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

const timestamp = "2026-09-11T00:00:00.000Z";

describe("runner terminal generation authority", () => {
  it.each(["current first", "current last"] as const)(
    "retains the current terminal while create is unpublished: %s", async (order) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const agents = new AgenCDaemonAgentManager({ runner: {
        startAgent: async () => {
          entered.resolve();
          await release.promise;
          return { agentId: "agent", runtimeGenerationId: "current", startedAt: timestamp, status: "running" };
        },
      } });
      const creating = agents.createAgent({
        objective: "new runtime", cwd: process.cwd(), runtimeOptions: resolveAgentRuntimeOptions({}), envOverrides: {},
      });
      await entered.promise;
      const current = { status: "stopped" as const, lastActiveAt: timestamp, runtimeGenerationId: "current" };
      const old = { status: "error" as const, lastActiveAt: timestamp, runtimeGenerationId: "old" };
      try {
        for (const snapshot of order === "current first" ? [current, old] : [old, current]) {
          await agents.handleRunnerTerminated("agent", snapshot);
        }
      } finally {
        release.resolve();
      }
      expect(await creating).toMatchObject({ status: "stopped" });
      expect(await agents.getAgent("agent")).toMatchObject({ status: "stopped" });
    },
  );

  it("does not project an old terminal status after its persistence wait crosses a cold resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-terminal-generation-"));
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let terminal: Promise<void> | undefined;
    try {
      const agentId = "conv-terminal-generation";
      const rollout = new RolloutStore({ cwd, agencHome: home, sessionId: agentId, agencVersion: "0.2.0", sessionTempRoot: tmpdir() });
      rollout.open({
        sessionId: agentId, timestamp, cwd, originator: "agenc-cli", source: "interactive-root",
        agencVersion: "0.2.0", model: "grok-4", modelProvider: "grok",
      });
      rollout.appendRollout({ type: "response_item", payload: { role: "user", content: "continue work" } });
      const result = {
        runId: agentId, status: "completed" as const, exitCode: 0, stopReason: "turn_completed",
        finalMessage: "done", usage: null, lastSequence: 1, finishedAt: timestamp,
      };
      const eventId = `run-terminal:${agentId}:1`;
      rollout.append({
        id: eventId, eventId, seq: 1, msg: { type: "run_terminal", payload: {
          ...result, epoch: 1, lastSequenceBeforeTerminal: null,
        } },
      }, { durable: true });
      const rolloutPath = rollout.rolloutPath;
      rollout.close();
      const stat = lstatSync(rolloutPath, { bigint: true });
      const cwdStat = lstatSync(cwd, { bigint: true });
      const sessions = new AgenCDaemonSessionManager();
      const oldSession = await sessions.createSession({ agentId, cwd });
      const recordAgentStatusTransition = vi.fn();
      const agents = new AgenCDaemonAgentManager({
        agencHome: home, sessionManager: sessions, recordAgentStatusTransition,
        runner: { startAgent: vi.fn(), restoreAgent: async () => true },
        recordRunTerminal: async () => { entered.resolve(); await release.promise; },
      });
      await agents.restoreAgent({
        agentId, objective: "old runtime", runtimeAvailable: true, createdAt: timestamp,
        sessionIds: [oldSession.sessionId], restoreAttemptId: "old-generation",
      });
      terminal = agents.handleRunnerTerminated(agentId, {
        status: "stopped", lastActiveAt: timestamp, runtimeGenerationId: "old-generation",
        terminal: { openedAt: timestamp, epoch: 1, eventId, rolloutPath, result },
      });
      await entered.promise;
      const resumed = await agents.createAgent({
        cwd, resumeSessionId: agentId, resumeRolloutPath: rolloutPath,
        runtimeOptions: resolveAgentRuntimeOptions({}), envOverrides: {},
        resumeSourceProof: {
          dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
          sha256: createHash("sha256").update(readFileSync(rolloutPath)).digest("hex"),
          cwdDev: cwdStat.dev.toString(), cwdIno: cwdStat.ino.toString(),
        },
      });
      recordAgentStatusTransition.mockClear();
      release.resolve();
      await terminal;
      expect(recordAgentStatusTransition).not.toHaveBeenCalled();
      expect(await agents.getAgent(agentId)).toMatchObject({
        status: "running", activeSessionIds: resumed.activeSessionIds,
      });
    } finally {
      release.resolve();
      await terminal;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a delayed terminal callback after an unpublished restore is replaced", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const firstSession = await sessions.createSession({ agentId: "agent", cwd: process.cwd() });
    const replacementSession = await sessions.createSession({ agentId: "agent", cwd: process.cwd() });
    const releaseTerminal = Promise.withResolvers<void>();
    const recordAgentStatusTransition = vi.fn();
    let failPublication = true;
    const agents = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      recordAgentStatusTransition,
      runner: {
        startAgent: vi.fn(),
        attachAgentSessionEvents: async () => {
          if (failPublication) throw new Error("publication failed");
        },
      },
    });
    await expect(agents.restoreAgent({
      agentId: "agent", objective: "first", runtimeAvailable: true,
      sessionIds: [firstSession.sessionId], restoreAttemptId: "first-generation",
    })).rejects.toThrow("publication failed");
    const oldSnapshot = {
      status: "stopped" as const, lastActiveAt: timestamp,
      runtimeGenerationId: "first-generation",
    };
    const delayedTerminal = releaseTerminal.promise.then(() =>
      agents.handleRunnerTerminated("agent", oldSnapshot));
    await agents.rollbackRestoredAgentRecord("agent", "first-generation");
    failPublication = false;
    await agents.restoreAgent({
      agentId: "agent", objective: "replacement", runtimeAvailable: true,
      sessionIds: [replacementSession.sessionId], restoreAttemptId: "replacement-generation",
    });
    releaseTerminal.resolve();
    await delayedTerminal;

    expect(await agents.getAgent("agent")).toMatchObject({
      objective: "replacement", status: "running",
      activeSessionIds: [replacementSession.sessionId],
    });
    expect(await sessions.getSession(replacementSession.sessionId)).toMatchObject({ status: "idle" });
    expect(recordAgentStatusTransition).not.toHaveBeenCalled();

    const currentSnapshot = {
      ...oldSnapshot, runtimeGenerationId: "replacement-generation",
    };
    await agents.handleRunnerTerminated("agent", currentSnapshot);
    expect(await agents.getAgent("agent")).toMatchObject({ status: "stopped" });
    expect(await sessions.getSession(replacementSession.sessionId)).toMatchObject({ status: "closed" });
  });
});
