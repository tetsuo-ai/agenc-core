/**
 * Ports the donor migration-directory registry shape onto AgenC's SQLite
 * schema migrations.
 *
 * Why this lives here:
 *   - ST-06 splits the previous flat migration list into versioned files while
 *     preserving the migration contract consumed by the SQLite driver.
 *
 * Related non-SQL config/settings migrations live in
 * `config-migrations.ts`; they are kept out of the SQLite registry so config
 * loading does not pull in database dependencies.
 */

import type { SqliteDatabase } from "../sqlite-driver.js";

export interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql?: string;
  readonly apply?: (db: SqliteDatabase) => void;
}
