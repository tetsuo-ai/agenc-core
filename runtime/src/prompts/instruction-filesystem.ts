import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { ExecutionEnvironmentError, type ExecutionEnvironment, type ExecutionFileIdentity } from "../execution/types.js";
import { WorkspaceBoundReadFileTooLargeError } from "../workspace/bound-read-error.js";

export type InstructionExecutionEnvironment = Pick<ExecutionEnvironment, "binding" | "filesystem">;
export type InstructionFileStat = Pick<BigIntStats,
  "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeNs" | "ctimeNs" | "isFile" | "isDirectory" | "isSymbolicLink">;
export interface InstructionFileHandle {
  stat(): Promise<InstructionFileStat>;
  readBounded(maximumBytes: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}
export interface InstructionFilesystem {
  lstat(path: string): Promise<InstructionFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<InstructionFileHandle>;
  opendir(path: string, expected: InstructionFileStat): Promise<AsyncIterable<{ readonly name: string }>>;
}

function sameIdentity(left: InstructionFileStat, right: InstructionFileStat): boolean {
  return (["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const)
    .every((key) => left[key] === right[key]);
}

function stat(identity: ExecutionFileIdentity): InstructionFileStat {
  const mode = BigInt(identity.mode);
  return Object.freeze({ dev: BigInt(identity.dev), ino: BigInt(identity.ino), mode,
    nlink: BigInt(identity.nlink), size: BigInt(identity.size), mtimeNs: BigInt(identity.mtimeNs), ctimeNs: BigInt(identity.ctimeNs),
    isFile: () => (mode & 0o170000n) === 0o100000n,
    isDirectory: () => (mode & 0o170000n) === 0o040000n,
    isSymbolicLink: () => (mode & 0o170000n) === 0o120000n });
}

/** Read failures may omit guidance; loss of execution authority must propagate. */
export function instructionFilesystemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ExecutionEnvironmentError)) return (error as NodeJS.ErrnoException | undefined)?.code;
  const codes: Readonly<Record<string, string>> = {
    not_found: "ENOENT", path_conflict: "ESTALE", permission_denied: "EACCES", unsupported_resource: "EOPNOTSUPP",
  };
  const code = codes[error.code];
  if (code === undefined) throw error;
  return code;
}

/** Explicit environment selection; task I/O never falls through to local fs. */
export function instructionFilesystem(environment?: InstructionExecutionEnvironment): InstructionFilesystem {
  if (environment !== undefined) {
    const filesystem = environment.filesystem;
    return {
      lstat: async (path) => stat((await filesystem.describePath(path, { followSymlinks: false })).identity),
      realpath: async (path) => (await filesystem.describePath(path)).canonicalPath,
      opendir: async (path, expected) => (async function* () {
        const directory = await filesystem.bindDirectorySnapshot(path);
        const assertIdentity = async () => {
          if (!sameIdentity(expected, stat((await directory.describe()).identity))) {
            throw new ExecutionEnvironmentError("path_conflict", "Instruction directory changed during enumeration", true, false);
          }
        };
        try {
          await assertIdentity();
          yield* directory.entries();
          await assertIdentity();
        } finally { await directory.dispose(); }
      })(),
      open: async (path) => {
        const file = await filesystem.bindFileSnapshot(path);
        return { stat: async () => stat((await file.describe()).identity),
          readBounded: async (maximumBytes) => {
            try { return await file.readFile(maximumBytes); }
            catch (error) { if (error instanceof WorkspaceBoundReadFileTooLargeError) return null; throw error; }
          }, close: () => file.dispose() };
      },
    };
  }
  return {
    lstat: (path) => lstat(path, { bigint: true }), realpath,
    opendir: (path) => opendir(path, { bufferSize: 32 }),
    open: async (path) => {
      const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
      const nonBlock = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
      const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
      return { stat: () => handle.stat({ bigint: true }), close: () => handle.close(),
        readBounded: async (maximumBytes) => {
          const bytes = Buffer.allocUnsafe(maximumBytes + 1);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          return offset > maximumBytes ? null : bytes.subarray(0, offset);
        } };
    },
  };
}
