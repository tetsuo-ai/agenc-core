import { existsSync } from "node:fs";
import type { HealthStateStats } from "../app-server/protocol/index.js";
import {
  openStateDatabasePathReader,
  type StateDatabasePaths,
  type StateSqliteReader,
} from "./sqlite-driver.js";

type StateCountTable =
  | "agent_runs"
  | "session_state_snapshots"
  | "in_flight_tool_calls";

/**
 * Read-only health counter for persisted AgenC state.
 */
export class StateSqliteHealthStatsReader {
  readonly #paths: readonly StateDatabasePaths[];

  constructor(paths: StateDatabasePaths | readonly StateDatabasePaths[]) {
    this.#paths = Array.isArray(paths) ? [...paths] : [paths];
  }

  readStateStats(): HealthStateStats {
    const first = this.#paths[0];
    if (!first) return emptyStats("");
    const stats = this.#paths.map((paths) => readStateStatsForPath(paths));
    if (stats.length === 1) return stats[0] ?? emptyStats(first.projectDir);
    return {
      available: stats.some((stat) => stat.available),
      readonly: true,
      projectDir: first.projectDir,
      agentRuns: sumStats(stats, "agentRuns"),
      sessionStateSnapshots: sumStats(stats, "sessionStateSnapshots"),
      inFlightToolCalls: sumStats(stats, "inFlightToolCalls"),
      logs: sumStats(stats, "logs"),
    };
  }
}

function readStateStatsForPath(paths: StateDatabasePaths): HealthStateStats {
  if (!existsSync(paths.stateDbPath) || !existsSync(paths.logsDbPath)) {
    return emptyStats(paths.projectDir);
  }
  const reader = openStateDatabasePathReader(paths);
  try {
    return {
      available: true,
      readonly: true,
      projectDir: reader.projectDir,
      agentRuns: countRows(reader, "agent_runs"),
      sessionStateSnapshots: countRows(reader, "session_state_snapshots"),
      inFlightToolCalls: countRows(reader, "in_flight_tool_calls"),
      logs: countLogs(reader),
    };
  } finally {
    reader.close();
  }
}

function sumStats(
  stats: readonly HealthStateStats[],
  key:
    | "agentRuns"
    | "sessionStateSnapshots"
    | "inFlightToolCalls"
    | "logs",
): number {
  return stats.reduce((total, stat) => total + stat[key], 0);
}

function countRows(reader: StateSqliteReader, table: StateCountTable): number {
  return (
    reader
      .prepareState<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      )
      .get()?.count ?? 0
  );
}

function countLogs(reader: StateSqliteReader): number {
  return (
    reader
      .prepareLogs<[], { count: number }>("SELECT COUNT(*) AS count FROM logs")
      .get()?.count ?? 0
  );
}

function emptyStats(projectDir: string): HealthStateStats {
  return {
    available: false,
    readonly: true,
    projectDir,
    agentRuns: 0,
    sessionStateSnapshots: 0,
    inFlightToolCalls: 0,
    logs: 0,
  };
}
