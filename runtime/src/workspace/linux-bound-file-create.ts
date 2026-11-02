import { constants, type Stats } from "node:fs";
import { open, stat, statfs, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { WorkspaceFileMutationPreEffectConflictError } from "./file-mutation-evidence.js";

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

function matches(actual: Stats, expected: DirectoryIdentity): boolean {
  return actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode;
}

/**
 * Linux exposes a held directory through procfs. Opening a single basename
 * below that descriptor has the same ancestor binding as a helper's cwd,
 * including when the public parent path is renamed after the final check.
 * Only exclusive creation uses this capability. Other operations retain
 * their existing helper, including creation of missing parent directories.
 */
export class LinuxBoundFileCreate {
  readonly #pending = new Set<Promise<unknown>>();
  #disposed = false;
  #closing?: Promise<void>;

  private constructor(
    private readonly directory: FileHandle,
    private readonly descriptorPath: string,
    private readonly identity: DirectoryIdentity,
  ) {}

  /** A failed capability probe performs no mutation and keeps the fallback. */
  static async bind(path: string, identity: DirectoryIdentity): Promise<LinuxBoundFileCreate | undefined> {
    if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) return undefined;
    let directory: FileHandle | undefined;
    try {
      // A plain directory or an emulated /proc/self/fd is not this capability.
      if ((await statfs("/proc/self/fd")).type !== 0x9fa0) return undefined;
      directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const descriptorPath = `/proc/self/fd/${directory.fd}`;
      if (!matches(await directory.stat(), identity) || !matches(await stat(descriptorPath), identity)) return undefined;
      const binding = new LinuxBoundFileCreate(directory, descriptorPath, identity);
      directory = undefined;
      return binding;
    } catch {
      return undefined;
    } finally {
      await directory?.close();
    }
  }

  create(path: string, content: Buffer, onEffectStart?: () => void): Promise<DirectoryIdentity> {
    if (this.#disposed) return Promise.reject(new Error("directory create capability is disposed"));
    const name = basename(path);
    if (name === "" || name === "." || name === ".." || name.includes("\0")) {
      return Promise.reject(new Error("invalid exclusive create basename"));
    }
    const task = this.#create(path, name, content, onEffectStart);
    this.#pending.add(task);
    // Both handlers settle successfully; no orphan rejected finally promise.
    void task.then(() => this.#pending.delete(task), () => this.#pending.delete(task));
    return task;
  }

  async #create(path: string, name: string, content: Buffer, onEffectStart?: () => void): Promise<DirectoryIdentity> {
    if (!matches(await this.directory.stat(), this.identity)) throw new Error("bound directory identity changed");
    let target: FileHandle;
    // Preserve the helper's conservative effect boundary. EEXIST alone proves
    // the attempted exclusive syscall did not touch the competing target.
    onEffectStart?.();
    try {
      target = await open(`${this.descriptorPath}/${name}`,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceFileMutationPreEffectConflictError(path);
      throw error;
    }
    try {
      let offset = 0;
      while (offset < content.length) {
        const written = await target.write(content, offset, content.length - offset, offset);
        if (written.bytesWritten <= 0) throw new Error("exclusive write made no progress");
        offset += written.bytesWritten;
      }
      const identity = await target.stat();
      return { dev: identity.dev, ino: identity.ino, mode: identity.mode };
    } finally {
      await target.close();
    }
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    // Do not close and recycle the directory fd while a path-based open is
    // pending in libuv. Every accepted operation retains this exact binding.
    return this.#closing ??= (async () => {
      await Promise.allSettled(this.#pending);
      await this.directory.close();
    })();
  }
}
