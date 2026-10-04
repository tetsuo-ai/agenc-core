import type { SqliteDatabase } from "./sqlite-driver.js";
import { StateMigrationError } from "./errors.js";
import { STATE_DB_MIGRATIONS } from "./migrations/index.js";
import { registerCsvMigrationFunctions } from "./migrations/019_csv_job_identity_replay.js";
import { FRESH_STATE_MIGRATIONS, FRESH_STATE_SCHEMA_SQL } from "./fresh-state-schema.generated.js";

/** Called only while the driver owns its existing BEGIN IMMEDIATE reservation. */
export function tryInitializeFreshStateSchema(db: SqliteDatabase): boolean {
  if (!db.inTransaction) throw new Error("Fresh state initialization requires the state writer reservation");
  // A used, partial, unexplained or versioned database keeps the migration path.
  // Include internal schema objects: an orphan sqlite_sequence is not pristine.
  if (db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() !== undefined ||
      db.pragma("schema_version", { simple: true }) !== 0 ||
      db.pragma("user_version", { simple: true }) !== 0 ||
      db.pragma("application_id", { simple: true }) !== 0) return false;
  // Source-content commitments are checked before release bundling. Also fail
  // closed if a source-mode caller supplies a different migration registry.
  if (STATE_DB_MIGRATIONS.length !== FRESH_STATE_MIGRATIONS.length ||
      STATE_DB_MIGRATIONS.some((migration, index) =>
        migration.version !== FRESH_STATE_MIGRATIONS[index]?.version ||
        migration.name !== FRESH_STATE_MIGRATIONS[index]?.name)) return false;

  // Preserve the nested savepoint: a caught failure must leave no partial DDL
  // for an outer caller to commit. The driver's outer COMMIT remains unchanged.
  db.transaction(() => {
    try {
      registerCsvMigrationFunctions(db);
      db.exec(FRESH_STATE_SCHEMA_SQL);
    } catch (cause) {
      throw new StateMigrationError("fresh state schema initialization failed", { cause });
    }
  })();
  return true;
}
