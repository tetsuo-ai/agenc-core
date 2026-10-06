import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { STATE_DB_MIGRATIONS } from "../../src/state/migrations/index.js";
import { applyMigrations } from "../../src/state/sqlite-driver.js";

it("widens Goal pause reasons without losing old suspension rows or weakening their constraints", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    applyMigrations(db, STATE_DB_MIGRATIONS.filter((migration) => migration.version <= 36));
    db.exec(`
      INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at) VALUES
        ('paused', 1, '2026-09-29T00:00:00Z'), ('resumed', 1, '2026-09-29T00:00:00Z'),
        ('new-goal', 1, '2026-09-29T00:00:00Z');
      INSERT INTO run_suspensions (run_id, epoch, suspension_event_id, suspension_sequence, reason, suspended_at)
        VALUES ('paused', 1, 'pause-old', 1, 'daemon_shutdown_idle', '2026-09-29T00:01:00Z');
      INSERT INTO run_suspensions (run_id, epoch, suspension_event_id, suspension_sequence, reason, suspended_at,
        resume_event_id, resume_sequence, resume_reason, resumed_at, activation_event_id, activation_sequence, activated_at)
        VALUES ('resumed', 1, 'pause-resumed', 2, 'daemon_shutdown_idle', '2026-09-29T00:01:00Z',
          'resume-old', 3, 'explicit_continue', '2026-09-29T00:02:00Z', 'activate-old', 4, '2026-09-29T00:03:00Z');
    `);
    const rows = db.prepare("SELECT * FROM run_suspensions ORDER BY run_id").all();
    const settingsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'run_runtime_settings'").get();
    applyMigrations(db, STATE_DB_MIGRATIONS);
    applyMigrations(db, STATE_DB_MIGRATIONS);
    expect(db.prepare("SELECT * FROM run_suspensions ORDER BY run_id").all()).toEqual(rows);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'run_runtime_settings'").get()).toEqual(settingsSchema);
    db.exec(`INSERT INTO run_suspensions
      (run_id, epoch, suspension_event_id, suspension_sequence, reason, suspended_at)
      VALUES ('new-goal', 1, 'goal-pause', 1, 'workflow_user_pause', '2026-09-29T00:01:00Z')`);
    expect(() => db.exec(`INSERT INTO run_suspensions
      (run_id, epoch, suspension_event_id, suspension_sequence, reason, suspended_at)
      VALUES ('new-goal', 1, 'duplicate-active', 2, 'workflow_user_pause', '2026-09-29T00:02:00Z')`))
      .toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE run_suspensions SET reason = 'invented' WHERE run_id = 'new-goal'"))
      .toThrow(/CHECK/);
    expect(() => db.exec("UPDATE run_suspensions SET epoch = 2 WHERE run_id = 'new-goal'"))
      .toThrow(/FOREIGN KEY/);
    expect(() => db.exec(`UPDATE run_suspensions SET resume_event_id = 'goal-resume', resume_sequence = 1,
      resume_reason = 'workflow_user_resume', resumed_at = '2026-09-29T00:02:00Z' WHERE run_id = 'new-goal'`))
      .toThrow(/CHECK/);
    db.exec(`UPDATE run_suspensions SET resume_event_id = 'goal-resume', resume_sequence = 2,
      resume_reason = 'workflow_user_resume', resumed_at = '2026-09-29T00:02:00Z' WHERE run_id = 'new-goal'`);
    expect(db.prepare("SELECT reason, resume_reason FROM run_suspensions WHERE run_id = 'new-goal'").get())
      .toEqual({ reason: "workflow_user_pause", resume_reason: "workflow_user_resume" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_run_suspensions_%'").all())
      .toHaveLength(4);
  } finally {
    db.close();
  }
});
