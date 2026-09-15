import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { readExecutionEnvironmentBinding } from "./binding.js";
import { ExecutionEnvironmentError, type ExecutionDirectoryEntry, type ExecutionEnvironment,
  type ExecutionPathDescription } from "./types.js";
import { WorkspaceBoundReadFileTooLargeError } from "../workspace/bound-read-error.js";

export type ContentExecutionEnvironment = Pick<ExecutionEnvironment, "binding" | "filesystem">;
export interface ContentFileStat {
  readonly size: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface ContentDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Optional content may be unreadable; losing its execution authority is fatal. */
export function rethrowContentAuthorityError(error: unknown): void {
  if (error instanceof AggregateError || (error instanceof ExecutionEnvironmentError &&
      !["not_found", "path_conflict", "permission_denied", "unsupported_resource", "file_limit"].includes(error.code))) throw error;
}

export function contentPathMissing(error: unknown): boolean {
  return error instanceof ExecutionEnvironmentError ? error.code === "not_found" :
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function assertSameDescription(before: ExecutionPathDescription, after: ExecutionPathDescription): void {
  if (before.canonicalPath !== after.canonicalPath ||
      (Object.keys(before.identity) as (keyof typeof before.identity)[]).some((key) => before.identity[key] !== after.identity[key])) {
    throw new ExecutionEnvironmentError("path_conflict", "Content changed during a protected read", true, false);
  }
}

async function withCapability<T>(capability: { dispose(): Promise<void> }, read: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await read(); }
  catch (error) {
    try { await capability.dispose(); }
    catch (releaseError) { throw new AggregateError([error, releaseError], "Content read and capability release failed", { cause: error }); }
    throw error;
  }
  await capability.dispose();
  return result;
}

function directoryEntry(entry: ExecutionDirectoryEntry): ContentDirectoryEntry {
  return { name: entry.name, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory",
    isSymbolicLink: () => entry.kind === "symlink" };
}

/** Explicit source authority for plugin and skill content. No task program runs here. */
export class ContentFilesystem {
  readonly environment?: ContentExecutionEnvironment;

  constructor(environment?: ContentExecutionEnvironment) {
    this.environment = environment === undefined ? undefined : Object.freeze({
      binding: readExecutionEnvironmentBinding(environment.binding), filesystem: environment.filesystem,
    });
  }

  private path(path: string): string {
    if (this.environment && (!posix.isAbsolute(path) || path.includes("\0") || Buffer.from(path).toString() !== path)) {
      throw new ExecutionEnvironmentError("invalid_request", "Task content paths must be absolute, well-formed text", false);
    }
    return path;
  }

  async stat(path: string, followSymlinks = true): Promise<ContentFileStat> {
    if (!this.environment) return followSymlinks ? stat(path, { bigint: true }) : lstat(path, { bigint: true });
    const { identity } = await this.environment.filesystem.describePath(this.path(path), { followSymlinks });
    const mode = BigInt(identity.mode) & 0o170000n;
    return { size: BigInt(identity.size), isFile: () => mode === 0o100000n,
      isDirectory: () => mode === 0o040000n, isSymbolicLink: () => mode === 0o120000n };
  }

  async realpath(path: string): Promise<string> {
    return this.environment ? (await this.environment.filesystem.describePath(this.path(path))).canonicalPath : realpath(path);
  }

  async readText(path: string, maximumBytes = 0xffffffff): Promise<string> {
    if (!this.environment) {
      const info = await stat(path);
      if (info.size > maximumBytes) throw new WorkspaceBoundReadFileTooLargeError(path, info.size);
      return readFile(path, "utf8");
    }
    const filesystem = this.environment.filesystem;
    const expected = await filesystem.describePath(this.path(path));
    if ((BigInt(expected.identity.mode) & 0o170000n) !== 0o100000n) {
      throw new ExecutionEnvironmentError("unsupported_resource", "Content must be a regular file", true, false);
    }
    if (BigInt(expected.identity.size) > BigInt(maximumBytes)) {
      throw new WorkspaceBoundReadFileTooLargeError(path, Number(expected.identity.size));
    }
    const file = await filesystem.bindFileSnapshot(path);
    return withCapability(file, async () => {
      assertSameDescription(expected, await file.describe());
      const bytes = await file.readFile(maximumBytes);
      if (bytes.length > maximumBytes) throw new WorkspaceBoundReadFileTooLargeError(path, bytes.length);
      assertSameDescription(expected, await file.describe());
      return bytes.toString("utf8");
    });
  }

  async readDirectory(path: string): Promise<readonly ContentDirectoryEntry[]> {
    if (!this.environment) return readdir(path, { withFileTypes: true });
    const filesystem = this.environment.filesystem;
    const expected = await filesystem.describePath(this.path(path));
    const directory = await filesystem.bindDirectorySnapshot(path);
    return withCapability(directory, async () => {
      assertSameDescription(expected, await directory.describe());
      const entries: ContentDirectoryEntry[] = [];
      for await (const entry of directory.entries()) {
        if (entries.length >= 1_000_000) throw new ExecutionEnvironmentError("directory_limit", "Content directory exceeds its entry bound", true, false);
        entries.push(directoryEntry(entry));
      }
      assertSameDescription(expected, await directory.describe());
      return entries;
    });
  }
}

export const localContentFilesystem = new ContentFilesystem();
