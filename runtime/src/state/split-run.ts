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
import { existsSync, realpathSync } from "node:fs";
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
  /** Every binding names a rollout outside this database's own project. */
  readonly elsewhere: boolean;
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

/**
 * Of these run ids, those whose every journal binding in this database names
 * a rollout outside its own project. Only such a database can be a split
 * run's stray (its bindings name the rollout in the first project), so only
 * for these is {@link splitRunStrayDatabases} worth its reads. One read of
 * this database, whatever the number of runs.
 */
export function runsBoundOnlyElsewhere(
  paths: StateDatabasePaths,
  runIds: readonly string[],
): ReadonlySet<string> {
  if (runIds.length === 0 || !existsSync(paths.stateDbPath)) return new Set();
  return withReadonlyStateDatabase(paths, (db) => new Set(runIds.filter((runId) => {
    const binding = readRunRolloutBindings(db, paths, runId);
    return binding.sources.size > 0 && binding.elsewhere;
  })));
}

/**
 * The databases (by state database path) whose rows of the run the split
 * run's reader leaves out: the rule of {@link splitRunStrays} over every
 * database of `allPaths` that holds canonical state of the run. Empty when
 * the run is not split that way. It reads every database, so a caller keeps
 * the answer for the run rather than asking again.
 */
export function splitRunStrayDatabases(
  runId: string,
  allPaths: readonly StateDatabasePaths[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const canonical = allPaths.filter((candidate) => {
    if (seen.has(candidate.stateDbPath) || !existsSync(candidate.stateDbPath)) return false;
    seen.add(candidate.stateDbPath);
    return withReadonlyStateDatabase(candidate, (db) => hasCanonicalRunState(db, runId));
  });
  return new Set((splitRunStrays(canonical.map((paths) => ({ paths })), runId) ?? []).map((stray) => stray.stateDbPath));
}

/**
 * A rollout of the run in this project, by path or, when AGENC_HOME was
 * reached by another path, by real path. Never true of a split run's stray
 * row, which names the rollout in the first project, so a listing skips the
 * split rule for every row it is true of.
 */
export function isRolloutInOwnProject(rolloutPath: string, runId: string, projectDir: string): boolean {
  if (isRolloutInProject(rolloutPath, runId, projectDir)) return true;
  const real = (path: string): string | undefined => {
    try { return realpathSync(path); } catch { return undefined; }
  };
  const rollout = real(rolloutPath);
  const project = real(projectDir);
  return rollout !== undefined && project !== undefined && isRolloutInProject(rollout, runId, project);
}

/** The database holds canonical (journal) state of the run: an epoch, a terminal, an effect or a binding. */
export function hasCanonicalRunState(
  db: BetterSqlite3.Database,
  runId: string,
): boolean {
  for (const [table, column] of [
    ["run_lifecycle_epochs", "run_id"],
    ["run_terminal_results", "run_id"],
    ["run_effects", "run_id"],
    ["run_journal_bindings", "run_id"],
  ] as const) {
    if (!tableExists(db, table)) continue;
    const row = db
      .prepare<[string], { readonly present: number }>(
        `SELECT 1 AS present FROM ${table} WHERE ${column} = ? LIMIT 1`,
      )
      .get(runId);
    if (row !== undefined) return true;
  }
  return false;
}

/**
 * How many of these databases hold a journal of the run in their own
 * project, the way the database that holds a split run's rollout does. More
 * than one is two chats with one run id, not a split.
 */
export function countRunJournalHomes(
  canonicalMatches: readonly { readonly paths: StateDatabasePaths }[],
  runId: string,
): number {
  return canonicalMatches.filter((match) => withReadonlyStateDatabase(match.paths, (db) => {
    const binding = readRunRolloutBindings(db, match.paths, runId);
    return binding.sources.size > 0 && binding.ownProject;
  })).length;
}

function readRunRolloutBindings(
  db: BetterSqlite3.Database,
  paths: StateDatabasePaths,
  runId: string,
): RunRolloutBindings {
  const none = { paths, sources: new Set<string>(), ownProject: false, elsewhere: false, ownRun: false, epochsCovered: false, threadRollouts: [] };
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
    elsewhere: rows.every((row) => !isRolloutInProject(row.source_path, row.session_id, paths.projectDir)),
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
export function isRolloutInProject(sourcePath: string, sessionId: string, projectDir: string): boolean {
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
