import { basename, dirname } from "node:path";
import { ExecutionEnvironmentError, type ExecutionFileIdentity, type ExecutionFilesystem } from "../../src/execution/types.js";
import type { InstructionExecutionEnvironment } from "../../src/prompts/instruction-filesystem.js";
import { WorkspaceBoundReadFileTooLargeError } from "../../src/workspace/bound-read-error.js";
import type { WorkspaceFilePathExpectedState, WorkspaceFilePathTransactionGuard } from "../../src/workspace/file-mutation-transaction.js";

interface Entry { readonly identity: ExecutionFileIdentity; readonly bytes: Buffer }
export class TaskFiles {
  readonly entries = new Map<string, Entry>();
  readonly reads: string[] = [];
  released = 0;
  enumerated = 0;
  sequence = 0;
  unavailable = false;
  /** Guarded writes that were applied before their acknowledgement was lost. */
  loseWriteAck = false;
  writes = 0;
  beforeDirectoryBind?: (path: string) => void;

  put(path: string, content: string | Buffer, directory = false): void {
    const parent = dirname(path);
    if (parent !== path && !this.entries.has(parent)) this.put(parent, "", true);
    const stamp = String(++this.sequence);
    this.entries.set(path, { bytes: Buffer.from(content), identity: { dev: "7", ino: stamp,
      mode: String(directory ? 0o040755 : 0o100644), nlink: "1", size: String(Buffer.byteLength(content)),
      mtimeNs: stamp, ctimeNs: stamp } });
    const owner = this.entries.get(parent);
    if (owner && parent !== path) this.entries.set(parent, { ...owner,
      identity: { ...owner.identity, mtimeNs: stamp, ctimeNs: stamp } });
  }
  private get(path: string): Entry {
    if (this.unavailable) throw new ExecutionEnvironmentError("environment_dead", "Original task is gone", false);
    const entry = this.entries.get(path);
    if (!entry) throw new ExecutionEnvironmentError("not_found", "Missing task path", true, false);
    return entry;
  }
  private describe(path: string, held = this.get(path)) {
    if (this.get(path) !== held) throw new ExecutionEnvironmentError("path_conflict", "Task path changed", true, false);
    return { canonicalPath: path, identity: held.identity };
  }
  private captureFileGuard(path: string): WorkspaceFilePathTransactionGuard {
    if (this.unavailable) throw new ExecutionEnvironmentError("environment_dead", "Original task is gone", false);
    const held = this.entries.get(path);
    const mayCreateParents = !this.entries.has(dirname(path));
    const current = (): Entry | undefined => {
      if (this.unavailable) throw new ExecutionEnvironmentError("environment_dead", "Original task is gone", false);
      return this.entries.get(path);
    };
    const conflict = (): never => { throw new ExecutionEnvironmentError("path_conflict", "Task file changed", true, false); };
    const check = (expected: WorkspaceFilePathExpectedState): void => {
      const entry = current();
      if (expected.kind === "missing" ? entry !== undefined : entry === undefined || !entry.bytes.equals(expected.content)) conflict();
    };
    let disposed = false;
    return {
      path, targetExisted: held !== undefined, mayCreateParents,
      ...(held ? { backupContent: Buffer.from(held.bytes) } : {}),
      assertOriginalState: async () => { if (current() !== held) conflict(); },
      assertState: async (expected) => check(expected),
      observeState: async () => {
        const entry = current();
        return entry ? { kind: "content", content: Buffer.from(entry.bytes) } : { kind: "missing" };
      },
      prepareBoundMutation: async () => {},
      writeBoundContent: async (expected, content, onEffectStart) => {
        check(expected);
        onEffectStart?.();
        this.writes++;
        this.put(path, content);
        if (this.loseWriteAck) throw new ExecutionEnvironmentError("unknown_outcome", "Lost write acknowledgement", true);
      },
      removeBoundEntry: async (expected, onEffectStart) => { check(expected); onEffectStart?.(); this.entries.delete(path); },
      dispose: async () => { if (!disposed) { disposed = true; this.released++; } },
    };
  }
  readonly filesystem = {
    captureFileGuard: async (path: string) => this.captureFileGuard(path),
    readLink: async (expected: import("../../src/execution/types.js").ExecutionPathDescription) => {
      const current = this.describe(expected.canonicalPath);
      if (current.identity !== expected.identity) throw new ExecutionEnvironmentError("path_conflict", "Task symlink changed", true, false);
      return this.get(expected.canonicalPath).bytes.toString("utf8");
    },
    inspectPath: async (path: string) => {
      const { identity, bytes } = this.get(path);
      return { dev: identity.dev, ino: identity.ino, mode: identity.mode, size: bytes.length,
        mtimeMs: Number(identity.mtimeNs) / 1e6, ctimeMs: Number(identity.ctimeNs) / 1e6 };
    },
    describePath: async (path: string) => this.describe(path),
    bindFileRead: async (path: string) => {
      const held = this.get(path);
      return { filePath: path, rootPath: dirname(path), describe: async () => this.describe(path, held),
        readFile: async (maximum: number) => {
          this.describe(path, held);
          if (held.bytes.length > maximum) throw new WorkspaceBoundReadFileTooLargeError(path, held.bytes.length);
          this.reads.push(path);
          return { content: Buffer.from(held.bytes), stats: await this.filesystem.inspectPath(path) };
        }, dispose: async () => { this.released++; } };
    },
    bindFileSnapshot: async (path: string) => {
      const held = this.get(path);
      return { describe: async () => this.describe(path, held), readFile: async () => {
        this.reads.push(path); return Buffer.from(held.bytes);
      }, dispose: async () => { this.released++; } };
    },
    bindDirectorySnapshot: async (path: string) => {
      this.beforeDirectoryBind?.(path);
      const held = this.get(path), files = this;
      return { describe: async () => this.describe(path, held), entries: async function* () {
        for (const candidate of files.entries.keys()) {
          if (candidate !== path && dirname(candidate) === path) {
            files.enumerated++;
            const mode = Number(files.entries.get(candidate)!.identity.mode) & 0o170000;
            yield { name: basename(candidate), kind: mode === 0o040000 ? "directory" as const :
              mode === 0o100000 ? "file" as const : mode === 0o120000 ? "symlink" as const : "other" as const };
          }
        }
      }, dispose: async () => { this.released++; } };
    },
  } as unknown as ExecutionFilesystem;
  environment(container = "a", generation = "b"): InstructionExecutionEnvironment {
    return { binding: { kind: "docker", containerId: container.repeat(64), generation: generation.repeat(64),
      processHandleNamespace: "c".repeat(32) }, filesystem: this.filesystem };
  }
}
