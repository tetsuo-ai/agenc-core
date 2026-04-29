import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ResumableSession } from "../session/session-store.js";
import { StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

export function listIndexedResumableSessions(
  projectDir: string,
): ResumableSession[] {
  const driver = new StateSqliteDriver({
    projectDir,
    stateDbPath: join(projectDir, "agenc-state_1.sqlite"),
    logsDbPath: join(projectDir, "agenc-logs_1.sqlite"),
  });
  try {
    const threads = new StateThreadRepository(driver)
      .listThreads()
      .filter((thread) => thread.archivedAt === undefined)
      .filter((thread) => thread.rolloutPath !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const result: ResumableSession[] = [];
    for (const thread of threads) {
      const rolloutPath = thread.rolloutPath;
      if (rolloutPath === undefined) continue;
      let fileSize = 0;
      let lastModified = Date.parse(thread.updatedAt);
      try {
        const stat = statSync(rolloutPath);
        fileSize = stat.size;
        lastModified = stat.mtimeMs;
      } catch {
        if (!Number.isFinite(lastModified)) continue;
      }
      result.push({
        sessionId: thread.threadId,
        rolloutPath,
        indexPath: join(projectDir, "sessions", thread.threadId, "index.json"),
        lastModified,
        fileSize,
        summary: thread.name ?? basename(rolloutPath),
      });
    }
    return result;
  } finally {
    driver.close();
  }
}
