import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentRunSnapshot,
} from "../../src/app-server/agent-lifecycle.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { rolloutProjectDir } from "../../src/session/rollout-project.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

/**
 * The daemon writes a session's agent run, its lifecycle epoch and its
 * terminal result into the state database its snapshot route names. A route
 * with only the folder made the daemon find the project again from the
 * folder, with the default root markers. The session's own journal lives in
 * the project that holds its rollout, which the session found with its own
 * markers (`project_root_markers` in config). When the two differed, the run
 * had state in two databases from its first turn, and `run.status` and
 * `run.replay` refused it with RUN_ID_AMBIGUOUS.
 */
describe("the project a daemon session's run is recorded in", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("is the project that holds the session's rollout, not the one found from its folder", async () => {
    const home = mkdtempSync(join(canonicalTmpdir(), "agenc-run-project-home-"));
    const cwd = mkdtempSync(join(canonicalTmpdir(), "agenc-run-project-cwd-"));
    cleanups.push(home, cwd);
    const rolloutProject = join(home, "projects", "v2-the-session-project");
    const rolloutPath = join(rolloutProject, "sessions", "conv-run-project",
      "rollout-2026-11-19T00-00-00-000Z-conv-run-project.jsonl");
    mkdirSync(join(rolloutProject, "sessions", "conv-run-project"), { recursive: true });
    const runs: AgenCDaemonAgentRunSnapshot[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => ({
        agentId: "conv-run-project",
        startedAt: "2026-11-19T00:00:00.500Z",
        status: "running",
        rolloutPath,
      }),
      stopAgent: async () => {},
    };
    const agents = new AgenCDaemonAgentManager({
      agencHome: home,
      now: () => "2026-11-19T00:00:00.000Z",
      sessionManager: new AgenCDaemonSessionManager({
        createSessionId: () => "session_run_project",
        now: () => "2026-11-19T00:00:01.000Z",
      }),
      runner,
      recordAgentRun: (run) => {
        runs.push(run);
      },
    });

    await agents.createAgent({
      objective: "Interactive session",
      cwd,
      runtimeOptions: resolveAgentRuntimeOptions({}),
    });

    expect(runs.at(-1)).toMatchObject({ id: "conv-run-project", stateProjectDir: rolloutProject });
  });

  it("is only ever a project directory under the daemon's own home", () => {
    const home = mkdtempSync(join(canonicalTmpdir(), "agenc-run-project-home-"));
    cleanups.push(home);
    const project = join(home, "projects", "v2-p");
    expect(rolloutProjectDir(join(project, "sessions", "c", "rollout-1-c.jsonl"), home)).toBe(project);
    expect(rolloutProjectDir(join(project, "archived_sessions", "c", "rollout-1-c.jsonl"), home)).toBeUndefined();
    expect(rolloutProjectDir(join(project, "sessions", "c", "notes.jsonl"), home)).toBeUndefined();
    expect(rolloutProjectDir(join(home, "elsewhere", "v2-p", "sessions", "c", "rollout-1-c.jsonl"), home))
      .toBeUndefined();
  });
});
