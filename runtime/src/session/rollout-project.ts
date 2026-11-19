import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * The project directory that holds a canonical rollout file
 * (`<AGENC_HOME>/projects/<project>/sessions/<session>/rollout-*.jsonl`), or
 * undefined when the path is not one.
 *
 * A run's state lives in that project's databases. Finding the project again
 * from the run's folder is not stable: it names another project once a root
 * marker (.git, package.json and the like) appears in or above the folder, or
 * is removed, and when the daemon runs with another HOME (the search for a
 * marker stops there). A run resumed into the folder's new project kept its
 * old state in the first one, so its owners conflicted and `run.status` and
 * `run.replay` refused it with RUN_ID_AMBIGUOUS from then on.
 */
export function rolloutProjectDir(
  rolloutPath: string,
  agencHome: string,
): string | undefined {
  const file = basename(rolloutPath);
  const sessionsDir = dirname(dirname(rolloutPath));
  const projectDir = dirname(sessionsDir);
  if (
    !file.startsWith("rollout-") ||
    !file.endsWith(".jsonl") ||
    basename(sessionsDir) !== "sessions" ||
    basename(projectDir).length === 0
  ) {
    return undefined;
  }
  const projectsRoot = resolve(agencHome, "projects");
  if (dirname(projectDir) === projectsRoot) return projectDir;
  try {
    return dirname(projectDir) === realpathSync(projectsRoot)
      ? projectDir
      : undefined;
  } catch {
    return undefined;
  }
}
