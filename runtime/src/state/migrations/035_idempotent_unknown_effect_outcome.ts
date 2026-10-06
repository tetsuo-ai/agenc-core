import type { SqlMigration } from "./types.js";

/** Preserve the v17 effect schema while allowing honest forced-stop evidence. */
export const idempotentUnknownEffectOutcomeMigration: SqlMigration = {
  version: 35,
  name: "idempotent_unknown_effect_outcome",
  apply(db) {
    const table = db.prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_effects'",
    ).get();
    const oldCategoryCheck = "recovery_category IN ('side-effecting', 'interactive')";
    if (table === undefined || !table.sql.includes(oldCategoryCheck)) {
      throw new Error("run_effects has an unexpected unknown-outcome constraint");
    }
    const dependents = db.prepare<[], { sql: string }>(
      `SELECT sql FROM sqlite_master
       WHERE tbl_name = 'run_effects' AND type IN ('index', 'trigger')
         AND sql IS NOT NULL ORDER BY type, name`,
    ).all();
    const rebuilt = table.sql
      .replace("CREATE TABLE run_effects", "CREATE TABLE run_effects_v35")
      .replace(oldCategoryCheck,
        "recovery_category IN ('idempotent', 'side-effecting', 'interactive')");
    if (rebuilt === table.sql || !rebuilt.startsWith("CREATE TABLE run_effects_v35")) {
      throw new Error("run_effects cannot be rebuilt for idempotent unknown outcomes");
    }
    db.exec(rebuilt);
    db.exec("INSERT INTO run_effects_v35 SELECT * FROM run_effects");
    db.exec("DROP TABLE run_effects");
    db.exec("ALTER TABLE run_effects_v35 RENAME TO run_effects");
    for (const dependent of dependents) db.exec(dependent.sql);
  },
};
