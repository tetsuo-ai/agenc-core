import { posix } from "node:path";
import { ContentFilesystem, rethrowContentAuthorityError, type ContentExecutionEnvironment } from "./content-filesystem.js";
import { ExecutionEnvironmentError, type ExecutionPathDescription } from "./types.js";
import { prepareExecutionWorkspace, type ExecutionWorkspace } from "./workspace.js";

const MAX_ENTRIES = 1_000_000;

function inside(parent: string, path: string): boolean {
  const relative = posix.relative(parent, path);
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !posix.isAbsolute(relative));
}
function kind(description: ExecutionPathDescription): bigint {
  return BigInt(description.identity.mode) & 0o170000n;
}
function same(left: ExecutionPathDescription, right: ExecutionPathDescription): boolean {
  return left.canonicalPath === right.canonicalPath &&
    (Object.keys(left.identity) as (keyof typeof left.identity)[]).every((key) => left.identity[key] === right.identity[key]);
}

/** Project tier traversal using task metadata only, including sparse worktrees. */
export async function executionMarkdownDirectories(subdir: string, cwd: string, workspace: ExecutionWorkspace): Promise<string[]> {
  if (!posix.isAbsolute(cwd)) throw new ExecutionEnvironmentError("invalid_request", "Task markdown cwd must be absolute", false);
  const filesystem = new ContentFilesystem(workspace.environment);
  if (!(await filesystem.stat(cwd)).isDirectory()) throw new ExecutionEnvironmentError("invalid_request", "Task markdown cwd must be a directory", false);
  async function pathKind(path: string): Promise<"file" | "directory" | null> {
    try {
      const metadata = await filesystem.stat(path);
      return metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : null;
    } catch (error) { rethrowContentAuthorityError(error); return null; }
  }
  async function gitDirectory(path: string): Promise<boolean> {
    return await pathKind(posix.join(path, "HEAD")) === "file" &&
      await pathKind(posix.join(path, "objects")) === "directory" && await pathKind(posix.join(path, "refs")) === "directory";
  }
  async function marker(path: string): Promise<boolean> {
    const type = await pathKind(path);
    if (type === "directory") return gitDirectory(path);
    if (type !== "file") return false;
    try {
      const text = (await filesystem.readText(path)).trim();
      if (!text.startsWith("gitdir:") || !text.slice(7).trim()) return false;
      const target = posix.resolve(posix.dirname(path), text.slice(7).trim());
      return await gitDirectory(target) || (await pathKind(posix.join(target, "commondir")) === "file" &&
        await pathKind(posix.join(target, "gitdir")) === "file");
    } catch (error) { rethrowContentAuthorityError(error); return false; }
  }
  async function nearestGitRoot(path: string): Promise<string | null> {
    for (let current = posix.resolve(path);;) {
      if (await marker(posix.join(current, ".git")) || (posix.basename(current) !== ".git" && await gitDirectory(current))) return current;
      const parent = posix.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  const gitRoot = await nearestGitRoot(cwd);
  const sessionRoot = workspace.projectRoot === cwd ? gitRoot : await nearestGitRoot(workspace.projectRoot);
  const canonicalRoot = gitRoot
    ? (await prepareExecutionWorkspace(workspace.environment, gitRoot)).memoryProjectRoot : null;
  const boundary = gitRoot && sessionRoot && canonicalRoot !== sessionRoot && inside(sessionRoot, gitRoot)
    ? sessionRoot : gitRoot;
  const roots: string[] = [];
  for (let current = posix.resolve(cwd);;) {
    if (workspace.homePath !== undefined && current === posix.resolve(workspace.homePath)) break;
    const path = posix.join(current, ".agenc", subdir);
    try { if ((await filesystem.stat(path)).isDirectory()) roots.push(path); }
    catch (error) { rethrowContentAuthorityError(error); }
    const parent = posix.dirname(current);
    if (current === boundary || current === parent) break;
    current = parent;
  }
  if (gitRoot && canonicalRoot && canonicalRoot !== gitRoot && !roots.includes(posix.join(gitRoot, ".agenc", subdir))) {
    const fallback = posix.join(canonicalRoot, ".agenc", subdir);
    if (!roots.includes(fallback)) roots.push(fallback);
  }
  return roots;
}

/** Read a configuration tier without launching a task or controller search tool. */
export async function readExecutionMarkdownTier(dir: string, environment: ContentExecutionEnvironment): Promise<readonly {
  readonly filePath: string; readonly content: string; readonly identity: string;
}[]> {
  if (!posix.isAbsolute(dir)) throw new ExecutionEnvironmentError("invalid_request", "Task markdown tiers must be absolute", false);
  dir = posix.normalize(dir).replace(/\/$/u, "") || "/";
  const content = new ContentFilesystem(environment);
  const filesystem = content.environment!.filesystem;
  const describe = (path: string) => filesystem.describePath(path, { followSymlinks: false });
  let base: ExecutionPathDescription;
  try {
    base = await describe(dir);
    if (kind(base) !== 0o040000n) return [];
    const anchor = await content.realpath(posix.dirname(posix.dirname(dir)));
    if (!inside(anchor, base.canonicalPath)) return [];
  } catch (error) { rethrowContentAuthorityError(error); return []; }
  const queue = [dir], visited = new Set<string>();
  const files: { filePath: string; content: string; identity: string }[] = [];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    try {
      const entry = await describe(path);
      if (!inside(base.canonicalPath, entry.canonicalPath)) continue;
      if (kind(entry) === 0o040000n) {
        const key = `${entry.identity.dev}:${entry.identity.ino}:${entry.canonicalPath}`;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const child of await content.readDirectory(path)) {
          if (child.isSymbolicLink()) continue;
          if (!child.isDirectory() && !(child.isFile() && child.name.endsWith(".md"))) continue;
          if (queue.length >= MAX_ENTRIES) throw new ExecutionEnvironmentError("directory_limit", "Markdown tier exceeds its entry bound", true, false);
          queue.push(posix.join(path, child.name));
        }
        continue;
      }
      if (kind(entry) !== 0o100000n || entry.identity.nlink !== "1" || !path.endsWith(".md")) continue;
      // Pin the complete observed directory chain across reading, rejecting
      // parent swaps and newly introduced symlinks as well as leaf changes.
      const parents: [string, ExecutionPathDescription][] = [];
      let safe = true;
      for (let parent = posix.dirname(path);;) {
        const held = await describe(parent);
        if (kind(held) !== 0o040000n || !inside(base.canonicalPath, held.canonicalPath)) { safe = false; break; }
        parents.push([parent, held]);
        if (parent === dir) break;
        const next = posix.dirname(parent);
        if (next === parent) { safe = false; break; }
        parent = next;
      }
      if (!safe || !same(base, await describe(dir))) continue;
      const text = await content.readText(path);
      if (!same(entry, await describe(path))) continue;
      for (const [parent, held] of parents) if (!same(held, await describe(parent))) { safe = false; break; }
      if (safe) files.push({ filePath: path, content: text, identity: `${entry.identity.dev}:${entry.identity.ino}` });
    } catch (error) { rethrowContentAuthorityError(error); }
  }
  return files.sort((left, right) => left.filePath.localeCompare(right.filePath));
}
