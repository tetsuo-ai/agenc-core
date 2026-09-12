import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { StateThreadRepository } from "../../src/state/threads.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { FileThreadStore } from "../../src/thread-store/store.js";

it("lists canonical child ownership after restart without classifying user forks as subagents", async () => {
  const home = mkdtempSync(join(tmpdir(), "agenc-session-lineage-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: home });
  try {
    const index = new StateThreadRepository(driver);
    for (const threadId of ["parent", "child", "user-fork"]) {
      index.upsertThread({
        threadId, createdAt: "2026-09-12T12:00:00Z", updatedAt: "2026-09-12T12:00:00Z", cwd,
        ...(threadId === "user-fork" ? { forkedFromId: "parent" } : {}),
      });
    }
    // Restore a historical, already-admitted child with missing rollout source metadata.
    new ThreadSpawnEdgeRepository(driver).create({
      childThreadId: "child", parentThreadId: "parent", parentPath: "/root",
      metadata: { agentId: "child", agentPath: "/root/research", depth: 1 }, status: "closed",
    }, { admissionGate: "import" });
    for (let restart = 0; restart < 2; restart++) {
      const store = new FileThreadStore({ cwd, agencHome: home });
      try {
        const manager = new AgenCDaemonSessionManager({ threadStore: store });
        const result = await manager.listSessions({ limit: 100 });
        expect(result.sessions).toHaveLength(3);
        expect(result.sessions.find(s => s.sessionId === "child")?.metadata?.parentThreadId).toBe("parent");
        expect(result.sessions.find(s => s.sessionId === "parent")?.metadata?.parentThreadId).toBeUndefined();
        expect(result.sessions.find(s => s.sessionId === "user-fork")?.metadata?.parentThreadId).toBeUndefined();
      } finally { store.close(); }
    }
  } finally {
    driver.close();
    rmSync(home, { recursive: true, force: true });
  }
});
