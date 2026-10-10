import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { CRON_STORAGE_NAME, withCronStorageDirectory } from "./cron-storage-directory.js";
import type { CronTask } from "./cronTasks.js";

/** A negative-only probe: uncertainty still takes the original restore path. */
export async function readStartupCronTasks(
  workspaceRoot: string,
  assertStartupActive: () => void,
): Promise<CronTask[]> {
  let mayHavePersistedState = true;
  try {
    mayHavePersistedState = (await withCronStorageDirectory(workspaceRoot, false, async ({ directory }) => {
      try {
        // Metadata only, through the same retained directory descriptors as
        // the full reader. Never parse or trust a record in this cheap probe.
        await lstat(join(directory.operationPath, CRON_STORAGE_NAME));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })) ?? false;
  } catch {
    // Unsafe directories, unavailable confinement and I/O errors retain the
    // full reader's validation and its existing startup warning behavior.
  }
  assertStartupActive();
  if (!mayHavePersistedState) return [];
  const { durableCronDispatchSupported, durableCronDispatchUnsupported, readCronTasks } =
    await import("./cronTasks.js");
  assertStartupActive();
  const tasks = await readCronTasks(workspaceRoot);
  // A readable record is not an armed one. Off Linux the session scheduler
  // drops durable records, so startup reports them instead of arming.
  if (tasks.length > 0 && !durableCronDispatchSupported()) throw durableCronDispatchUnsupported();
  return tasks;
}
