/** Filesystem-only discovery for status; does not open a project database. */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface StateDatabasePaths {
  readonly projectDir: string;
  readonly stateDbPath: string;
  readonly logsDbPath: string;
}

export const STATE_DATABASE_FILENAME = "agenc-state_1.sqlite";
export const LOGS_DATABASE_FILENAME = "agenc-logs_1.sqlite";

export function discoverStateDatabasePaths(
  agencHome: string,
): StateDatabasePaths[] {
  const projectsDir = join(agencHome, "projects");
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const projectDir = join(projectsDir, entry.name);
      return {
        projectDir,
        stateDbPath: join(projectDir, STATE_DATABASE_FILENAME),
        logsDbPath: join(projectDir, LOGS_DATABASE_FILENAME),
      };
    })
    .filter((paths) => existsSync(paths.stateDbPath));
}
