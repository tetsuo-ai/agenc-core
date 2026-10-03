# Fresh state schema

The SQLite driver may use a generated final schema only for pristine state under
its existing `BEGIN IMMEDIATE` writer reservation. Any schema object, prior schema
version, user version or application ID retains the historical migration path.
Logs still use their independent migration runner. Existing backups, database
settings, outer commit and atomic snapshot recovery remain in the driver.

`npm run generate:fresh-state-schema` executes `applyMigrations` against an empty
database, including every custom migration function. It captures final tables,
explicit indexes, views, triggers and seed rows. SQLite creates implicit indexes
and sqlite_sequence from the table definitions. The generator does not call the
fresh path. New seed tables or unsupported values require explicit review.

Four tables have non-migration seeds: csv_storage_quota,
csv_job_supervisor_state, workflow_handoff_quota_global and
workflow_handoff_sequence. The first two keep the original SQL clock expressions;
schema_migrations uses its normal applied_at default for every version/name row.
Never publish captured timestamp values as reusable defaults.

Migration19 also leaves two deterministic SQL functions on the connection. Their
shared registration runs on the fresh path, preserving validation and identity
derivation. Other custom apply effects on a pristine database are captured in the
final DDL/seeds: conditional columns/indexes, table rebuilds, quota reconciliation,
permission/runtime-setting constraints, immutable-evidence triggers and projection
markers. Historical row backfills and reconciliation remain on the existing path.

The manifest binds the generated artifact, every migration source, its transitive
value dependencies and the generator/checker. `build-runtime.mjs` rejects drift
before bundling; it never regenerates silently. After changing a migration or one
of its dependencies, review the new effects, regenerate, inspect the SQL diff and
run the schema parity and state regression tests before committing the new pair.
Source-mode consumers also check the version/name registry, but source-content
validation is a build/test requirement; it does not read source files at startup.

The parity tests compare exact sqlite_schema text and introspected columns,
foreign keys and indexes, normalize only initialization clocks and index-list
creation order, and exercise actual effect constraints and migration functions.
Failure/reopen and concurrent-process tests protect rollback, cleanup and first
open ownership. The normal state suites cover admission, snapshots, CSV quotas,
recovery and existing upgrades/backups. None of these checks establishes a timing
improvement; measure exact built artifacts with matching cold/warm controls.
