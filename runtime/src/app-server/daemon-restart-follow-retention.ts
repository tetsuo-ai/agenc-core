import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAgenCDaemonRestartRequestId } from "./daemon-restart-outcome.js";

const FOLLOW_DIRECTORY = "daemon-restart-follows";

/**
 * Register before handing the restart to another process. A suspended TUI is
 * still alive, so its result stays retained without a heartbeat or wall clock.
 * The follow owns the release function until it stops or relaunches.
 */
export function retainAgenCDaemonRestartFollow(daemonHome: string, requestId: string): () => void {
  if (!isAgenCDaemonRestartRequestId(requestId)) throw new Error("Invalid daemon restart request id");
  const directory = join(daemonHome, FOLLOW_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ requestId, pid: process.pid }), { mode: 0o600, flag: "wx" });
  return () => {
    try { rmSync(path, { force: true }); } catch { /* A dead owner is pruned by the next writer. */ }
  };
}

/** Read active registrations while holding the results lock; reclaim dead owners. */
export function activeAgenCDaemonRestartFollows(daemonHome: string): ReadonlySet<string> {
  const directory = join(daemonHome, FOLLOW_DIRECTORY);
  let names: string[];
  try { names = readdirSync(directory); } catch { return new Set(); }
  const ids = new Set<string>();
  for (const name of names) {
    if (!/^\d+-[a-f0-9-]+\.json$/u.test(name)) continue;
    const path = join(directory, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as { requestId?: unknown; pid?: unknown };
      if (!isAgenCDaemonRestartRequestId(entry.requestId) ||
          typeof entry.pid !== "number" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) continue;
      try { process.kill(entry.pid, 0); }
      catch (error) {
        // Permission or inspection failures cannot prove that a follower died.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          ids.add(entry.requestId);
          continue;
        }
        rmSync(path, { force: true });
        continue;
      }
      ids.add(entry.requestId);
    } catch { /* A registration being released is harmless. */ }
  }
  return ids;
}
