import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readExecutionEnvironmentBinding } from "./binding.js";
import { ExecutionEnvironmentError, executionEnvironmentCacheKey, type ExecutionEnvironment,
  type ExecutionEnvironmentBinding, type ExecutionFileIdentity } from "./types.js";

export type ExecutionWorkspaceEnvironment = Pick<ExecutionEnvironment, "binding" | "filesystem">;

/** Controller-owned snapshot published with the configuration it accompanies. */
export interface ExecutionWorkspace {
  readonly environment: ExecutionWorkspaceEnvironment;
  readonly projectRoot: string;
  readonly memoryProjectRoot: string;
  readonly homePath?: string;
}

function optionalMetadataError(error: unknown): void {
  if (!(error instanceof ExecutionEnvironmentError) ||
      !["not_found", "permission_denied", "unsupported_resource", "path_conflict"].includes(error.code)) throw error;
}

/** Resolve Git metadata through protected descriptors; never run a task Git binary here. */
export async function prepareExecutionWorkspace(environment: ExecutionWorkspaceEnvironment, projectRoot: string,
  homePath?: string): Promise<ExecutionWorkspace> {
  const bound = Object.freeze({ binding: readExecutionEnvironmentBinding(environment.binding), filesystem: environment.filesystem });
  const filesystem = bound.filesystem;
  if (!posix.isAbsolute(projectRoot) || (homePath !== undefined && !posix.isAbsolute(homePath))) {
    throw new ExecutionEnvironmentError("invalid_request", "Task workspace roots must be absolute", false);
  }
  async function kind(path: string): Promise<"file" | "directory" | null> {
    try {
      const mode = Number((await filesystem.inspectPath(path)).mode) & 0o170000;
      return mode === 0o100000 ? "file" : mode === 0o040000 ? "directory" : null;
    } catch (error) { optionalMetadataError(error); return null; }
  }
  async function text(path: string): Promise<string | null> {
    if (await kind(path) !== "file") return null;
    try {
      const file = await filesystem.bindFileSnapshot(path);
      try {
        const before = await file.describe();
        const bytes = await file.readFile(0xffffffff);
        const after = await file.describe();
        if (before.canonicalPath !== after.canonicalPath ||
            (Object.keys(before.identity) as (keyof ExecutionFileIdentity)[]).some((key) => before.identity[key] !== after.identity[key])) return null;
        return bytes.toString("utf8").trim();
      } finally { await file.dispose(); }
    } catch (error) { optionalMetadataError(error); return null; }
  }
  async function gitDirectory(path: string): Promise<boolean> {
    return await kind(posix.join(path, "HEAD")) === "file" &&
      await kind(posix.join(path, "objects")) === "directory" && await kind(posix.join(path, "refs")) === "directory";
  }
  async function marker(path: string): Promise<boolean> {
    const type = await kind(path);
    if (type === "directory") return gitDirectory(path);
    if (type !== "file") return false;
    const pointer = await text(path);
    if (!pointer?.startsWith("gitdir:") || !pointer.slice(7).trim()) return false;
    const target = posix.resolve(posix.dirname(path), pointer.slice(7).trim());
    return await gitDirectory(target) || (await kind(posix.join(target, "commondir")) === "file" &&
      await kind(posix.join(target, "gitdir")) === "file");
  }
  async function canonicalGitRoot(root: string): Promise<string> {
    const pointer = await text(posix.join(root, ".git"));
    if (!pointer?.startsWith("gitdir:") || !pointer.slice(7).trim()) return root;
    const privateDir = posix.resolve(root, pointer.slice(7).trim());
    const commonPointer = await text(posix.join(privateDir, "commondir"));
    if (!commonPointer) return root;
    const common = posix.resolve(privateDir, commonPointer);
    if (posix.dirname(privateDir) !== posix.join(common, "worktrees")) return root;
    const backlink = await text(posix.join(privateDir, "gitdir"));
    if (!backlink || !posix.isAbsolute(backlink)) return root;
    try {
      if ((await filesystem.describePath(backlink)).canonicalPath !== posix.join(root, ".git")) return root;
    } catch (error) { optionalMetadataError(error); return root; }
    const target = posix.basename(common) === ".git" ? posix.dirname(common) : common;
    try { return (await filesystem.describePath(target)).canonicalPath; }
    catch (error) { optionalMetadataError(error); return root; }
  }

  const root = await filesystem.describePath(projectRoot);
  if ((Number(root.identity.mode) & 0o170000) !== 0o040000) {
    throw new ExecutionEnvironmentError("invalid_request", "Task workspace root must be a directory", true, false);
  }
  let current = root.canonicalPath;
  let memoryProjectRoot = current;
  for (;;) {
    if (await marker(posix.join(current, ".git")) ||
        (posix.basename(current) !== ".git" && await gitDirectory(current))) {
      memoryProjectRoot = await canonicalGitRoot(current);
      break;
    }
    const parent = posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return Object.freeze({ environment: bound, projectRoot: root.canonicalPath, memoryProjectRoot,
    ...(homePath === undefined ? {} : { homePath }) });
}

/** A task path must never be canonicalized against the controller filesystem. */
export function executionWorkspaceStorageKey(binding: ExecutionEnvironmentBinding, path: string): string {
  if (!posix.isAbsolute(path) || path.includes("\0") || Buffer.from(path).toString() !== path) {
    throw new TypeError("Task storage paths must be absolute, well-formed text");
  }
  const canonical = posix.normalize(path);
  const digest = createHash("sha256").update(executionEnvironmentCacheKey(readExecutionEnvironmentBinding(binding), canonical)).digest("hex");
  return `v3-${binding.kind}-${canonical.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 64)}-${digest}`;
}
