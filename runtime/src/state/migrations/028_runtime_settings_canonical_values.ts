import type { SqlMigration } from "./types.js";

export const RUNTIME_SETTINGS_CANONICAL_VALUES_SCHEMA_VERSION = 28;

/**
 * Retire persisted config-value aliases from durable run settings. Historical
 * rows are canonicalized before the table is rebuilt with exact checks, so a
 * resumed run cannot reintroduce values rejected by schema-v2.
 */
export const runtimeSettingsCanonicalValuesMigration: SqlMigration = {
  version: RUNTIME_SETTINGS_CANONICAL_VALUES_SCHEMA_VERSION,
  name: "runtime_settings_canonical_values",
  apply(db) {
    const table = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'run_runtime_settings'`,
    ).get();
    if (table === undefined) return;

    db.exec(`
      ALTER TABLE run_runtime_settings
      RENAME TO run_runtime_settings_retired_values;

      CREATE TABLE run_runtime_settings (
        run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        settings_event_id TEXT NOT NULL,
        settings_sequence INTEGER NOT NULL,
        previous_settings_event_id TEXT,
        rollback_of_settings_event_id TEXT,
        reason TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        pre_plan_mode TEXT,
        auto_mode_active INTEGER NOT NULL,
        bypass_permissions_workspace TEXT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile TEXT,
        reasoning_effort TEXT,
        model_verbosity TEXT,
        service_tier TEXT,
        hooks_disabled INTEGER NOT NULL,
        PRIMARY KEY (run_id, settings_event_id),
        FOREIGN KEY (run_id, epoch)
          REFERENCES run_lifecycle_epochs(run_id, epoch) ON DELETE RESTRICT,
        CHECK (length(run_id) > 0),
        CHECK (epoch > 0),
        CHECK (length(settings_event_id) > 0),
        CHECK (settings_sequence > 0),
        CHECK (previous_settings_event_id IS NULL OR length(previous_settings_event_id) > 0),
        CHECK (rollback_of_settings_event_id IS NULL OR length(rollback_of_settings_event_id) > 0),
        CHECK (reason IN ('initial', 'permission_mode_changed', 'model_provider_changed', 'config_applied', 'hooks_changed', 'compensating_rollback')),
        CHECK (length(changed_at) > 0),
        CHECK (permission_mode IN ('default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'unattended')),
        CHECK (pre_plan_mode IS NULL OR pre_plan_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto', 'unattended')),
        CHECK ((permission_mode = 'plan' AND pre_plan_mode IS NOT NULL) OR (permission_mode <> 'plan' AND pre_plan_mode IS NULL)),
        CHECK (auto_mode_active IN (0, 1)),
        CHECK ((permission_mode = 'auto' AND auto_mode_active = 1) OR permission_mode = 'plan' OR (permission_mode NOT IN ('auto', 'plan') AND auto_mode_active = 0)),
        CHECK (((permission_mode = 'bypassPermissions' OR pre_plan_mode = 'bypassPermissions') AND bypass_permissions_workspace IS NOT NULL AND length(bypass_permissions_workspace) > 0) OR ((permission_mode <> 'bypassPermissions' AND (pre_plan_mode IS NULL OR pre_plan_mode <> 'bypassPermissions')) AND bypass_permissions_workspace IS NULL)),
        CHECK (length(trim(model)) > 0 AND length(model) <= 1024),
        CHECK (length(trim(provider)) > 0 AND length(provider) <= 256),
        CHECK (profile IS NULL OR (length(trim(profile)) > 0 AND length(profile) <= 256)),
        CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'none')),
        CHECK (model_verbosity IS NULL OR model_verbosity IN ('low', 'medium', 'high')),
        CHECK (service_tier IS NULL OR service_tier IN ('priority', 'flex')),
        CHECK (hooks_disabled IN (0, 1)),
        CHECK ((reason = 'initial' AND previous_settings_event_id IS NULL AND rollback_of_settings_event_id IS NULL) OR reason <> 'initial'),
        CHECK ((reason = 'compensating_rollback' AND rollback_of_settings_event_id IS NOT NULL) OR (reason <> 'compensating_rollback' AND rollback_of_settings_event_id IS NULL))
      );

      INSERT INTO run_runtime_settings (
        run_id, epoch, settings_event_id, settings_sequence,
        previous_settings_event_id, rollback_of_settings_event_id, reason,
        changed_at, permission_mode, pre_plan_mode, auto_mode_active,
        bypass_permissions_workspace, model, provider, profile,
        reasoning_effort, model_verbosity, service_tier, hooks_disabled
      )
      SELECT
        run_id, epoch, settings_event_id, settings_sequence,
        previous_settings_event_id, rollback_of_settings_event_id, reason,
        changed_at, permission_mode, pre_plan_mode, auto_mode_active,
        bypass_permissions_workspace, model, provider, profile,
        CASE reasoning_effort WHEN 'minimal' THEN 'low' ELSE reasoning_effort END,
        model_verbosity,
        CASE service_tier WHEN 'fast' THEN 'priority' ELSE service_tier END,
        hooks_disabled
      FROM run_runtime_settings_retired_values;

      DROP TABLE run_runtime_settings_retired_values;

      CREATE UNIQUE INDEX idx_run_runtime_settings_sequence
        ON run_runtime_settings(run_id, settings_sequence);

      CREATE INDEX idx_run_runtime_settings_current
        ON run_runtime_settings(run_id, epoch DESC, settings_sequence DESC);
    `);
  },
};
