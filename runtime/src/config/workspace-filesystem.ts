import { posix, resolve } from "node:path";
import { readExecutionEnvironmentBinding } from "../execution/binding.js";
import { ExecutionEnvironmentError, executionEnvironmentCacheKey, type ExecutionEnvironment,
  type ExecutionEnvironmentBinding, type ExecutionFilesystem } from "../execution/types.js";
import type { WorkspaceBoundReadFileStats } from "../workspace/file-mutation-transaction.js";
import { StableFileError, type StableFileSnapshot } from "./stable-file.js";

/** Project/explicit task config authority, separate from controller settings. */
export interface ConfigWorkspaceFilesystem {
  readonly executionEnvironment: Pick<ExecutionEnvironment, "binding" | "filesystem">;
  readonly binding: ExecutionEnvironmentBinding;
  readonly namespaceKey: string;
  /** Task home, when provided by the operator; never the controller's HOME. */
  readonly homePath?: string;
  readStableFile(path: string, options?: { readonly allowLeafSymlink?: boolean }): Promise<StableFileSnapshot | null>;
  exists(path: string, options?: { readonly followSymlinks?: boolean }): Promise<boolean>;
}

function sameIdentity(left: Pick<WorkspaceBoundReadFileStats, "dev" | "ino" | "mode">,
  right: Pick<WorkspaceBoundReadFileStats, "dev" | "ino" | "mode">): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function absolute(path: string): string {
  if (!posix.isAbsolute(path) || path.includes("\0")) {
    throw new StableFileError("invalid-path", "Task configuration path must be absolute", path);
  }
  return posix.normalize(path);
}

export function configWorkspaceCwd(filesystem: ConfigWorkspaceFilesystem | undefined, cwd: string | undefined): string {
  if (filesystem === undefined) return resolve(cwd ?? process.cwd());
  if (cwd === undefined) throw new StableFileError("invalid-path", "Selected task configuration requires an explicit cwd", "");
  return absolute(cwd);
}

export class ExecutionConfigFilesystem implements ConfigWorkspaceFilesystem {
  readonly executionEnvironment: Pick<ExecutionEnvironment, "binding" | "filesystem">;
  readonly binding: ExecutionEnvironmentBinding;
  readonly namespaceKey: string;
  readonly homePath?: string;
  private readonly filesystem: ExecutionFilesystem;

  constructor(environment: Pick<ExecutionEnvironment, "binding" | "filesystem">, options: { readonly homePath?: string } = {}) {
    this.binding = readExecutionEnvironmentBinding(environment.binding);
    if (this.binding.kind !== "docker") throw new ExecutionEnvironmentError("unsupported_environment", "Task configuration requires a qualified execution environment", false);
    this.namespaceKey = executionEnvironmentCacheKey(this.binding, "");
    this.filesystem = environment.filesystem;
    this.executionEnvironment = Object.freeze({ binding: this.binding, filesystem: this.filesystem });
    if (options.homePath !== undefined) this.homePath = absolute(options.homePath);
  }

  async exists(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<boolean> {
    try { await this.filesystem.inspectPath(absolute(path), options); return true; }
    catch (error) {
      if (error instanceof ExecutionEnvironmentError && error.code === "not_found") return false;
      throw error;
    }
  }

  async readStableFile(inputPath: string, options: { readonly allowLeafSymlink?: boolean } = {}): Promise<StableFileSnapshot | null> {
    const path = absolute(inputPath);
    let before: WorkspaceBoundReadFileStats;
    try { before = await this.filesystem.inspectPath(path, { followSymlinks: false }); }
    catch (error) {
      if (error instanceof ExecutionEnvironmentError && error.code === "not_found") return null;
      throw error;
    }
    const mode = Number(before.mode) & 0o170000;
    if (mode === 0o120000 && options.allowLeafSymlink !== true) {
      throw new StableFileError("symbolic-link", "Task configuration refuses a symbolic-link target", path);
    }
    if (mode !== 0o120000 && mode !== 0o100000) {
      throw new StableFileError("not-file", "Task configuration is not a regular file", path);
    }
    const target = mode === 0o120000 ? await this.filesystem.inspectPath(path) : before;
    if ((Number(target.mode) & 0o170000) !== 0o100000) {
      throw new StableFileError("not-file", "Task configuration symlink target is not a regular file", path);
    }
    const capability = await this.filesystem.bindFileSnapshot(path);
    try {
      const opened = await capability.describe();
      // Native reads are chunked and descriptor-bound. Do not apply the
      // transaction snapshot limit to ordinary configuration file reads.
      const bytes = await capability.readFile(0xffffffff);
      const afterRead = await capability.describe();
      const after = await this.filesystem.inspectPath(path, { followSymlinks: false });
      const afterTarget = mode === 0o120000 ? await this.filesystem.inspectPath(path) : after;
      if (!sameIdentity(before, after) || !sameIdentity(target, opened.identity) || !sameIdentity(opened.identity, afterTarget) ||
          opened.canonicalPath !== afterRead.canonicalPath ||
          (Object.keys(opened.identity) as (keyof typeof opened.identity)[]).some((key) => opened.identity[key] !== afterRead.identity[key])) {
        throw new StableFileError("identity-changed", "Task configuration changed identity during read", path);
      }
      return Object.freeze({ path, resolvedPath: opened.canonicalPath, bytes, mode: Number(opened.identity.mode) & 0o777,
        dev: Number(opened.identity.dev), ino: Number(opened.identity.ino), identity: `${opened.identity.dev}:${opened.identity.ino}` });
    } finally { await capability.dispose(); }
  }
}

/** Same nearest-marker ordering as the local root walk, within the task root. */
export async function findConfigWorkspaceRoot(filesystem: ConfigWorkspaceFilesystem, cwd: string,
  markers: readonly string[]): Promise<string | undefined> {
  let current = absolute(cwd);
  const relativeToHome = filesystem.homePath === undefined ? undefined : posix.relative(filesystem.homePath, current);
  const stopBefore = relativeToHome !== undefined && relativeToHome !== "" && relativeToHome !== ".." &&
    !relativeToHome.startsWith("../") && !posix.isAbsolute(relativeToHome) ? filesystem.homePath : undefined;
  while (markers.length > 0) {
    if (current === stopBefore) return undefined;
    for (const marker of markers) if (await filesystem.exists(posix.join(current, marker))) return current;
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}
