import type { SqlMigration } from "./types.js";

/**
 * Authoritative daemon session-to-agent ownership for retention policies.
 */
export const sessionAgentLinksSchemaMigration: SqlMigration = {
  version: 7,
  name: "session_agent_links_schema",
  sql: `
CREATE TABLE IF NOT EXISTS session_agent_links (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_session_agent_links_agent
  ON session_agent_links(agent_id, session_id);
`,
};
