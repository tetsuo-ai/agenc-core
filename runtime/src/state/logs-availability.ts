import { lstatSync } from "node:fs";

/** An absence observation, not a lock against another SQLite opener. */
export function logsDatabaseFilesAreAbsent(logsDbPath: string): boolean {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      lstatSync(`${logsDbPath}${suffix}`);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}
