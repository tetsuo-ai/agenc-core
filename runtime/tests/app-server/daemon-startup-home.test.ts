import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { seedDaemonStartupHome } from "../../scripts/fixtures/daemon-startup-home.js";

it("generates real project databases with the requested session and snapshot counts", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-startup-fixture-"));
  try {
    const fixture = seedDaemonStartupHome(root, { sessions: 193, snapshots: 678, bytes: 190_000, projects: 6 });
    let active = 0;
    let closed = 0;
    let snapshots = 0;
    let bindings = 0;
    for (const { path, bytes } of fixture.databases) {
      expect(bytes).toBeGreaterThan(0);
      const db = new Database(path, { readonly: true });
      try {
        const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
        active += count("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'");
        closed += count("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'completed'");
        snapshots += count("SELECT COUNT(*) AS n FROM session_state_snapshots");
        bindings += count("SELECT COUNT(*) AS n FROM run_journal_bindings");
      } finally { db.close(); }
    }
    expect({ active, closed, snapshots, bindings }).toEqual({ active: 193, closed: 1, snapshots: 678, bindings: 193 });
    expect(fixture.databases).toHaveLength(6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
