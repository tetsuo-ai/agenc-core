import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_SESSION_ROOT_MARKERS: readonly string[] = [
  ".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", ".hg",
];

export interface ProjectRootSearchOptions {
  /** Exclusive ancestor boundary when cwd is strictly beneath this directory. */
  readonly stopBefore?: string;
}

function projectRootStopBefore(cwd: string, requestedBoundary: string): string | undefined {
  const start = resolve(cwd);
  const boundary = resolve(requestedBoundary);
  const fromBoundary = relative(boundary, start);
  if (fromBoundary === "" || fromBoundary === ".." || fromBoundary.startsWith(`..${sep}`) || isAbsolute(fromBoundary)) return undefined;
  return boundary;
}

/** Local-only root discovery. Selected task environments use their filesystem. */
export function findProjectRootSync(cwd: string, markers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
  options: ProjectRootSearchOptions = {}): { rootDir: string; marker: string } | null {
  if (markers.length === 0) return null;
  const stopBefore = projectRootStopBefore(cwd, options.stopBefore ?? homedir());
  let currentDir = cwd;
  while (true) {
    if (stopBefore !== undefined && resolve(currentDir) === stopBefore) return null;
    for (const marker of markers) if (existsSync(join(currentDir, marker))) return { rootDir: currentDir, marker };
    const parent = dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}
