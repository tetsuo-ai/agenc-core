/**
 * A chat split across two project databases the way Core 0.19.38 did it
 * (run-inspection.split-run.test.ts makes and explains the same split):
 * turn 1 in `site/app`, a `package.json` above the folder, then a resume
 * whose rollout store opened the database of the project found again from
 * the folder, and turn 2. The daemon's run row and the thread store's row are
 * written where the folder resolves at each point, as the daemon wrote them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, vi } from "vitest";

import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import * as sqliteDriver from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { VERSION } from "../../src/version.js";

export interface SplitChat {
  readonly runId: string;
  readonly home: string;
  readonly workspace: string;
  readonly firstProject: string;
  readonly folderProject: string;
  readonly rolloutPath: string;
}

export interface SplitChatOptions {
  readonly runId?: string;
  /** The daemon run row's status in the first project (default `suspended`, a saved session). */
  readonly firstStatus?: string;
  /** The daemon run row's status in the second project (default `suspended`). */
  readonly strayStatus?: string;
}

export async function splitChat(root: string, options: SplitChatOptions = {}): Promise<SplitChat> {
  const runId = options.runId ?? "conv-split-listed";
  const home = join(root, "agenc-home");
  const workspace = join(root, "site", "app");
  mkdirSync(workspace, { recursive: true });
  let sequence = 0;
  let rolloutPath = "";
  const storeOptions = { cwd: workspace, sessionId: runId, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false };
  const openMeta = () => ({ sessionId: runId, timestamp: new Date().toISOString(), cwd: workspace,
    originator: "agenc-cli", source: "interactive-root" as const, agencVersion: VERSION, model: "base-model",
    modelProvider: "grok" });
  const admittedModelCall = async (store: RolloutStore, inputTokens: number): Promise<void> => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "split-chat-fixture", ownerPid: process.pid });
    try {
      const client = kernel.bindClient({ cwd: workspace, scope: { runId, sessionId: runId, autonomous: false },
        budget: { runMaxCostUsd: 1 } });
      const lease = await client.acquire({ stepId: `model:${inputTokens}`, kind: "model_turn", maxInputTokens: 100,
        maxOutputTokens: 5, maxCostUsd: 0.1 });
      client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      client.reconcile(lease.reservation.reservationId, { inputTokens, outputTokens: 1, costUsd: 0.01 });
      for (const event of client.replayJournal?.() ?? []) {
        sequence += 1;
        store.append({ id: event.eventId, eventId: event.eventId, seq: sequence,
          msg: { type: "execution_admission", payload: event } }, { durable: true });
      }
    } finally {
      kernel.close();
    }
  };
  const recordRows = (sessionId: string, status: string, thread: { readonly cwd?: string }): void => {
    const driver = sqliteDriver.openStateDatabases({ cwd: workspace, agencHome: home });
    try {
      const now = new Date().toISOString();
      upsertAgentRun(driver, { id: runId, objective: "Interactive session", status, startedAt: now,
        lastActiveAt: now, currentSessionId: sessionId });
      new StateThreadRepository(driver).upsertThread({ threadId: runId, createdAt: now, updatedAt: now, rolloutPath,
        model: "base-model", modelProvider: "grok", ...thread });
    } finally {
      driver.close();
    }
  };

  const firstProject = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home }).projectDir;
  const first = new RolloutStore(storeOptions);
  first.open(openMeta());
  rolloutPath = first.rolloutPath;
  recordRows("session-1", options.firstStatus ?? "suspended", { cwd: workspace });
  await admittedModelCall(first, 10);
  first.close();

  writeFileSync(join(root, "site", "package.json"), "{\"name\":\"site\"}\n");
  const folderPaths = sqliteDriver.resolveStateDatabasePaths({ cwd: workspace, agencHome: home });
  expect(folderPaths.projectDir).not.toBe(firstProject);
  // Before agenc-core #3609 the resumed store opened `openStateDatabases({ cwd })`.
  const opened = vi.spyOn(sqliteDriver, "stateDatabasePathsForProjectDir").mockImplementationOnce(() => folderPaths);
  const resumed = new RolloutStore({ ...storeOptions, resume: true, resumeRolloutPath: rolloutPath });
  resumed.open(openMeta());
  opened.mockRestore();
  sequence = Math.max(sequence, ...resumed.readAll().flatMap((item) =>
    item.type === "event_msg" && typeof (item.payload as { seq?: unknown }).seq === "number" ? [(item.payload as { seq: number }).seq] : []));
  // The resumed chat's thread store wrote its row where the folder resolves: the rollout, no folder.
  recordRows("session-2", options.strayStatus ?? "suspended", {});
  await admittedModelCall(resumed, 20);
  resumed.close();
  return { runId, home, workspace, firstProject, folderProject: folderPaths.projectDir, rolloutPath };
}
