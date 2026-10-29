import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { ROLLOUT_SCHEMA_VERSION } from "../../src/session/event-log.js";

/** Synthetic payloads only. The caller owns an empty, isolated home. */
export function seedDaemonStartupHome(root: string, options: {
  readonly sessions?: number;
  readonly snapshots?: number;
  readonly bytes?: number;
  readonly projects?: number;
  readonly projectBytes?: readonly number[];
} = {}) {
  const sessions = options.sessions ?? 193;
  const snapshots = options.snapshots ?? 678;
  const bytes = options.bytes ?? 1_900_000_000;
  const projects = options.projects ?? 6;
  if (![sessions, snapshots, bytes, projects].every(value => Number.isSafeInteger(value) && value > 0) ||
      sessions < projects || snapshots < sessions) {
    throw new TypeError("fixture needs positive integer sizes, at least one session per project, and at least one snapshot per session");
  }
  const agencHome = join(root, "agenc");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(agencHome, { recursive: true });
  const timestamp = new Date().toISOString();
  const databases: { path: string; bytes: number }[] = [];
  const workspaces: string[] = [];
  for (let project = 0; project < projects; project++) {
    const cwd = join(root, `workspace-${project}`);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    workspaces.push(cwd);
    const driver = openStateDatabases({ cwd, agencHome });
    try {
      const count = Math.floor(sessions / projects) + (project < sessions % projects ? 1 : 0);
      const rowCount = Math.floor(snapshots / projects) + (project < snapshots % projects ? 1 : 0);
      const projectBytes = options.projectBytes?.[project] ?? (projects === 1 ? bytes : project === 0 ? bytes * (1.28 / 1.9) : bytes * (0.62 / 1.9) / (projects - 1));
      const conversation = JSON.stringify([{ role: "assistant", content: "x".repeat(Math.max(1, Math.floor(projectBytes / rowCount) - 40)) }]);
      driver.transaction(() => {
        for (let index = 0; index < count; index++) {
          const id = `startup-${project}-${index}`;
          driver.prepareState(`INSERT INTO agent_runs (id, objective, status, started_at, last_active_at, current_session_id, metadata_json)
            VALUES (?, 'synthetic recovery', 'running', ?, ?, ?, ?)`)
            .run(id, timestamp, timestamp, id, JSON.stringify({ agentPath: "/root" }));
          const sessionDir = join(driver.projectDir, "sessions", id);
          mkdirSync(sessionDir, { recursive: true });
          const rolloutPath = join(sessionDir, `rollout-${id}.jsonl`);
          writeFileSync(rolloutPath, JSON.stringify({ type: "session_meta", payload: {
            sessionId: id, timestamp, cwd, originator: "agenc-cli", source: "interactive-root",
            agencVersion: "0.19.15", rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
            model: "synthetic", modelProvider: "xai",
          } }) + "\n", { mode: 0o600 });
          const runs = new StateRunDurabilityRepository(driver);
          runs.ensureInitialEpoch({ runId: id, openedAt: timestamp });
          runs.bindJournalSource({ runId: id, epoch: 1, childRunId: id, sessionId: id, sourcePath: rolloutPath, boundAt: timestamp });
        }
        for (let index = 0; index < rowCount; index++) {
          driver.prepareState(`INSERT INTO session_state_snapshots VALUES (?, ?, ?, '{}', '{}')`)
            .run(`startup-${project}-${index % count}`, new Date(Date.parse(timestamp) + Math.floor(index / count)).toISOString(), conversation);
        }
        if (project === 0) driver.prepareState(`INSERT INTO agent_runs (id, objective, status, started_at, last_active_at)
          VALUES ('closed-run', 'finished', 'completed', ?, ?)`).run(timestamp, timestamp);
      });
    } finally {
      driver.close();
    }
    databases.push({ path: driver.stateDbPath, bytes: statSync(driver.stateDbPath).size });
  }
  return { agencHome, userHome, workspaces, sessions, snapshots, databases };
}
