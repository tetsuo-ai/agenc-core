import type { SqlMigration } from "./types.js";

export const AGENT_ROLE_WORKSPACE_PROVENANCE_SCHEMA_VERSION = 12;

interface TableColumnRow {
  readonly name: string;
}

interface SpawnEdgeMetadataRow {
  readonly child_thread_id: string;
  readonly metadata_json: string;
}

interface RoleProvenance {
  readonly workspaceId?: string;
  readonly fingerprint?: string;
}

/**
 * Keep role-workspace provenance outside field-list JSON clones.
 *
 * The dedicated column is deliberately additive. A legacy upsert that omits
 * it cannot erase it, and the schema-version guard prevents an older runtime
 * from opening the migrated database silently.
 */
export const agentRoleWorkspaceProvenanceMigration: SqlMigration = {
  version: AGENT_ROLE_WORKSPACE_PROVENANCE_SCHEMA_VERSION,
  name: "agent_role_workspace_provenance",
  apply: (db) => {
    // Repair partial legacy fixtures/databases as well as migrating a healthy
    // v11 schema. In a normal database this is a no-op because v1 created it.
    db.exec(`
CREATE TABLE IF NOT EXISTS thread_spawn_edges (
  child_thread_id TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  source_thread_id TEXT,
  source_path TEXT,
  call_id TEXT,
  parent_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_role_workspace_id TEXT,
  agent_role_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_thread_spawn_edges_parent
  ON thread_spawn_edges(parent_thread_id);
`);
    const columns = db
      .prepare<[], TableColumnRow>("PRAGMA table_info(thread_spawn_edges)")
      .all();
    if (!columns.some((column) => column.name === "agent_role_workspace_id")) {
      db.exec(
        "ALTER TABLE thread_spawn_edges ADD COLUMN agent_role_workspace_id TEXT",
      );
    }
    if (!columns.some((column) => column.name === "agent_role_fingerprint")) {
      db.exec(
        "ALTER TABLE thread_spawn_edges ADD COLUMN agent_role_fingerprint TEXT",
      );
    }

    const rows = db
      .prepare<[], SpawnEdgeMetadataRow>(
        `SELECT child_thread_id, metadata_json
         FROM thread_spawn_edges
         WHERE agent_role_workspace_id IS NULL
            OR agent_role_fingerprint IS NULL`,
      )
      .all();
    const backfillWorkspace = db.prepare<[string, string]>(
      `UPDATE thread_spawn_edges
       SET agent_role_workspace_id = ?
       WHERE child_thread_id = ? AND agent_role_workspace_id IS NULL`,
    );
    const backfillFingerprint = db.prepare<[string, string]>(
      `UPDATE thread_spawn_edges
       SET agent_role_fingerprint = ?
       WHERE child_thread_id = ? AND agent_role_fingerprint IS NULL`,
    );
    for (const row of rows) {
      const provenance = roleProvenanceFromJson(row.metadata_json);
      if (provenance.workspaceId !== undefined) {
        backfillWorkspace.run(provenance.workspaceId, row.child_thread_id);
      }
      if (provenance.fingerprint !== undefined) {
        backfillFingerprint.run(provenance.fingerprint, row.child_thread_id);
      }
    }

    // Repository writes are create-only, but triggers make the immutable edge
    // identity hold even for old field-list writers or direct SQL access.
    db.exec(`
CREATE TRIGGER IF NOT EXISTS prevent_thread_spawn_edge_identity_rebind
BEFORE UPDATE OF child_thread_id, parent_thread_id, parent_path, metadata_json,
                 agent_role_workspace_id, agent_role_fingerprint
ON thread_spawn_edges
WHEN OLD.child_thread_id IS NOT NEW.child_thread_id
  OR OLD.parent_thread_id IS NOT NEW.parent_thread_id
  OR OLD.parent_path IS NOT NEW.parent_path
  OR OLD.agent_role_workspace_id IS NOT NEW.agent_role_workspace_id
  OR OLD.agent_role_fingerprint IS NOT NEW.agent_role_fingerprint
  OR json_extract(OLD.metadata_json, '$.agentId') IS NOT
     json_extract(NEW.metadata_json, '$.agentId')
  OR json_extract(OLD.metadata_json, '$.agentPath') IS NOT
     json_extract(NEW.metadata_json, '$.agentPath')
  OR json_extract(OLD.metadata_json, '$.depth') IS NOT
     json_extract(NEW.metadata_json, '$.depth')
  OR json_extract(OLD.metadata_json, '$.agentRole') IS NOT
     json_extract(NEW.metadata_json, '$.agentRole')
  OR json_extract(OLD.metadata_json, '$.agentRoleWorkspaceId') IS NOT
     json_extract(NEW.metadata_json, '$.agentRoleWorkspaceId')
  OR json_extract(OLD.metadata_json, '$.agentRoleFingerprint') IS NOT
     json_extract(NEW.metadata_json, '$.agentRoleFingerprint')
BEGIN
  SELECT RAISE(ABORT, 'thread-spawn edge identity is immutable');
END;
`);
  },
};

function roleProvenanceFromJson(value: string): RoleProvenance {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const workspaceId = record.agentRoleWorkspaceId;
    const fingerprint = record.agentRoleFingerprint;
    return {
      ...(typeof workspaceId === "string" && workspaceId.trim().length > 0
        ? { workspaceId }
        : {}),
      ...(typeof fingerprint === "string" && fingerprint.trim().length > 0
        ? { fingerprint }
        : {}),
    };
  } catch {
    return {};
  }
}
