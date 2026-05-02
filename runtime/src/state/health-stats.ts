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
  readonly #paths: StateDatabasePaths;

  constructor(paths: StateDatabasePaths) {
    this.#paths = paths;
  }

  readStateStats(): HealthStateStats {
    if (
      !existsSync(this.#paths.stateDbPath) ||
      !existsSync(this.#paths.logsDbPath)
    ) {
      return emptyStats(this.#paths.projectDir);
    }
    const reader = openStateDatabasePathReader(this.#paths);
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
