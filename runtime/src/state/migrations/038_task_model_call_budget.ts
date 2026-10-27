import type { SqlMigration } from "./types.js";

/** Count model reservations in the same transaction as token/cost admission. */
export const taskModelCallBudgetMigration: SqlMigration = {
  version: 38,
  name: "task_model_call_budget",
  apply(db) {
    const columns = db.prepare<[], { name: string }>("PRAGMA table_info(execution_admission_allocations)").all();
    if (columns.length === 0 || columns.some(column => column.name === "max_model_calls")) return;
    db.exec("ALTER TABLE execution_admission_allocations ADD COLUMN max_model_calls INTEGER CHECK (max_model_calls IS NULL OR max_model_calls >= 0)");
  },
};
