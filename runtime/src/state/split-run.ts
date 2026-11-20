/**
 * Rows of one run in more than one project database.
 *
 * A resume that found a chat's project again from its folder, and got another
 * project (a root marker above it came or went, or the daemon ran with another
 * HOME), wrote the run's new epoch, journal binding and admission records into
 * that project's database while it kept appending to its rollout in the first
 * one. Two chats can also share one run id. Run inspection refuses both with
 * RUN_ID_AMBIGUOUS; this module tells them apart for the refusal's reason.
 */
import { basename, dirname, join, resolve } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import type { StateDatabasePaths } from "./database-paths.js";
import { openSqliteDatabase } from "./sqlite-engine.js";

const MAX_RUN_JOURNAL_BINDINGS = 32;

/**
 * How many of these databases hold a journal of the run in their own
 * project: every journal binding of the run there names a rollout in that
 * project's own sessions folder. More than one is two chats with one run id,
 * not a split.
 */
export function countRunJournalHomes(
  canonicalMatches: readonly { readonly paths: StateDatabasePaths }[],
  runId: string,
): number {
  return canonicalMatches.filter((match) => withReadonlyStateDatabase(match.paths, (db) =>
    holdsOwnRunJournal(db, match.paths, runId),
  )).length;
}

function holdsOwnRunJournal(
  db: BetterSqlite3.Database,
  paths: StateDatabasePaths,
  runId: string,
): boolean {
  if (!tableExists(db, "run_journal_bindings")) return false;
  const rows = db.prepare<[string], { session_id: string; source_path: string }>(
    `SELECT session_id, source_path FROM run_journal_bindings
     WHERE run_id = ? LIMIT ${MAX_RUN_JOURNAL_BINDINGS + 1}`,
  ).all(runId);
  if (rows.length === 0 || rows.length > MAX_RUN_JOURNAL_BINDINGS) return false;
  return rows.every((row) => isRolloutInProject(row.source_path, row.session_id, paths.projectDir));
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
