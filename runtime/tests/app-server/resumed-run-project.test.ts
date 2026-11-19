/**
 * A chat resumed after a daemon restart keeps its state in the project that
 * holds its rollout, through the REAL runner over the REAL bootstrap.
 *
 * Seen on a Mac test app (Core 0.19.37 and 0.19.38) after several daemon
 * restarts: Desktop's effect review read failed with "run id <chat> has
 * conflicting or unproved journal/admission owners". The resumed chat had
 * found its project again from its folder. A root marker (.git, package.json)
 * that appeared above the folder since, or a daemon running with another HOME,
 * made that another project, so the chat's new epoch, journal binding and
 * admission records went to a second state database while its rollout and
 * earlier state stayed in the first.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import { getProjectDir } from "../../src/session/session-store.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const CONVERSATION_ID = "conv-resumed-run-project";

describe("a chat resumed after its folder's project changed", () => {
  let home = "";
  let root = "";
  let workspace = "";
  let rolloutPath = "";

  beforeEach(() => {
    home = mkdtempSync(join(canonicalTmpdir(), "agenc-resumed-project-home-"));
    root = mkdtempSync(join(canonicalTmpdir(), "agenc-resumed-project-root-"));
    // The chat's folder sits in a site folder with no root marker yet.
    workspace = join(root, "site", "app");
    mkdirSync(workspace, { recursive: true });
    const seed = new RolloutStore({ cwd: workspace, sessionId: CONVERSATION_ID, agencVersion: VERSION,
      agencHome: home, sessionTempRoot: canonicalTmpdir(), autoStartScheduler: false });
    seed.open({ sessionId: CONVERSATION_ID, timestamp: new Date().toISOString(), cwd: workspace,
      originator: "agenc-cli", source: "interactive-root", agencVersion: VERSION,
      model: "base-model", modelProvider: "grok" });
    rolloutPath = seed.rolloutPath;
    seed.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function stubProvider(): Promise<void> {
    const providerMod = await import("../../src/llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(() => ({
      name: "stub",
      getExecutionProfile: async () => ({ provider: "stub", model: "base-model",
        supportsMaxOutputTokens: true, maxOutputTokens: 8192, usageReporting: "authoritative" }),
      chat: async () => ({ content: "ok", toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    }) as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  }

  /** Every project under the home whose state database holds rows for the chat's run. */
  function projectsHoldingTheRun(): string[] {
    return discoverStateDatabasePaths(home).filter((paths) => {
      const service = new AgenCDaemonRunInspectionService({ stateDatabasePaths: () => [paths] });
      try {
        service.status({ runId: CONVERSATION_ID });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "RUN_NOT_FOUND") return false;
        throw error;
      }
    }).map((paths) => paths.projectDir);
  }

  /** Every project whose state database has the chat's thread row (the projection run.replay reads). */
  function projectsWithTheThread(): string[] {
    return discoverStateDatabasePaths(home).filter((paths) => {
      const db = new Database(paths.stateDbPath, { readonly: true, fileMustExist: true });
      try {
        return db.prepare("SELECT 1 FROM threads WHERE thread_id = ?").get(CONVERSATION_ID) !== undefined;
      } finally {
        db.close();
      }
    }).map((paths) => paths.projectDir);
  }

  it("keeps the chat in the project of its rollout when a root marker appears above its folder", async () => {
    const before = getProjectDir(workspace, undefined, home);
    expect(before).toBe(join(home, "projects", readdirSync(join(home, "projects"))[0]!));
    // `npm init` or `git init` in the site folder, between two daemon runs.
    writeFileSync(join(root, "site", "package.json"), "{\"name\":\"site\"}\n");
    const after = getProjectDir(workspace, undefined, home);
    expect(after).not.toBe(before);

    await stubProvider();
    let resumedSession: Session | undefined;
    const daemon = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: async (options) => {
        const bootstrapped = await bootstrapLocalRuntimeSession(options);
        resumedSession = bootstrapped.session;
        return bootstrapped;
      },
      env: { ...process.env, AGENC_HOME: home, AGENC_WORKSPACE: workspace, HOME: home },
    });
    try {
      // What the daemon runs for Desktop's cold resume (agent.create with
      // resumeSessionId and resumeRolloutPath) and for its startup restore.
      await expect(daemon.restoreAgent({
        agentId: CONVERSATION_ID,
        objective: "Interactive session",
        cwd: workspace,
        resumeRolloutPath: rolloutPath,
        explicitColdResume: true,
        envOverrides: { XAI_API_KEY: "test-key" },
      } as never)).resolves.toBe(true);

      // Desktop's effect review read: run.replay of the chat's run.
      const inspection = new AgenCDaemonRunInspectionService({
        agencHome: home,
        stateDatabasePaths: () => discoverStateDatabasePaths(home),
      });
      expect(() => inspection.replay({ runId: CONVERSATION_ID })).not.toThrow();
      expect(inspection.replay({ runId: CONVERSATION_ID }).source).toMatchObject({
        kind: "run_journal",
        projectDir: before,
      });
      expect(projectsHoldingTheRun()).toEqual([before]);
      expect(resumedSession?.services.executionAdmission?.scope.workspaceId).toBe(before);
      // The live thread projection, which later reads replay, stays there too.
      expect(projectsWithTheThread()).toEqual([before]);
    } finally {
      await daemon.stopAgent(CONVERSATION_ID).catch(() => undefined);
    }
  }, 60_000);
});
