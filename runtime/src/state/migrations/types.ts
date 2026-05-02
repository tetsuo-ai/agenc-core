/**
 * Ports the donor migration-directory registry shape onto AgenC's SQLite
 * schema migrations.
 *
 * Why this lives here:
 *   - ST-06 splits the previous flat migration list into versioned files while
 *     preserving the migration contract consumed by the SQLite driver.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Donor user-config/model migrations are unrelated to AgenC state DB
 *     schema migration and are not ported.
 */

export interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
