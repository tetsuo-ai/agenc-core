/**
 * A run split across project databases by an earlier resume.
 *
 * Core before agenc-core #3609 opened a resumed chat's state database from
 * the chat's folder. When the folder named another project by then (a root
 * marker above it came or went, or the daemon ran with another HOME), the
 * resume wrote its new epoch, journal binding and admission records into
 * that project's database while it kept appending to its rollout in the
 * first one. Resumes no longer split a run; a run split before stays split.
 * Run inspection reads such a run from the project that holds its rollout,
 * and leaves the other databases' rows out.
 */
import { basename, dirname, join, resolve } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import type { StateDatabasePaths } from "./database-paths.js";
import { openSqliteDatabase } from "./sqlite-engine.js";

/** What one project database holds of a run's journal bindings. */
interface RunRolloutBindings {
  readonly paths: StateDatabasePaths;
  /** The bound rollouts, resolved; empty when there is no readable binding. */
  readonly sources: ReadonlySet<string>;
  /** Every binding names a rollout in this database's own project. */
  readonly ownProject: boolean;
  /** Every binding is the run's own journal, not a child's. */
  readonly ownRun: boolean;
  /**
   * Every epoch-scoped row of the run starts at or after its first binding.
   * A binding names the rollout an epoch was opened in; later epochs (a
   * reopened run) continue in that rollout without a binding of their own.
   */
  readonly epochsCovered: boolean;
  /** The rollouts the run's thread row names, resolved. */
  readonly threadRollouts: readonly string[];
}

const MAX_SPLIT_RUN_BINDINGS = 32;
const EPOCH_SCOPED_RUN_TABLES = [
  "run_lifecycle_epochs",
  "run_terminal_results",
  "run_effects",
  "run_suspensions",
  "run_runtime_settings",
] as const;

/**
 * The stray databases of a split run, or undefined when the run is not split
 * that way. A resume found the run's project again from its folder (a root
 * marker above it came or went, or the daemon ran with another HOME), got
 * another project, and wrote its new epoch, journal binding and admission
 * records into that project's database while it kept appending to its
 * rollout. Exactly one database must hold the run's rollout in its own
 * project; every other database's bindings, and its thread row, must name
 * that same rollout, and its epoch-scoped rows must start at or after its
 * first binding.
 */
export function splitRunStrays(
  canonicalMatches: readonly { readonly paths: StateDatabasePaths }[],
  runId: string,
): readonly StateDatabasePaths[] | undefined {
  if (canonicalMatches.length < 2) return undefined;
  const bindings = canonicalMatches.map((match) =>
    withReadonlyStateDatabase(match.paths, (db) => readRunRolloutBindings(db, match.paths, runId)),
  );
  const homes = bindings.filter((binding) => binding.sources.size > 0 && binding.ownProject);
  if (homes.length !== 1) return undefined;
  const home = homes[0]!;
  const strays = bindings.filter((binding) => binding !== home);
  const boundToHomeRollout = (stray: RunRolloutBindings): boolean =>
    stray.sources.size > 0 && stray.ownRun && stray.epochsCovered &&
    [...stray.sources, ...stray.threadRollouts].every((source) => home.sources.has(source));
  return strays.every(boundToHomeRollout) ? strays.map((stray) => stray.paths) : undefined;
}

function readRunRolloutBindings(
  db: BetterSqlite3.Database,
  paths: StateDatabasePaths,
  runId: string,
): RunRolloutBindings {
  const none = { paths, sources: new Set<string>(), ownProject: false, ownRun: false, epochsCovered: false, threadRollouts: [] };
  if (!tableExists(db, "run_journal_bindings")) return none;
  const rows = db.prepare<[string], { epoch: number; child_run_id: string; session_id: string; source_path: string }>(
    `SELECT epoch, child_run_id, session_id, source_path FROM run_journal_bindings
     WHERE run_id = ? LIMIT ${MAX_SPLIT_RUN_BINDINGS + 1}`,
  ).all(runId);
  if (rows.length === 0 || rows.length > MAX_SPLIT_RUN_BINDINGS) return none;
  const firstBoundEpoch = Math.min(...rows.map((row) => row.epoch));
  const epochsCovered = EPOCH_SCOPED_RUN_TABLES.every((table) =>
    !tableExists(db, table) || !columnExists(db, table, "epoch") ||
    (db.prepare<[string], { first: number | null }>(`SELECT MIN(epoch) AS first FROM ${table} WHERE run_id = ?`)
      .get(runId)?.first ?? firstBoundEpoch) >= firstBoundEpoch,
  );
  const thread = tableExists(db, "threads")
    ? db.prepare<[string], ThreadRolloutRow>(
        "SELECT rollout_path, archived_rollout_path FROM threads WHERE thread_id = ? LIMIT 1",
      ).get(runId)
    : undefined;
  return {
    paths,
    sources: new Set(rows.map((row) => resolve(row.source_path))),
    ownProject: rows.every((row) => isRolloutInProject(row.source_path, row.session_id, paths.projectDir)),
    ownRun: rows.every((row) => row.child_run_id === runId && row.session_id === runId),
    epochsCovered,
    threadRollouts: [thread?.rollout_path, thread?.archived_rollout_path]
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map((path) => resolve(path)),
  };
}

interface ThreadRolloutRow {
  readonly rollout_path: string | null;
  readonly archived_rollout_path: string | null;
}

/** A canonical rollout file of `sessionId` in this project's sessions or archived_sessions folder. */
function isRolloutInProject(sourcePath: string, sessionId: string, projectDir: string): boolean {
  const source = resolve(sourcePath);
  const file = basename(source);
  if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) return false;
  if (sessionId.length === 0 || basename(sessionId) !== sessionId) return false;
  const project = resolve(projectDir);
  return dirname(source) === join(project, "sessions", sessionId) ||
    dirname(source) === join(project, "archived_sessions", sessionId);
}

function withReadonlyStateDatabase<T>(
  paths: StateDatabasePaths,
  fn: (db: BetterSqlite3.Database) => T,
): T {
  const db = openSqliteDatabase(paths.stateDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 250");
    return fn(db);
  } finally {
    db.close();
  }
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(name) !== undefined
  );
}

function columnExists(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
): boolean {
  return db
    .prepare<[], { readonly name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
