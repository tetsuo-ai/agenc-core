import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {
  basename,
  dirname,
  parse as parsePath,
  relative,
  resolve,
  sep as pathSeparator,
} from "node:path";

import {
  beginWorkspaceMutation,
  cancelWorkspaceMutation,
  commitWorkspaceMutation,
  reconcileUnknownMutation,
  WorkspaceMutationCoordinatorError,
  type WorkspaceMutationAdmission,
  type WorkspaceMutationObservedState,
} from "./mutation-coordinator.js";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";

type WorkspaceMutationAdmissionResult =
  WorkspaceMutationAdmission | { readonly decision: "uncoordinated" };

interface WorkspaceFileBackup {
  readonly existed: boolean;
  readonly content?: Buffer;
}

interface WorkspacePathIdentity {
  readonly expectedPath: string;
  readonly targetExisted: boolean;
  readonly anchorPath: string;
  readonly anchorRealPath: string;
  readonly anchorDev: number;
  readonly anchorIno: number;
  readonly anchorMode: number;
}

export type WorkspaceFilePathExpectedState =
  | {
      readonly kind: "content";
      readonly content: Buffer;
    }
  | { readonly kind: "missing" };

export type WorkspaceFilePathObservedState =
  | { readonly kind: "content"; readonly content: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/**
 * A pathname proof captured before a filesystem transaction starts.
 *
 * The original-state assertion includes the target's inode and exact bytes.
 * Later-state assertions deliberately use the independently captured parent
 * anchor: a successful delete makes the target inode disappear, but must not
 * make rollback through an exchanged parent pathname safe.
 */
export interface WorkspaceFilePathTransactionGuard {
  readonly path: string;
  readonly targetExisted: boolean;
  readonly backupContent?: Buffer;
  readonly assertOriginalState: () => Promise<void>;
  readonly assertState: (
    expected: WorkspaceFilePathExpectedState,
  ) => Promise<void>;
  readonly observeState: () => Promise<WorkspaceFilePathObservedState>;
  /**
   * Bind the directory used by a create/delete before a caller-controlled
   * final-check hook can yield. Existing-file writes bind the target itself
   * with a verified FileHandle and do not need a directory helper.
   */
  readonly prepareBoundMutation: (
    expected: WorkspaceFilePathExpectedState,
    operation: "write" | "remove",
  ) => Promise<void>;
  /** Write through a verified target descriptor or a pre-bound directory. */
  readonly writeBoundContent: (
    expected: WorkspaceFilePathExpectedState,
    content: Buffer,
    onEffectStart?: () => void,
  ) => Promise<void>;
  /** Delete through a pre-bound directory, never through a re-resolved path. */
  readonly removeBoundEntry: (
    expected: WorkspaceFilePathExpectedState,
    onEffectStart?: () => void,
  ) => Promise<void>;
  /** Stop the private directory-binding helper, when one was needed. */
  readonly dispose: () => Promise<void>;
}

class WorkspacePathIdentityChangedError extends WorkspaceMutationCoordinatorError {
  constructor(path: string) {
    super(
      "EDITOR_LEASE_MISMATCH",
      `Workspace path identity changed or its content no longer matches before the write to ${path}; no filesystem mutation was authorized.`,
    );
    this.name = "WorkspacePathIdentityChangedError";
  }
}

export class WorkspaceFileMutationPreEffectConflictError extends WorkspaceMutationCoordinatorError {
  constructor(path: string) {
    super(
      "EDITOR_LEASE_MISMATCH",
      `Workspace target appeared before the exclusive write to ${path}; no filesystem mutation was authorized.`,
    );
    this.name = "WorkspaceFileMutationPreEffectConflictError";
  }
}

export class WorkspaceFileMutationPathBindingUnavailableError extends WorkspaceMutationCoordinatorError {
  constructor(path: string, cause?: unknown) {
    super(
      "MUTATION_AUDIT_FAILED",
      `Safe directory-bound create/delete is unavailable for ${path}; refusing to fall back to a pathname that an ancestor exchange could redirect${
        cause === undefined ? "." : ` (${errorMessage(cause)}).`
      }`,
    );
    this.name = "WorkspaceFileMutationPathBindingUnavailableError";
  }
}

export interface WorkspaceFileMutationTestHooks {
  /**
   * Fault-injection seam. Tests may touch the target and then reject to model
   * truncating/partial filesystem syscalls.
   */
  readonly __testWrite?: (input: {
    readonly path: string;
    readonly write: () => Promise<void>;
  }) => Promise<void>;
  /**
   * Fault-injection seam for rollback failures. Production always calls the
   * provided exact-byte restore directly.
   */
  readonly __testRestoreBackup?: (input: {
    readonly path: string;
    readonly restore: () => Promise<void>;
  }) => Promise<void>;
}

export interface WorkspaceBoundFileMutation {
  readonly writeContent: (content: Buffer) => Promise<void>;
}

export interface WorkspaceBoundDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export interface WorkspaceBoundEntryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export interface WorkspaceBoundRegularFileIdentity extends WorkspaceBoundEntryIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly contentSha256: string;
}

export interface WorkspaceBoundDirectoryMutation {
  readonly removeSymlink: (
    expected: WorkspaceBoundEntryIdentity,
    linkTarget: string,
    onEffectStart?: () => void,
  ) => Promise<void>;
  readonly removeDirectory: (
    expected: WorkspaceBoundEntryIdentity,
    onEffectStart?: () => void,
  ) => Promise<void>;
  readonly renameRegularFile: (
    targetName: string,
    expected: WorkspaceBoundRegularFileIdentity,
    onEffectStart?: () => void,
  ) => Promise<WorkspaceBoundEntryIdentity>;
  readonly dispose: () => Promise<void>;
}

export interface WorkspaceBoundReadFileStats {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface WorkspaceBoundReadFile {
  readonly content: Buffer;
  readonly stats: WorkspaceBoundReadFileStats;
}

export interface WorkspaceBoundTextWindow {
  readonly content: string;
  readonly binarySample: Buffer;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly numLines: number;
  readonly isPartial: true;
  readonly stats: WorkspaceBoundReadFileStats;
}

export type WorkspaceBoundProcessStopReason =
  "timeout" | "output_limit" | "aborted";

export interface WorkspaceBoundRipgrepResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killedAfterLimit: boolean;
  readonly aborted: boolean;
  readonly stopReason?: WorkspaceBoundProcessStopReason;
  readonly spawnError?: Error;
}

export interface WorkspaceBoundReadCapability {
  /** Authenticated directory held as the helper's process cwd. */
  readonly rootPath: string;
  /**
   * Read a regular file with before/opened/after identity equality, adding
   * O_NOFOLLOW on platforms that expose it.
   */
  readonly readRelativeFile: (
    relativePath: string,
    maxBytes: number,
    options?: { readonly truncate?: boolean },
  ) => Promise<WorkspaceBoundReadFile>;
  /** Validate that a relative path currently names a confined regular file. */
  readonly validateRelativeFile: (relativePath: string) => Promise<void>;
  /**
   * Run the configured ripgrep executable from the held cwd. The helper
   * rejects --follow/-L and validates cwd identity immediately before spawn.
   */
  readonly runRipgrep: (input: {
    readonly program: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly lineLimit?: number;
    readonly stdin?: string | Buffer;
    readonly relativeInputFile?: string;
    readonly signal?: AbortSignal;
  }) => Promise<WorkspaceBoundRipgrepResult>;
  readonly dispose: () => Promise<void>;
}

export interface WorkspaceBoundFileReadCapability extends WorkspaceBoundReadCapability {
  readonly filePath: string;
  readonly readFile: (maxBytes: number) => Promise<WorkspaceBoundReadFile>;
  readonly readTextWindow: (
    offset: number,
    limit: number,
    maxBytes: number,
  ) => Promise<WorkspaceBoundTextWindow>;
}

export class WorkspaceBoundReadFileTooLargeError extends Error {
  readonly size: number;

  constructor(path: string, size: number) {
    super(`Bound read exceeds its byte limit for ${path}`);
    this.name = "WorkspaceBoundReadFileTooLargeError";
    this.size = size;
  }
}

export class WorkspaceReadCapabilityUnavailableError extends WorkspaceMutationCoordinatorError {
  constructor(path: string, cause?: unknown) {
    super(
      "MUTATION_AUDIT_FAILED",
      `Safe descriptor-bound Editor reads are unavailable for ${path}; refusing to fall back to a pathname that a final path exchange could redirect${
        cause === undefined ? "." : ` (${errorMessage(cause)}).`
      }`,
    );
    this.name = "WorkspaceReadCapabilityUnavailableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFileIdentity(
  left: Pick<Stats, "dev" | "ino" | "mode">,
  right: Pick<Stats, "dev" | "ino" | "mode">,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function preciseFileIdentity(
  value: Pick<BigIntStats, "dev" | "ino" | "mode">,
): BoundReadIdentity {
  return {
    dev: value.dev.toString(10),
    ino: value.ino.toString(10),
    mode: value.mode.toString(10),
  };
}

function samePreciseFileIdentity(
  left: BoundReadIdentity,
  right: BoundReadIdentity,
): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

interface BoundFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface BoundReadIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}

interface BoundHelperMessage {
  readonly type: "ready" | "effect_start" | "result";
  readonly ok?: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly identity?: BoundFileIdentity;
  readonly readIdentity?: BoundReadIdentity;
  readonly stats?: WorkspaceBoundReadFileStats;
  readonly contentBase64?: string;
  readonly binarySampleBase64?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly totalLines?: number;
  readonly numLines?: number;
  readonly stdoutBase64?: string;
  readonly stderrBase64?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly killedAfterLimit?: boolean;
  readonly stopReason?: WorkspaceBoundProcessStopReason;
  readonly spawnError?: string;
}

const BOUND_READ_WORKER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const identity = (value) => ({
  dev: value.dev.toString(10),
  ino: value.ino.toString(10),
  mode: value.mode.toString(10),
});
const fileStats = (value) => ({
  ...identity(value),
  size: Number(value.size),
  mtimeMs: Number(value.mtimeMs),
  ctimeMs: Number(value.ctimeMs),
});
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
const validSegment = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\");
const noFollow =
  commandLineNoFollowEnabled() && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
function commandLineNoFollowEnabled() {
  return process.env.AGENC_BOUND_READ_USE_NOFOLLOW !== "0";
}
delete process.env.AGENC_BOUND_READ_USE_NOFOLLOW;
let activeChild = null;
const stopActiveChildAndExit = () => {
  if (activeChild === null) process.exit(143);
  const child = activeChild;
  child.once("close", () => process.exit(143));
  child.kill();
  const forced = setTimeout(() => child.kill("SIGKILL"), 500);
  forced.unref();
};
process.once("SIGTERM", stopActiveChildAndExit);
process.once("SIGINT", stopActiveChildAndExit);

const readCommand = async () => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
};
const openVerifiedBasename = async (command) => {
  if (
    !Array.isArray(command.parentSegments) ||
    !command.parentSegments.every(validSegment) ||
    !validSegment(command.name)
  ) {
    throw Object.assign(new Error("invalid capability-relative path"), {
      code: "INVALID_PATH",
    });
  }
  if (
    !sameIdentity(
      identity(await stat(".", { bigint: true })),
      command.rootIdentity,
    )
  ) {
    throw Object.assign(new Error("bound root identity changed"), {
      code: "PATH_IDENTITY_CHANGED",
    });
  }
  for (const segment of command.parentSegments) {
    const before = await lstat(segment, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw Object.assign(
        new Error("relative read parent is not a real directory"),
        { code: "PATH_IDENTITY_CHANGED" },
      );
    }
    process.chdir(segment);
    const entered = await stat(".", { bigint: true });
    if (!sameIdentity(identity(before), identity(entered))) {
      throw Object.assign(
        new Error("relative read parent changed during traversal"),
        { code: "PATH_IDENTITY_CHANGED" },
      );
    }
  }
  const leafBefore = await lstat(command.name, { bigint: true });
  if (!leafBefore.isFile() || leafBefore.isSymbolicLink()) {
    throw Object.assign(new Error("read target is not a real regular file"), {
      code: "PATH_IDENTITY_CHANGED",
    });
  }
  const beforeIdentity = identity(leafBefore);
  const handle = await open(command.name, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const expectedIdentity = command.expectedIdentity ?? null;
    if (
      !opened.isFile() ||
      !sameIdentity(identity(opened), beforeIdentity) ||
      (expectedIdentity !== null &&
        !sameIdentity(identity(opened), expectedIdentity))
    ) {
      throw Object.assign(new Error("read target identity changed"), {
        code: "PATH_IDENTITY_CHANGED",
      });
    }
    const leaf = await lstat(command.name, { bigint: true });
    if (
      leaf.isSymbolicLink() ||
      !sameIdentity(identity(leaf), identity(opened))
    ) {
      throw Object.assign(new Error("read target identity changed"), {
        code: "PATH_IDENTITY_CHANGED",
      });
    }
    return { handle, stats: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
const runPinnedRipgrep = async (command, inputHandle) => {
  if (
    typeof command.program !== "string" ||
    command.program.length === 0 ||
    command.program.includes("\0") ||
    !Array.isArray(command.args) ||
    !command.args.every((value) => typeof value === "string") ||
    command.args.some((value) => value === "--follow" || value === "-L")
  ) {
    throw Object.assign(new Error("invalid pinned ripgrep command"), {
      code: "INVALID_COMMAND",
    });
  }
  const timeoutMs = Number(command.timeoutMs);
  const maxOutputBytes = Number(command.maxOutputBytes);
  const lineLimit =
    command.lineLimit === undefined ? null : Number(command.lineLimit);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    (lineLimit !== null &&
      (!Number.isSafeInteger(lineLimit) || lineLimit < 1))
  ) {
    throw Object.assign(new Error("invalid pinned ripgrep limits"), {
      code: "INVALID_COMMAND",
    });
  }
  const commandEnv =
    command.env !== null &&
    typeof command.env === "object" &&
    !Array.isArray(command.env) &&
    Object.values(command.env).every((value) => typeof value === "string")
      ? command.env
      : {};
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let capturedBytes = 0;
  let totalOutputBytes = 0;
  let stdoutLines = 0;
  let killedAfterLimit = false;
  let stopReason;
  let spawnError;
  const append = (current, chunk) => {
    const remaining = Math.max(0, maxOutputBytes - capturedBytes);
    const captured = chunk.subarray(0, remaining);
    capturedBytes += captured.length;
    return captured.length === 0
      ? current
      : Buffer.concat([current, captured]);
  };
  const child = spawn(command.program, command.args, {
    cwd: ".",
    env: commandEnv,
    windowsHide: true,
    stdio: [inputHandle.fd, "pipe", "pipe"],
  });
  activeChild = child;
  const timeout = setTimeout(() => {
    if (stopReason !== undefined) return;
    stopReason = "timeout";
    child.kill();
  }, timeoutMs);
  timeout.unref();
  child.stdout.on("data", (rawChunk) => {
    const chunk = Buffer.from(rawChunk);
    totalOutputBytes += chunk.length;
    stdout = append(stdout, chunk);
    if (lineLimit !== null && !killedAfterLimit) {
      for (const byte of chunk) {
        if (byte === 10) stdoutLines += 1;
      }
      if (stdoutLines >= lineLimit) {
        killedAfterLimit = true;
        child.kill();
      }
    }
    if (totalOutputBytes > maxOutputBytes && stopReason === undefined) {
      stopReason = "output_limit";
      child.kill();
    }
  });
  child.stderr.on("data", (rawChunk) => {
    const chunk = Buffer.from(rawChunk);
    totalOutputBytes += chunk.length;
    stderr = append(stderr, chunk);
    if (totalOutputBytes > maxOutputBytes && stopReason === undefined) {
      stopReason = "output_limit";
      child.kill();
    }
  });
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error.message : String(error);
  });
  const closed = await new Promise((resolveClose) => {
    child.once("close", (exitCode, signal) =>
      resolveClose({ exitCode, signal }),
    );
  });
  clearTimeout(timeout);
  activeChild = null;
  return {
    type: "result",
    ok: true,
    stdoutBase64: stdout.toString("base64"),
    stderrBase64: stderr.toString("base64"),
    exitCode: closed.exitCode,
    signal: closed.signal,
    killedAfterLimit,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(spawnError === undefined ? {} : { spawnError }),
  };
};

try {
  const command = await readCommand();
  const opened = await openVerifiedBasename(command);
  try {
    const stats = fileStats(opened.stats);
    if (command.operation === "validate_regular_file") {
      send({ type: "result", ok: true, stats });
    } else if (command.operation === "read_regular_file") {
      const maxBytes = Number(command.maxBytes);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw Object.assign(new Error("invalid read byte limit"), {
          code: "INVALID_COMMAND",
        });
      }
      if (opened.stats.size > maxBytes && command.truncate !== true) {
        send({
          type: "result",
          ok: false,
          code: "FILE_TOO_LARGE",
          message: "bound file exceeds the requested byte limit",
          stats,
        });
      } else {
        let content;
        if (command.truncate === true && opened.stats.size > maxBytes) {
          content = Buffer.alloc(maxBytes);
          const read = await opened.handle.read(
            content,
            0,
            content.length,
            0,
          );
          content = content.subarray(0, read.bytesRead);
        } else {
          content = await opened.handle.readFile();
        }
        send({
          type: "result",
          ok: true,
          stats,
          contentBase64: content.toString("base64"),
        });
      }
    } else if (command.operation === "read_text_window") {
      const maxBytes = Number(command.maxBytes);
      const offset = Number(command.offset);
      const limit = Number(command.limit);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      ) {
        throw Object.assign(new Error("invalid text window"), {
          code: "INVALID_COMMAND",
        });
      }
      const sampleBuffer = Buffer.alloc(Math.min(8192, opened.stats.size));
      const sampleRead =
        sampleBuffer.length === 0
          ? { bytesRead: 0 }
          : await opened.handle.read(
              sampleBuffer,
              0,
              sampleBuffer.length,
              0,
            );
      const selected = [];
      let totalLines = 0;
      const input = opened.handle.createReadStream({
        encoding: "utf8",
        autoClose: false,
        start: 0,
      });
      const reader = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          totalLines += 1;
          if (totalLines >= offset && selected.length < limit) {
            selected.push(line);
          }
          if (selected.length >= limit) break;
        }
      } finally {
        reader.close();
        input.destroy();
      }
      const content = selected.join("\n");
      if (Buffer.byteLength(content, "utf8") > maxBytes) {
        send({
          type: "result",
          ok: false,
          code: "FILE_TOO_LARGE",
          message: "bound text window exceeds the requested byte limit",
          stats,
        });
      } else {
        const endLine =
          selected.length > 0
            ? offset + selected.length - 1
            : Math.max(offset, Math.min(totalLines, offset + limit - 1));
        send({
          type: "result",
          ok: true,
          stats,
          contentBase64: Buffer.from(content, "utf8").toString("base64"),
          binarySampleBase64: sampleBuffer
            .subarray(0, sampleRead.bytesRead)
            .toString("base64"),
          startLine: offset,
          endLine,
          totalLines,
          numLines: selected.length,
        });
      }
    } else if (command.operation === "run_pinned_rg") {
      send(await runPinnedRipgrep(command, opened.handle));
    } else {
      throw Object.assign(new Error("unsupported bound read operation"), {
        code: "INVALID_COMMAND",
      });
    }
  } finally {
    await opened.handle.close();
  }
} catch (error) {
  send({
    type: "result",
    ok: false,
    code: error?.code ?? "HELPER_FAILED",
    message: error instanceof Error ? error.message : String(error),
  });
}
`;

const BOUND_DIRECTORY_HELPER_SOURCE = String.raw`
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const identity = (value) => ({
  dev: value.dev,
  ino: value.ino,
  mode: value.mode,
});
const preciseIdentity = (value) => ({
  dev: value.dev.toString(10),
  ino: value.ino.toString(10),
  mode: value.mode.toString(10),
});
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
const fail = (code, error) => {
  send({
    type: "result",
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
  });
};
const validSegment = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\");
const noFollow = constants.O_NOFOLLOW ?? 0;
const boundReadWorkerSource = Buffer.from(
  process.env.AGENC_BOUND_READ_WORKER_SOURCE_BASE64 ?? "",
  "base64",
).toString("utf8");
delete process.env.AGENC_BOUND_READ_WORKER_SOURCE_BASE64;
const boundReadUseNoFollow =
  process.env.AGENC_BOUND_READ_USE_NOFOLLOW !== "0";
delete process.env.AGENC_BOUND_READ_USE_NOFOLLOW;
let targetParentBound = false;
let effectStarted = false;
let boundDirectoryIdentity;
let boundReadDirectoryIdentity;
let activeChild = null;
const announceEffect = () => {
  if (effectStarted) return;
  effectStarted = true;
  send({ type: "effect_start" });
};
const fileStats = (value) => ({
  ...identity(value),
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
});
const validSegments = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(validSegment);
const stopActiveChildAndExit = () => {
  if (activeChild === null) process.exit(143);
  const child = activeChild;
  child.once("close", () => process.exit(143));
  child.kill();
  const forced = setTimeout(() => child.kill("SIGKILL"), 500);
  forced.unref();
};
process.once("SIGTERM", stopActiveChildAndExit);
process.once("SIGINT", stopActiveChildAndExit);
const runBoundReadWorker = async (command) => {
  if (boundReadWorkerSource.length === 0) {
    throw Object.assign(new Error("bound read worker source is unavailable"), {
      code: "CAPABILITY_UNAVAILABLE",
    });
  }
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", boundReadWorkerSource],
    {
      cwd: ".",
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        AGENC_BOUND_READ_USE_NOFOLLOW: boundReadUseNoFollow ? "1" : "0",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  activeChild = child;
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  const maxWorkerOutputBytes = 96 * 1024 * 1024;
  const capture = (target, rawChunk) => {
    const chunk = Buffer.from(rawChunk);
    outputBytes += chunk.length;
    if (outputBytes > maxWorkerOutputBytes) {
      child.kill();
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", (chunk) => capture(stdout, chunk));
  child.stderr.on("data", (chunk) => capture(stderr, chunk));
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdin.end(JSON.stringify({
    ...command,
    rootIdentity: boundReadDirectoryIdentity,
  }));
  const closed = await new Promise((resolveClose) => {
    child.once("close", (exitCode, signal) =>
      resolveClose({ exitCode, signal }),
    );
  });
  activeChild = null;
  if (spawnError !== undefined) throw spawnError;
  if (outputBytes > maxWorkerOutputBytes) {
    throw Object.assign(new Error("bound read worker output exceeded limit"), {
      code: "OUTPUT_LIMIT",
    });
  }
  const rendered = Buffer.concat(stdout).toString("utf8").trim();
  if (closed.exitCode !== 0 || rendered.length === 0) {
    throw Object.assign(
      new Error(
        "bound read worker failed (" +
          (closed.signal ?? closed.exitCode ?? "unknown") +
          ")" +
          (stderr.length === 0
            ? ""
            : ": " + Buffer.concat(stderr).toString("utf8").slice(0, 4096)),
      ),
      { code: "CAPABILITY_UNAVAILABLE" },
    );
  }
  const lines = rendered.split(/\r?\n/u);
  return JSON.parse(lines[lines.length - 1]);
};

try {
  boundDirectoryIdentity = identity(await stat("."));
  boundReadDirectoryIdentity = preciseIdentity(
    await stat(".", { bigint: true }),
  );
  send({
    type: "ready",
    identity: boundDirectoryIdentity,
    readIdentity: boundReadDirectoryIdentity,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let command;
    try {
      command = JSON.parse(line);
    } catch (error) {
      fail("INVALID_COMMAND", error);
      continue;
    }
    if (command?.type === "close") process.exit(0);
    if (command?.type !== "mutate") {
      fail("INVALID_COMMAND", "unsupported helper command");
      continue;
    }
    effectStarted = false;
    try {
      if (
        !sameIdentity(identity(await stat(".")), boundDirectoryIdentity)
      ) {
        throw Object.assign(
          new Error("bound working-directory identity changed"),
          { code: "PATH_IDENTITY_CHANGED" },
        );
      }
      if (command.operation === "bind_read_directory") {
        if (
          !Array.isArray(command.relativeSegments) ||
          !command.relativeSegments.every(validSegment) ||
          command.expectedReadIdentity === null ||
          typeof command.expectedReadIdentity !== "object"
        ) {
          throw Object.assign(new Error("invalid bound read directory"), {
            code: "INVALID_PATH",
          });
        }
        for (const segment of command.relativeSegments) {
          const before = await lstat(segment, { bigint: true });
          if (!before.isDirectory() || before.isSymbolicLink()) {
            throw Object.assign(
              new Error("bound read parent is not a real directory"),
              { code: "PATH_IDENTITY_CHANGED" },
            );
          }
          process.chdir(segment);
          const entered = await stat(".", { bigint: true });
          if (
            !sameIdentity(preciseIdentity(before), preciseIdentity(entered))
          ) {
            throw Object.assign(
              new Error("bound read parent changed during traversal"),
              { code: "PATH_IDENTITY_CHANGED" },
            );
          }
        }
        const admitted = await stat(".", { bigint: true });
        const admittedIdentity = preciseIdentity(admitted);
        if (
          !admitted.isDirectory() ||
          !sameIdentity(admittedIdentity, command.expectedReadIdentity)
        ) {
          throw Object.assign(
            new Error("bound read directory identity changed"),
            { code: "PATH_IDENTITY_CHANGED" },
          );
        }
        boundDirectoryIdentity = identity(await stat("."));
        boundReadDirectoryIdentity = admittedIdentity;
        send({
          type: "result",
          ok: true,
          readIdentity: admittedIdentity,
        });
        continue;
      }
      if (!targetParentBound) {
        if (
          !Array.isArray(command.parentSegments) ||
          !command.parentSegments.every(validSegment)
        ) {
          throw Object.assign(new Error("invalid relative parent path"), {
            code: "INVALID_PATH",
          });
        }
        for (const segment of command.parentSegments) {
          let before;
          try {
            before = await lstat(segment);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            announceEffect();
            try {
              await mkdir(segment);
            } catch (mkdirError) {
              if (mkdirError?.code !== "EEXIST") throw mkdirError;
            }
            before = await lstat(segment);
          }
          if (!before.isDirectory() || before.isSymbolicLink()) {
            throw Object.assign(
              new Error("relative parent segment is not a real directory"),
              { code: "PATH_IDENTITY_CHANGED" },
            );
          }
          process.chdir(segment);
          const entered = await stat(".");
          if (!sameIdentity(identity(before), identity(entered))) {
            throw Object.assign(
              new Error("relative parent identity changed during traversal"),
              { code: "PATH_IDENTITY_CHANGED" },
            );
          }
          boundDirectoryIdentity = identity(entered);
        }
        targetParentBound = true;
      }
      if (!validSegment(command.name)) {
        throw Object.assign(new Error("invalid target basename"), {
          code: "INVALID_PATH",
        });
      }
      const expectedIdentity = command.expectedIdentity ?? null;
      const expectedContent =
        command.expectedKind === "content"
          ? Buffer.from(command.expectedContentBase64 ?? "", "base64")
          : null;

      if (
        command.operation === "read_regular_file" ||
        command.operation === "validate_regular_file" ||
        command.operation === "read_text_window"
      ) {
        if (!validSegments(command.relativeSegments)) {
          throw Object.assign(new Error("invalid relative read path"), {
            code: "INVALID_PATH",
          });
        }
        const segments = command.relativeSegments;
        send(
          await runBoundReadWorker({
            ...command,
            parentSegments: segments.slice(0, -1),
            name: segments[segments.length - 1],
          }),
        );
        continue;
      }

      if (command.operation === "run_pinned_rg") {
        if (command.relativeInputSegments !== undefined) {
          if (!validSegments(command.relativeInputSegments)) {
            throw Object.assign(
              new Error("invalid capability-relative ripgrep input"),
              { code: "INVALID_PATH" },
            );
          }
          const segments = command.relativeInputSegments;
          send(
            await runBoundReadWorker({
              ...command,
              parentSegments: segments.slice(0, -1),
              name: segments[segments.length - 1],
            }),
          );
          continue;
        }
        if (
          typeof command.program !== "string" ||
          command.program.length === 0 ||
          command.program.includes("\0") ||
          !Array.isArray(command.args) ||
          !command.args.every((value) => typeof value === "string") ||
          command.args.some(
            (value) => value === "--follow" || value === "-L",
          )
        ) {
          throw Object.assign(new Error("invalid pinned ripgrep command"), {
            code: "INVALID_COMMAND",
          });
        }
        const timeoutMs = Number(command.timeoutMs);
        const maxOutputBytes = Number(command.maxOutputBytes);
        const lineLimit =
          command.lineLimit === undefined
            ? null
            : Number(command.lineLimit);
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          !Number.isSafeInteger(maxOutputBytes) ||
          maxOutputBytes < 1 ||
          (lineLimit !== null &&
            (!Number.isSafeInteger(lineLimit) || lineLimit < 1))
        ) {
          throw Object.assign(new Error("invalid pinned ripgrep limits"), {
            code: "INVALID_COMMAND",
          });
        }
        const commandEnv =
          command.env !== null &&
          typeof command.env === "object" &&
          !Array.isArray(command.env) &&
          Object.values(command.env).every(
            (value) => typeof value === "string",
          )
            ? command.env
            : {};
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let totalOutputBytes = 0;
        let stdoutLines = 0;
        let killedAfterLimit = false;
        let stopReason;
        let spawnError;
        const append = (current, chunk) => {
          const remaining = Math.max(0, maxOutputBytes - current.length);
          return remaining === 0
            ? current
            : Buffer.concat([current, chunk.subarray(0, remaining)]);
        };
        try {
          const child = spawn(command.program, command.args, {
            cwd: ".",
            env: commandEnv,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          activeChild = child;
          const timeout = setTimeout(() => {
            if (stopReason !== undefined) return;
            stopReason = "timeout";
            child.kill();
          }, timeoutMs);
          timeout.unref();
          child.stdout.on("data", (rawChunk) => {
            const chunk = Buffer.from(rawChunk);
            totalOutputBytes += chunk.length;
            stdout = append(stdout, chunk);
            if (lineLimit !== null && !killedAfterLimit) {
              for (const byte of chunk) {
                if (byte === 10) stdoutLines += 1;
              }
              if (stdoutLines >= lineLimit) {
                killedAfterLimit = true;
                child.kill();
              }
            }
            if (
              totalOutputBytes > maxOutputBytes &&
              stopReason === undefined
            ) {
              stopReason = "output_limit";
              child.kill();
            }
          });
          child.stderr.on("data", (rawChunk) => {
            const chunk = Buffer.from(rawChunk);
            totalOutputBytes += chunk.length;
            stderr = append(stderr, chunk);
            if (
              totalOutputBytes > maxOutputBytes &&
              stopReason === undefined
            ) {
              stopReason = "output_limit";
              child.kill();
            }
          });
          child.once("error", (error) => {
            spawnError =
              error instanceof Error ? error.message : String(error);
          });
          const stdin =
            typeof command.stdinBase64 === "string"
              ? Buffer.from(command.stdinBase64, "base64")
              : null;
          child.stdin.end(stdin ?? undefined);
          const closed = await new Promise((resolveClose) => {
            child.once("close", (exitCode, signal) =>
              resolveClose({ exitCode, signal }),
            );
          });
          clearTimeout(timeout);
          activeChild = null;
          send({
            type: "result",
            ok: true,
            stdoutBase64: stdout.toString("base64"),
            stderrBase64: stderr.toString("base64"),
            exitCode: closed.exitCode,
            signal: closed.signal,
            killedAfterLimit,
            ...(stopReason === undefined ? {} : { stopReason }),
            ...(spawnError === undefined ? {} : { spawnError }),
          });
        } finally {
          activeChild = null;
        }
        continue;
      }

      if (command.operation === "remove_symlink") {
        const before = await lstat(command.name);
        if (
          !before.isSymbolicLink() ||
          expectedIdentity === null ||
          !sameIdentity(identity(before), expectedIdentity) ||
          (await readlink(command.name)) !== command.expectedLinkTarget
        ) {
          throw Object.assign(new Error("symlink identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        const after = await lstat(command.name);
        if (
          !after.isSymbolicLink() ||
          !sameIdentity(identity(before), identity(after))
        ) {
          throw Object.assign(new Error("symlink identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        announceEffect();
        await unlink(command.name);
        send({ type: "result", ok: true });
        continue;
      }

      if (command.operation === "remove_directory") {
        const before = await lstat(command.name);
        if (
          !before.isDirectory() ||
          before.isSymbolicLink() ||
          expectedIdentity === null ||
          !sameIdentity(identity(before), expectedIdentity)
        ) {
          throw Object.assign(new Error("directory identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        const quarantineName = ".agenc-delete-" + randomUUID();
        announceEffect();
        await rename(command.name, quarantineName);
        const moved = await lstat(quarantineName);
        if (
          !moved.isDirectory() ||
          moved.isSymbolicLink() ||
          !sameIdentity(identity(moved), expectedIdentity)
        ) {
          throw Object.assign(
            new Error("quarantined directory identity changed"),
            { code: "PATH_IDENTITY_CHANGED" },
          );
        }
        await rm(quarantineName, {
          recursive: true,
          force: false,
          maxRetries: 2,
        });
        send({ type: "result", ok: true });
        continue;
      }

      if (command.operation === "rename_regular_file") {
        if (!validSegment(command.targetName)) {
          throw Object.assign(new Error("invalid rename target basename"), {
            code: "INVALID_PATH",
          });
        }
        let sourceHandle;
        let sourceIdentity;
        try {
          sourceHandle = await open(
            command.name,
            constants.O_RDONLY | noFollow,
          );
          const sourceStats = await sourceHandle.stat();
          sourceIdentity = identity(sourceStats);
          const sourceContent = await sourceHandle.readFile();
          const sourceSha256 = createHash("sha256")
            .update(sourceContent)
            .digest("hex");
          if (
            !sourceStats.isFile() ||
            expectedIdentity === null ||
            !sameIdentity(sourceIdentity, expectedIdentity) ||
            sourceStats.size !== command.expectedSize ||
            sourceStats.mtimeMs !== command.expectedMtimeMs ||
            sourceStats.ctimeMs !== command.expectedCtimeMs ||
            sourceSha256 !== command.expectedContentSha256
          ) {
            throw Object.assign(new Error("rename source identity changed"), {
              code: "PATH_IDENTITY_CHANGED",
            });
          }
        } finally {
          await sourceHandle?.close();
        }
        try {
          await lstat(command.targetName);
          throw Object.assign(new Error("rename target already exists"), {
            code: "EEXIST",
          });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const quarantineName = ".agenc-rename-" + randomUUID();
        announceEffect();
        await link(command.name, quarantineName);
        const moved = await lstat(quarantineName);
        if (!sameIdentity(identity(moved), sourceIdentity)) {
          await unlink(quarantineName);
          throw Object.assign(new Error("rename source identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        const sourceBeforeUnlink = await lstat(command.name);
        if (!sameIdentity(identity(sourceBeforeUnlink), sourceIdentity)) {
          await unlink(quarantineName);
          throw Object.assign(new Error("rename source identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        await unlink(command.name);
        try {
          await link(quarantineName, command.targetName);
        } catch (error) {
          let sourceWasRestored = false;
          try {
            await link(quarantineName, command.name);
            await unlink(quarantineName);
            sourceWasRestored = true;
          } catch {
            // Exclusive hard-link restoration refuses to overwrite a source
            // name concurrently republished by another actor.
          }
          if (!sourceWasRestored) {
            throw Object.assign(
              new Error(
                "rename target publication failed and source restoration was not safe",
              ),
              { code: "PATH_IDENTITY_CHANGED" },
            );
          }
          throw error;
        }
        await unlink(quarantineName);
        send({
          type: "result",
          ok: true,
          identity: identity(await lstat(command.targetName)),
        });
        continue;
      }

      if (command.operation === "write" && command.expectedKind === "missing") {
        announceEffect();
        let handle;
        try {
          handle = await open(
            command.name,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_RDWR |
              noFollow,
            0o666,
          );
          const content = Buffer.from(command.contentBase64 ?? "", "base64");
          let offset = 0;
          while (offset < content.length) {
            const result = await handle.write(
              content,
              offset,
              content.length - offset,
              offset,
            );
            if (result.bytesWritten <= 0) {
              throw new Error("exclusive write made no progress");
            }
            offset += result.bytesWritten;
          }
          send({
            type: "result",
            ok: true,
            identity: identity(await handle.stat()),
          });
        } finally {
          await handle?.close();
        }
        continue;
      }

      let handle;
      try {
        handle = await open(command.name, constants.O_RDONLY | noFollow);
        const currentIdentity = identity(await handle.stat());
        if (
          expectedIdentity === null ||
          !sameIdentity(currentIdentity, expectedIdentity)
        ) {
          throw Object.assign(new Error("target identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        const current = await handle.readFile();
        if (
          expectedContent === null ||
          !current.equals(expectedContent)
        ) {
          throw Object.assign(new Error("target bytes changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        if (command.operation !== "remove") {
          throw Object.assign(new Error("unsupported bound operation"), {
            code: "INVALID_COMMAND",
          });
        }
        // Keep the verified target descriptor open through unlink. POSIX does
        // not expose unlinkat(2) in Node, so an adversarial same-directory leaf
        // exchange remains detectable only up to this boundary; the pinned cwd
        // still makes an ancestor exchange incapable of reaching outside.
        const leafBeforeUnlink = await lstat(command.name);
        if (
          leafBeforeUnlink.isSymbolicLink() ||
          !sameIdentity(identity(leafBeforeUnlink), currentIdentity)
        ) {
          throw Object.assign(new Error("target identity changed"), {
            code: "PATH_IDENTITY_CHANGED",
          });
        }
        announceEffect();
        await unlink(command.name);
        send({ type: "result", ok: true });
      } finally {
        await handle?.close();
      }
    } catch (error) {
      fail(error?.code ?? "HELPER_FAILED", error);
    }
  }
} catch (error) {
  fail(error?.code ?? "HELPER_START_FAILED", error);
}
`;

class BoundDirectoryHelper {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #anchorPath: string;
  readonly #messages: BoundHelperMessage[] = [];
  readonly #waiters: Array<{
    readonly resolve: (message: BoundHelperMessage) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #stderr = "";
  #closed = false;
  #parentBound = false;
  #readRootPath: string;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    anchorPath: string,
  ) {
    this.#child = child;
    this.#anchorPath = anchorPath;
    this.#readRootPath = anchorPath;
    const lines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      let message: BoundHelperMessage;
      try {
        message = JSON.parse(line) as BoundHelperMessage;
      } catch {
        this.#rejectWaiters(
          new Error("directory-binding helper returned invalid output"),
        );
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(message);
      else waiter.resolve(message);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.#stderr.length >= 4096) return;
      this.#stderr += String(chunk).slice(0, 4096 - this.#stderr.length);
    });
    child.once("error", (error) => this.#rejectWaiters(error));
    child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#rejectWaiters(
        new Error(
          `directory-binding helper exited before completing the mutation (${signal ?? code ?? "unknown"})${
            this.#stderr.length > 0 ? `: ${this.#stderr}` : ""
          }`,
        ),
      );
    });
  }

  static async start(
    identity: WorkspacePathIdentity,
    expectedReadRootIdentity?: BoundReadIdentity,
    useNoFollow = true,
  ): Promise<BoundDirectoryHelper> {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", BOUND_DIRECTORY_HELPER_SOURCE],
      {
        cwd: identity.anchorPath,
        env: {
          ...scrubEnvForChildProcess(process.env),
          NODE_OPTIONS: "",
          NODE_PATH: "",
          AGENC_BOUND_READ_WORKER_SOURCE_BASE64: Buffer.from(
            BOUND_READ_WORKER_SOURCE,
            "utf8",
          ).toString("base64"),
          AGENC_BOUND_READ_USE_NOFOLLOW:
            useNoFollow &&
            typeof constants.O_NOFOLLOW === "number" &&
            constants.O_NOFOLLOW !== 0
              ? "1"
              : "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const helper = new BoundDirectoryHelper(child, identity.anchorPath);
    try {
      const ready = await helper.#nextMessage();
      if (
        ready.type !== "ready" ||
        ready.identity === undefined ||
        ready.identity.dev !== identity.anchorDev ||
        ready.identity.ino !== identity.anchorIno ||
        ready.identity.mode !== identity.anchorMode ||
        (expectedReadRootIdentity !== undefined &&
          (ready.readIdentity === undefined ||
            !samePreciseFileIdentity(
              ready.readIdentity,
              expectedReadRootIdentity,
            )))
      ) {
        throw new WorkspacePathIdentityChangedError(identity.expectedPath);
      }
      return helper;
    } catch (error) {
      await helper.dispose();
      throw error;
    }
  }

  async bindReadDirectory(input: {
    readonly directoryPath: string;
    readonly expectedIdentity: BoundReadIdentity;
  }): Promise<void> {
    const relativeDirectory = relative(this.#anchorPath, input.directoryPath);
    const relativeSegments =
      relativeDirectory.length === 0
        ? []
        : relativeDirectory.split(pathSeparator);
    if (
      relativeSegments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      throw new WorkspacePathIdentityChangedError(input.directoryPath);
    }
    const message = await this.#runMutation(
      {
        type: "mutate",
        operation: "bind_read_directory",
        name: "__agenc_bound_read__",
        parentSegments: [],
        expectedKind: "directory",
        expectedIdentity: null,
        expectedReadIdentity: input.expectedIdentity,
        relativeSegments,
      },
      input.directoryPath,
    );
    if (
      message.readIdentity === undefined ||
      !samePreciseFileIdentity(message.readIdentity, input.expectedIdentity)
    ) {
      throw new WorkspacePathIdentityChangedError(input.directoryPath);
    }
    this.#readRootPath = input.directoryPath;
  }

  async mutate(input: {
    readonly pathIdentity: WorkspacePathIdentity;
    readonly expectedIdentity: BoundFileIdentity | null;
    readonly expected: WorkspaceFilePathExpectedState;
    readonly operation: "write" | "remove";
    readonly content?: Buffer;
    readonly onEffectStart?: () => void;
  }): Promise<BoundFileIdentity | null> {
    const message = await this.#runMutation(
      {
        type: "mutate",
        operation: input.operation,
        name: basename(input.pathIdentity.expectedPath),
        parentSegments: this.#parentSegments(input.pathIdentity),
        expectedKind: input.expected.kind,
        ...(input.expected.kind === "content"
          ? { expectedContentBase64: input.expected.content.toString("base64") }
          : {}),
        expectedIdentity: input.expectedIdentity,
        ...(input.content !== undefined
          ? { contentBase64: input.content.toString("base64") }
          : {}),
      },
      input.pathIdentity.expectedPath,
      input.onEffectStart,
    );
    this.#parentBound = true;
    return message.identity ?? null;
  }

  async removeSymlink(input: {
    readonly pathIdentity: WorkspacePathIdentity;
    readonly expectedIdentity: BoundFileIdentity;
    readonly expectedLinkTarget: string;
    readonly onEffectStart?: () => void;
  }): Promise<void> {
    await this.#runMutation(
      {
        type: "mutate",
        operation: "remove_symlink",
        name: basename(input.pathIdentity.expectedPath),
        parentSegments: this.#parentSegments(input.pathIdentity),
        expectedKind: "symlink",
        expectedIdentity: input.expectedIdentity,
        expectedLinkTarget: input.expectedLinkTarget,
      },
      input.pathIdentity.expectedPath,
      input.onEffectStart,
    );
    this.#parentBound = true;
  }

  async removeDirectory(input: {
    readonly pathIdentity: WorkspacePathIdentity;
    readonly expectedIdentity: BoundFileIdentity;
    readonly onEffectStart?: () => void;
  }): Promise<void> {
    await this.#runMutation(
      {
        type: "mutate",
        operation: "remove_directory",
        name: basename(input.pathIdentity.expectedPath),
        parentSegments: this.#parentSegments(input.pathIdentity),
        expectedKind: "directory",
        expectedIdentity: input.expectedIdentity,
      },
      input.pathIdentity.expectedPath,
      input.onEffectStart,
    );
    this.#parentBound = true;
  }

  async renameRegularFile(input: {
    readonly pathIdentity: WorkspacePathIdentity;
    readonly targetName: string;
    readonly expectedIdentity: BoundFileIdentity;
    readonly expectedSize: number;
    readonly expectedMtimeMs: number;
    readonly expectedCtimeMs: number;
    readonly expectedContentSha256: string;
    readonly onEffectStart?: () => void;
  }): Promise<BoundFileIdentity> {
    const message = await this.#runMutation(
      {
        type: "mutate",
        operation: "rename_regular_file",
        name: basename(input.pathIdentity.expectedPath),
        targetName: input.targetName,
        parentSegments: this.#parentSegments(input.pathIdentity),
        expectedKind: "file",
        expectedIdentity: input.expectedIdentity,
        expectedSize: input.expectedSize,
        expectedMtimeMs: input.expectedMtimeMs,
        expectedCtimeMs: input.expectedCtimeMs,
        expectedContentSha256: input.expectedContentSha256,
      },
      input.pathIdentity.expectedPath,
      input.onEffectStart,
    );
    this.#parentBound = true;
    if (message.identity === undefined) {
      throw new WorkspacePathIdentityChangedError(
        input.pathIdentity.expectedPath,
      );
    }
    return message.identity;
  }

  async readRelativeFile(input: {
    readonly relativePath: string;
    readonly expectedIdentity?: BoundReadIdentity;
    readonly maxBytes: number;
    readonly truncate?: boolean;
  }): Promise<WorkspaceBoundReadFile> {
    const relativeSegments = this.#relativeSegments(input.relativePath);
    const expectedPath = resolve(this.#readRootPath, ...relativeSegments);
    const message = await this.#runMutation(
      {
        type: "mutate",
        operation: "read_regular_file",
        name: relativeSegments.at(-1),
        parentSegments: [],
        expectedKind: "file",
        expectedIdentity: input.expectedIdentity ?? null,
        relativeSegments,
        maxBytes: input.maxBytes,
        ...(input.truncate === true ? { truncate: true } : {}),
      },
      expectedPath,
    );
    this.#parentBound = true;
    return this.#readFileResult(message, expectedPath);
  }

  async validateRelativeFile(input: {
    readonly relativePath: string;
    readonly expectedIdentity?: BoundReadIdentity;
  }): Promise<void> {
    const relativeSegments = this.#relativeSegments(input.relativePath);
    const expectedPath = resolve(this.#readRootPath, ...relativeSegments);
    await this.#runMutation(
      {
        type: "mutate",
        operation: "validate_regular_file",
        name: relativeSegments.at(-1),
        parentSegments: [],
        expectedKind: "file",
        expectedIdentity: input.expectedIdentity ?? null,
        relativeSegments,
      },
      expectedPath,
    );
    this.#parentBound = true;
  }

  async readTextWindow(input: {
    readonly relativePath: string;
    readonly expectedIdentity: BoundReadIdentity;
    readonly offset: number;
    readonly limit: number;
    readonly maxBytes: number;
  }): Promise<WorkspaceBoundTextWindow> {
    const relativeSegments = this.#relativeSegments(input.relativePath);
    const expectedPath = resolve(this.#readRootPath, ...relativeSegments);
    const message = await this.#runMutation(
      {
        type: "mutate",
        operation: "read_text_window",
        name: relativeSegments.at(-1),
        parentSegments: [],
        expectedKind: "file",
        expectedIdentity: input.expectedIdentity,
        relativeSegments,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
      },
      expectedPath,
    );
    this.#parentBound = true;
    if (
      message.stats === undefined ||
      message.contentBase64 === undefined ||
      message.binarySampleBase64 === undefined ||
      message.startLine === undefined ||
      message.endLine === undefined ||
      message.totalLines === undefined ||
      message.numLines === undefined
    ) {
      throw new WorkspacePathIdentityChangedError(expectedPath);
    }
    return {
      content: Buffer.from(message.contentBase64, "base64").toString("utf8"),
      binarySample: Buffer.from(message.binarySampleBase64, "base64"),
      startLine: message.startLine,
      endLine: message.endLine,
      totalLines: message.totalLines,
      numLines: message.numLines,
      isPartial: true,
      stats: message.stats,
    };
  }

  async runPinnedRipgrep(input: {
    readonly program: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly lineLimit?: number;
    readonly stdin?: string | Buffer;
    readonly relativeInputPath?: string;
    readonly expectedInputIdentity?: BoundReadIdentity;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceBoundRipgrepResult> {
    const isAborted = (): boolean => input.signal?.aborted === true;
    if (isAborted()) {
      return this.#abortedRipgrepResult();
    }
    const relativeInputSegments =
      input.relativeInputPath === undefined
        ? undefined
        : this.#relativeSegments(input.relativeInputPath);
    const expectedPath =
      relativeInputSegments === undefined
        ? this.#readRootPath
        : resolve(this.#readRootPath, ...relativeInputSegments);
    const abort = (): void => {
      this.#child.kill();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const message = await this.#runMutation(
        {
          type: "mutate",
          operation: "run_pinned_rg",
          name: relativeInputSegments?.at(-1) ?? "__agenc_rg__",
          parentSegments: [],
          expectedKind:
            relativeInputSegments === undefined ? "directory" : "file",
          expectedIdentity: input.expectedInputIdentity ?? null,
          program: input.program,
          args: [...input.args],
          env: { ...input.env },
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          ...(input.lineLimit !== undefined
            ? { lineLimit: input.lineLimit }
            : {}),
          ...(input.stdin !== undefined
            ? {
                stdinBase64: Buffer.from(input.stdin).toString("base64"),
              }
            : {}),
          ...(relativeInputSegments !== undefined
            ? { relativeInputSegments }
            : {}),
        },
        expectedPath,
      );
      this.#parentBound = true;
      return {
        stdout: Buffer.from(message.stdoutBase64 ?? "", "base64"),
        stderr: Buffer.from(message.stderrBase64 ?? "", "base64"),
        exitCode: message.exitCode ?? null,
        signal: message.signal ?? null,
        killedAfterLimit: message.killedAfterLimit === true,
        aborted: false,
        ...(message.stopReason !== undefined
          ? { stopReason: message.stopReason }
          : {}),
        ...(message.spawnError !== undefined
          ? { spawnError: new Error(message.spawnError) }
          : {}),
      };
    } catch (error) {
      if (isAborted()) {
        return this.#abortedRipgrepResult();
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  #readFileResult(
    message: BoundHelperMessage,
    expectedPath: string,
  ): WorkspaceBoundReadFile {
    if (message.stats === undefined || message.contentBase64 === undefined) {
      throw new WorkspacePathIdentityChangedError(expectedPath);
    }
    return {
      content: Buffer.from(message.contentBase64, "base64"),
      stats: message.stats,
    };
  }

  #abortedRipgrepResult(): WorkspaceBoundRipgrepResult {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      signal: null,
      killedAfterLimit: false,
      aborted: true,
      stopReason: "aborted",
    };
  }

  #relativeSegments(relativePath: string): readonly string[] {
    if (
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/u.test(relativePath)
    ) {
      throw new WorkspacePathIdentityChangedError(
        resolve(this.#anchorPath, relativePath),
      );
    }
    const segments = relativePath.replace(/\\/gu, "/").split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      throw new WorkspacePathIdentityChangedError(
        resolve(this.#readRootPath, relativePath),
      );
    }
    return segments;
  }

  #parentSegments(pathIdentity: WorkspacePathIdentity): readonly string[] {
    const relativeParent = relative(
      this.#anchorPath,
      dirname(pathIdentity.expectedPath),
    );
    const parentSegments = this.#parentBound
      ? []
      : relativeParent.length === 0
        ? []
        : relativeParent.split(pathSeparator);
    if (
      parentSegments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      throw new WorkspacePathIdentityChangedError(pathIdentity.expectedPath);
    }
    return parentSegments;
  }

  async #runMutation(
    command: Record<string, unknown>,
    expectedPath: string,
    onEffectStart?: () => void,
  ): Promise<BoundHelperMessage> {
    await this.#writeMessage(command);
    for (;;) {
      const message = await this.#nextMessage();
      if (message.type === "effect_start") {
        onEffectStart?.();
        continue;
      }
      if (message.type !== "result") {
        throw new Error("directory-binding helper protocol desynchronized");
      }
      if (message.ok !== true) {
        if (message.code === "FILE_TOO_LARGE") {
          throw new WorkspaceBoundReadFileTooLargeError(
            expectedPath,
            message.stats?.size ?? 0,
          );
        }
        if (message.code === "CAPABILITY_UNAVAILABLE") {
          throw new WorkspaceReadCapabilityUnavailableError(
            expectedPath,
            message.message,
          );
        }
        if (message.code === "EEXIST") {
          throw new WorkspaceFileMutationPreEffectConflictError(expectedPath);
        }
        if (
          message.code === "PATH_IDENTITY_CHANGED" ||
          message.code === "ENOENT" ||
          message.code === "ELOOP"
        ) {
          throw new WorkspacePathIdentityChangedError(expectedPath);
        }
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          `The identity-bound filesystem helper could not safely access ${expectedPath}: ${
            message.message ?? message.code ?? "unknown helper failure"
          }`,
        );
      }
      return message;
    }
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    const exited = once(this.#child, "exit");
    try {
      await this.#writeMessage({ type: "close" });
    } catch {
      this.#child.kill();
    }
    if (this.#closed) return;
    if ((await Promise.race([exited, this.#timeout(1_000)])) === "timeout") {
      this.#child.kill();
      if ((await Promise.race([exited, this.#timeout(500)])) === "timeout") {
        this.#child.kill("SIGKILL");
        if ((await Promise.race([exited, this.#timeout(500)])) === "timeout") {
          throw new Error(
            "directory-binding helper did not exit after forced termination",
          );
        }
      }
    }
  }

  async #writeMessage(value: unknown): Promise<void> {
    if (this.#closed || this.#child.stdin.destroyed) {
      throw new Error("directory-binding helper is not running");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error !== null && error !== undefined) rejectWrite(error);
        else resolveWrite();
      });
    });
  }

  #nextMessage(): Promise<BoundHelperMessage> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) {
      return Promise.reject(
        new Error("directory-binding helper is not running"),
      );
    }
    return new Promise<BoundHelperMessage>((resolveMessage, rejectMessage) => {
      this.#waiters.push({
        resolve: resolveMessage,
        reject: rejectMessage,
      });
    });
  }

  #rejectWaiters(error: Error): void {
    for (;;) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      waiter.reject(error);
    }
  }

  #timeout(milliseconds: number): Promise<"timeout"> {
    return new Promise<"timeout">((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout("timeout"), milliseconds);
      timer.unref();
    });
  }
}

/**
 * Bind one already-verified parent directory for Project Explorer topology
 * operations. Every command is basename-only inside the helper's pinned cwd;
 * callers retain their own higher-level workspace/topology admission checks.
 */
export async function bindWorkspaceDirectoryMutation(input: {
  readonly parent: WorkspaceBoundDirectoryIdentity;
  readonly targetPath: string;
}): Promise<WorkspaceBoundDirectoryMutation> {
  const targetPath = resolve(input.targetPath).normalize("NFC");
  if (dirname(targetPath) !== resolve(input.parent.path).normalize("NFC")) {
    throw new WorkspaceFileMutationPathBindingUnavailableError(targetPath);
  }
  const pathIdentity: WorkspacePathIdentity = {
    expectedPath: targetPath,
    targetExisted: true,
    anchorPath: input.parent.path,
    anchorRealPath: input.parent.path,
    anchorDev: input.parent.dev,
    anchorIno: input.parent.ino,
    anchorMode: input.parent.mode,
  };
  let helper: BoundDirectoryHelper;
  try {
    helper = await BoundDirectoryHelper.start(pathIdentity);
  } catch (error) {
    if (error instanceof WorkspacePathIdentityChangedError) throw error;
    throw new WorkspaceFileMutationPathBindingUnavailableError(
      targetPath,
      error,
    );
  }
  return {
    removeSymlink: (expected, linkTarget, onEffectStart) =>
      helper.removeSymlink({
        pathIdentity,
        expectedIdentity: expected,
        expectedLinkTarget: linkTarget,
        ...(onEffectStart !== undefined ? { onEffectStart } : {}),
      }),
    removeDirectory: (expected, onEffectStart) =>
      helper.removeDirectory({
        pathIdentity,
        expectedIdentity: expected,
        ...(onEffectStart !== undefined ? { onEffectStart } : {}),
      }),
    renameRegularFile: (targetName, expected, onEffectStart) =>
      helper.renameRegularFile({
        pathIdentity,
        targetName,
        expectedIdentity: expected,
        expectedSize: expected.size,
        expectedMtimeMs: expected.mtimeMs,
        expectedCtimeMs: expected.ctimeMs,
        expectedContentSha256: expected.contentSha256,
        ...(onEffectStart !== undefined ? { onEffectStart } : {}),
      }),
    dispose: () => helper.dispose(),
  };
}

let workspaceBoundReadNoFollowOverrideForTests: boolean | undefined;

/** Test-only seam for exercising the portable leaf-identity path. */
export function __setWorkspaceBoundReadNoFollowForTests(
  enabled: boolean | undefined,
): void {
  workspaceBoundReadNoFollowOverrideForTests = enabled;
}

function workspaceBoundReadCapability(input: {
  readonly helper: BoundDirectoryHelper;
  readonly rootPath: string;
  readonly exactFile?: {
    readonly relativePath: string;
    readonly identity: BoundReadIdentity;
  };
}): WorkspaceBoundReadCapability {
  const expectedIdentityFor = (
    relativePath: string,
  ): BoundReadIdentity | undefined =>
    input.exactFile?.relativePath === relativePath
      ? input.exactFile.identity
      : undefined;
  return {
    rootPath: input.rootPath,
    readRelativeFile: (relativePath, maxBytes, options) =>
      input.helper.readRelativeFile({
        relativePath,
        maxBytes,
        ...(options?.truncate === true ? { truncate: true } : {}),
        ...(expectedIdentityFor(relativePath) !== undefined
          ? { expectedIdentity: expectedIdentityFor(relativePath)! }
          : {}),
      }),
    validateRelativeFile: (relativePath) =>
      input.helper.validateRelativeFile({
        relativePath,
        ...(expectedIdentityFor(relativePath) !== undefined
          ? { expectedIdentity: expectedIdentityFor(relativePath)! }
          : {}),
      }),
    runRipgrep: (runInput) =>
      input.helper.runPinnedRipgrep({
        program: runInput.program,
        args: runInput.args,
        env: runInput.env,
        timeoutMs: runInput.timeoutMs,
        maxOutputBytes: runInput.maxOutputBytes,
        ...(runInput.lineLimit !== undefined
          ? { lineLimit: runInput.lineLimit }
          : {}),
        ...(runInput.stdin !== undefined ? { stdin: runInput.stdin } : {}),
        ...(runInput.relativeInputFile !== undefined
          ? {
              relativeInputPath: runInput.relativeInputFile,
              ...(expectedIdentityFor(runInput.relativeInputFile) !== undefined
                ? {
                    expectedInputIdentity: expectedIdentityFor(
                      runInput.relativeInputFile,
                    )!,
                  }
                : {}),
            }
          : {}),
        ...(runInput.signal !== undefined ? { signal: runInput.signal } : {}),
      }),
    dispose: () => input.helper.dispose(),
  };
}

async function preciseStats(path: string): Promise<BigIntStats> {
  return stat(path, { bigint: true });
}

async function bindReadDirectoryHelper(
  directoryPath: string,
): Promise<BoundDirectoryHelper> {
  const expectedPath = resolve(directoryPath).normalize("NFC");
  const admittedBefore = await preciseStats(expectedPath);
  if (!admittedBefore.isDirectory()) {
    throw new WorkspacePathIdentityChangedError(expectedPath);
  }
  const admittedIdentity = preciseFileIdentity(admittedBefore);
  const filesystemRoot = parsePath(expectedPath).root;
  if (filesystemRoot.length === 0) {
    throw new WorkspaceReadCapabilityUnavailableError(
      expectedPath,
      "filesystem root could not be resolved",
    );
  }

  const rootBefore = await preciseStats(filesystemRoot);
  const rootPathIdentity = await capturePathIdentity(filesystemRoot);
  const rootAfter = await preciseStats(filesystemRoot);
  const rootIdentity = preciseFileIdentity(rootAfter);
  if (
    !rootBefore.isDirectory() ||
    !rootAfter.isDirectory() ||
    !samePreciseFileIdentity(preciseFileIdentity(rootBefore), rootIdentity) ||
    !rootPathIdentity.targetExisted ||
    rootPathIdentity.anchorPath !== rootPathIdentity.expectedPath
  ) {
    throw new WorkspacePathIdentityChangedError(expectedPath);
  }

  const helper = await BoundDirectoryHelper.start(
    rootPathIdentity,
    rootIdentity,
    workspaceBoundReadNoFollowOverrideForTests ??
      (typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0),
  );
  try {
    const admittedAfter = await preciseStats(expectedPath);
    if (
      !admittedAfter.isDirectory() ||
      !samePreciseFileIdentity(
        preciseFileIdentity(admittedAfter),
        admittedIdentity,
      )
    ) {
      throw new WorkspacePathIdentityChangedError(expectedPath);
    }
    await helper.bindReadDirectory({
      directoryPath: expectedPath,
      expectedIdentity: admittedIdentity,
    });
    return helper;
  } catch (error) {
    await helper.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Hold an authenticated existing directory as a private helper process cwd.
 * Relative reads remain rooted at that directory even if its public ancestor
 * pathname is renamed or replaced after this function returns.
 */
export async function bindWorkspaceDirectoryReadCapability(
  directoryPath: string,
): Promise<WorkspaceBoundReadCapability> {
  const expectedPath = resolve(directoryPath).normalize("NFC");
  let helper: BoundDirectoryHelper | undefined;
  try {
    helper = await bindReadDirectoryHelper(expectedPath);
    return workspaceBoundReadCapability({
      helper,
      rootPath: expectedPath,
    });
  } catch (error) {
    await helper?.dispose().catch(() => {});
    if (
      error instanceof WorkspacePathIdentityChangedError ||
      error instanceof WorkspaceReadCapabilityUnavailableError
    ) {
      throw error;
    }
    throw new WorkspaceReadCapabilityUnavailableError(expectedPath, error);
  }
}

/**
 * Hold a file's authenticated parent cwd plus the admitted file inode. Reads
 * prove the basename before/opened/after identity (using O_NOFOLLOW where the
 * platform exposes it), then read from the descriptor. A final leaf or ancestor
 * exchange cannot redirect it.
 */
export async function bindWorkspaceFileReadCapability(
  filePath: string,
): Promise<WorkspaceBoundFileReadCapability> {
  const expectedPath = resolve(filePath).normalize("NFC");
  let helper: BoundDirectoryHelper | undefined;
  try {
    const observedBefore = await preciseStats(expectedPath);
    if (!observedBefore.isFile() || observedBefore.isSymbolicLink()) {
      throw new WorkspacePathIdentityChangedError(expectedPath);
    }
    const admittedFileIdentity = preciseFileIdentity(observedBefore);
    helper = await bindReadDirectoryHelper(dirname(expectedPath));
    const observedAfter = await preciseStats(expectedPath);
    if (
      !observedAfter.isFile() ||
      observedAfter.isSymbolicLink() ||
      !samePreciseFileIdentity(
        preciseFileIdentity(observedAfter),
        admittedFileIdentity,
      )
    ) {
      throw new WorkspacePathIdentityChangedError(expectedPath);
    }
    const relativePath = basename(expectedPath);
    const exactFile = {
      relativePath,
      identity: admittedFileIdentity,
    };
    const base = workspaceBoundReadCapability({
      helper,
      rootPath: dirname(expectedPath),
      exactFile,
    });
    return {
      ...base,
      filePath: expectedPath,
      readFile: (maxBytes) =>
        helper!.readRelativeFile({
          relativePath,
          expectedIdentity: exactFile.identity,
          maxBytes,
        }),
      readTextWindow: (offset, limit, maxBytes) =>
        helper!.readTextWindow({
          relativePath,
          expectedIdentity: exactFile.identity,
          offset,
          limit,
          maxBytes,
        }),
    };
  } catch (error) {
    await helper?.dispose().catch(() => {});
    if (
      error instanceof WorkspacePathIdentityChangedError ||
      error instanceof WorkspaceReadCapabilityUnavailableError
    ) {
      throw error;
    }
    throw new WorkspaceReadCapabilityUnavailableError(expectedPath, error);
  }
}

function fileIdentity(
  value: Pick<Stats, "dev" | "ino" | "mode">,
): BoundFileIdentity {
  return { dev: value.dev, ino: value.ino, mode: value.mode };
}

async function readFileHandle(handle: FileHandle): Promise<Buffer> {
  const current = await handle.stat();
  const content = Buffer.alloc(current.size);
  let offset = 0;
  while (offset < content.length) {
    const result = await handle.read(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (result.bytesRead <= 0) break;
    offset += result.bytesRead;
  }
  return offset === content.length ? content : content.subarray(0, offset);
}

async function writeFileHandle(
  handle: FileHandle,
  content: Buffer,
): Promise<void> {
  await handle.truncate(0);
  let offset = 0;
  while (offset < content.length) {
    const result = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("descriptor-bound write made no progress");
    }
    offset += result.bytesWritten;
  }
}

async function observeCanonicalPath(path: string): Promise<{
  readonly canonicalPath: string;
  readonly anchorPath: string;
  readonly anchorRealPath: string;
  readonly anchorStats: Stats;
}> {
  const expectedPath = resolve(path).normalize("NFC");
  const missingSegments: string[] = [];
  let cursor = expectedPath;
  for (;;) {
    try {
      const before = await stat(cursor);
      const anchorRealPath = (await realpath(cursor)).normalize("NFC");
      const after = await stat(cursor);
      if (!sameFileIdentity(before, after)) {
        throw new WorkspacePathIdentityChangedError(expectedPath);
      }
      return {
        canonicalPath: resolve(anchorRealPath, ...missingSegments).normalize(
          "NFC",
        ),
        anchorPath: cursor,
        anchorRealPath,
        anchorStats: after,
      };
    } catch (error) {
      if (error instanceof WorkspacePathIdentityChangedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function capturePathIdentity(
  path: string,
): Promise<WorkspacePathIdentity> {
  const expectedPath = resolve(path).normalize("NFC");
  const observed = await observeCanonicalPath(expectedPath);
  if (observed.canonicalPath !== expectedPath) {
    throw new WorkspacePathIdentityChangedError(expectedPath);
  }
  return {
    expectedPath,
    targetExisted: observed.anchorPath === expectedPath,
    anchorPath: observed.anchorPath,
    anchorRealPath: observed.anchorRealPath,
    anchorDev: observed.anchorStats.dev,
    anchorIno: observed.anchorStats.ino,
    anchorMode: observed.anchorStats.mode,
  };
}

async function assertPathIdentity(
  identity: WorkspacePathIdentity,
  afterEffect = false,
): Promise<void> {
  let anchorBefore: Stats;
  let anchorRealPath: string;
  let anchorAfter: Stats;
  try {
    anchorBefore = await stat(identity.anchorPath);
    anchorRealPath = (await realpath(identity.anchorPath)).normalize("NFC");
    anchorAfter = await stat(identity.anchorPath);
  } catch {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  if (
    !sameFileIdentity(anchorBefore, anchorAfter) ||
    anchorAfter.dev !== identity.anchorDev ||
    anchorAfter.ino !== identity.anchorIno ||
    anchorAfter.mode !== identity.anchorMode ||
    anchorRealPath !== identity.anchorRealPath
  ) {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  let observed: Awaited<ReturnType<typeof observeCanonicalPath>>;
  try {
    observed = await observeCanonicalPath(identity.expectedPath);
  } catch {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  const targetExists = observed.anchorPath === identity.expectedPath;
  if (
    observed.canonicalPath !== identity.expectedPath ||
    (afterEffect ? !targetExists : targetExists !== identity.targetExisted)
  ) {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
}

async function assertIdentityAnchor(
  identity: WorkspacePathIdentity,
): Promise<void> {
  let anchorBefore: Stats;
  let anchorRealPath: string;
  let anchorAfter: Stats;
  try {
    anchorBefore = await stat(identity.anchorPath);
    anchorRealPath = (await realpath(identity.anchorPath)).normalize("NFC");
    anchorAfter = await stat(identity.anchorPath);
  } catch {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  if (
    !sameFileIdentity(anchorBefore, anchorAfter) ||
    anchorAfter.dev !== identity.anchorDev ||
    anchorAfter.ino !== identity.anchorIno ||
    anchorAfter.mode !== identity.anchorMode ||
    anchorRealPath !== identity.anchorRealPath
  ) {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
}

async function assertPreWritePathState(
  identity: WorkspacePathIdentity,
  backup: WorkspaceFileBackup,
): Promise<void> {
  await assertPathIdentity(identity);
  if (!backup.existed) return;
  let current: Buffer;
  try {
    current = await readFile(identity.expectedPath);
  } catch {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  if (!current.equals(backup.content ?? Buffer.alloc(0))) {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
}

async function captureBackup(path: string): Promise<WorkspaceFileBackup> {
  try {
    return { existed: true, content: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

/**
 * Capture the exact original target state plus an independently anchored
 * parent-path identity for a larger, caller-owned transaction.
 *
 * This is the low-level half of executeWorkspaceFileMutation: apply_patch uses
 * it to retain one atomic multi-path commit/rollback boundary instead of
 * committing each operation independently.
 */
export async function captureWorkspaceFilePathTransactionGuard(
  path: string,
): Promise<WorkspaceFilePathTransactionGuard> {
  const identity = await capturePathIdentity(path);
  const parentIdentity = await capturePathIdentity(
    dirname(identity.expectedPath),
  );
  const backup = await captureBackup(identity.expectedPath);
  if (backup.existed !== identity.targetExisted) {
    throw new WorkspacePathIdentityChangedError(identity.expectedPath);
  }
  await assertPreWritePathState(identity, backup);
  let currentTargetIdentity: BoundFileIdentity | null = identity.targetExisted
    ? {
        dev: identity.anchorDev,
        ino: identity.anchorIno,
        mode: identity.anchorMode,
      }
    : null;
  let directoryHelper: BoundDirectoryHelper | undefined;

  const ensureDirectoryHelper = async (): Promise<BoundDirectoryHelper> => {
    if (directoryHelper !== undefined) return directoryHelper;
    try {
      // Successful startup is also the platform capability probe: the child
      // must resolve cwd to the exact captured directory identity before the
      // caller's final-check hook is allowed to run.
      directoryHelper = await BoundDirectoryHelper.start(parentIdentity);
    } catch (error) {
      if (error instanceof WorkspacePathIdentityChangedError) throw error;
      throw new WorkspaceFileMutationPathBindingUnavailableError(
        identity.expectedPath,
        error,
      );
    }
    return directoryHelper;
  };

  const prepareBoundMutation = async (
    expected: WorkspaceFilePathExpectedState,
    operation: "write" | "remove",
  ): Promise<void> => {
    if (operation === "write" && expected.kind === "content") return;
    await ensureDirectoryHelper();
  };

  const writeBoundContent = async (
    expected: WorkspaceFilePathExpectedState,
    content: Buffer,
    onEffectStart?: () => void,
  ): Promise<void> => {
    if (expected.kind === "missing") {
      const helper = await ensureDirectoryHelper();
      const createdIdentity = await helper.mutate({
        pathIdentity: identity,
        expectedIdentity: null,
        expected,
        operation: "write",
        content,
        ...(onEffectStart !== undefined ? { onEffectStart } : {}),
      });
      if (createdIdentity === null) {
        throw new WorkspacePathIdentityChangedError(identity.expectedPath);
      }
      currentTargetIdentity = createdIdentity;
      return;
    }

    let handle: FileHandle;
    try {
      handle = await open(
        identity.expectedPath,
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      );
    } catch {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
    try {
      const openedIdentity = fileIdentity(await handle.stat());
      if (
        currentTargetIdentity === null ||
        !sameFileIdentity(openedIdentity, currentTargetIdentity)
      ) {
        throw new WorkspacePathIdentityChangedError(identity.expectedPath);
      }
      const current = await readFileHandle(handle);
      if (!current.equals(expected.content)) {
        throw new WorkspacePathIdentityChangedError(identity.expectedPath);
      }
      onEffectStart?.();
      await writeFileHandle(handle, content);
      currentTargetIdentity = fileIdentity(await handle.stat());
    } finally {
      await handle.close();
    }
  };

  const removeBoundEntry = async (
    expected: WorkspaceFilePathExpectedState,
    onEffectStart?: () => void,
  ): Promise<void> => {
    if (expected.kind !== "content" || currentTargetIdentity === null) {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
    const helper = await ensureDirectoryHelper();
    await helper.mutate({
      pathIdentity: identity,
      expectedIdentity: currentTargetIdentity,
      expected,
      operation: "remove",
      ...(onEffectStart !== undefined ? { onEffectStart } : {}),
    });
    currentTargetIdentity = null;
  };

  const assertState = async (
    expected: WorkspaceFilePathExpectedState,
  ): Promise<void> => {
    await assertIdentityAnchor(parentIdentity);
    let observed: Awaited<ReturnType<typeof observeCanonicalPath>>;
    try {
      observed = await observeCanonicalPath(identity.expectedPath);
    } catch {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
    const targetExists = observed.anchorPath === identity.expectedPath;
    if (
      observed.canonicalPath !== identity.expectedPath ||
      targetExists !== (expected.kind === "content")
    ) {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
    if (expected.kind === "missing") return;
    let content: Buffer;
    try {
      content = await readFile(identity.expectedPath);
    } catch {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
    if (!content.equals(expected.content)) {
      throw new WorkspacePathIdentityChangedError(identity.expectedPath);
    }
  };
  const observeState = async (): Promise<WorkspaceFilePathObservedState> => {
    try {
      await assertIdentityAnchor(parentIdentity);
      const observed = await observeCanonicalPath(identity.expectedPath);
      if (observed.canonicalPath !== identity.expectedPath) {
        return { kind: "unreadable" };
      }
      if (observed.anchorPath !== identity.expectedPath) {
        await assertIdentityAnchor(parentIdentity);
        return { kind: "missing" };
      }
      const content = await readFile(identity.expectedPath);
      await assertIdentityAnchor(parentIdentity);
      const after = await observeCanonicalPath(identity.expectedPath);
      if (
        after.canonicalPath !== identity.expectedPath ||
        after.anchorPath !== identity.expectedPath
      ) {
        return { kind: "unreadable" };
      }
      return { kind: "content", content };
    } catch {
      return { kind: "unreadable" };
    }
  };

  return {
    path: identity.expectedPath,
    targetExisted: backup.existed,
    ...(backup.content !== undefined
      ? { backupContent: Buffer.from(backup.content) }
      : {}),
    assertOriginalState: () => assertPreWritePathState(identity, backup),
    assertState,
    observeState,
    prepareBoundMutation,
    writeBoundContent,
    removeBoundEntry,
    dispose: async () => {
      await directoryHelper?.dispose();
    },
  };
}

async function guardedStateMatches(
  guard: WorkspaceFilePathTransactionGuard,
  expected: WorkspaceFilePathExpectedState,
): Promise<boolean> {
  try {
    await guard.assertState(expected);
    return true;
  } catch {
    return false;
  }
}

function observedStateForCoordinator(
  observed: WorkspaceFilePathObservedState,
  decode: (content: Buffer) => string,
): WorkspaceMutationObservedState {
  return observed.kind === "content"
    ? { kind: "content", content: decode(observed.content) }
    : observed;
}

/**
 * Execute one coordinated file write with a verified rollback boundary.
 *
 * Bound callbacks mark the target at the helper/FileHandle's exact effect
 * boundary; legacy raw callbacks remain conservatively marked before
 * invocation. A rejected syscall therefore never cancels its durable mutation
 * intent merely because the promise rejected: cancellation happens only after
 * the exact pre-write bytes/existence are verified restored. Otherwise the
 * admission is reconciled as unknown so Editor receives a durable reload event.
 */
export async function executeWorkspaceFileMutation(input: {
  readonly admission: WorkspaceMutationAdmissionResult;
  readonly path: string;
  readonly afterText: string;
  readonly write: (
    assertCurrentPathState: () => Promise<void>,
    targetExisted: boolean,
    boundMutation: WorkspaceBoundFileMutation,
  ) => Promise<void>;
  /**
   * The callback performs its filesystem effect only through boundMutation.
   * Raw legacy callbacks remain conservatively classified as having started
   * once invoked.
   */
  readonly writeUsesBoundMutation?: boolean;
  readonly metadata?: {
    readonly sessionId?: string;
    readonly toolCallId?: string;
  };
  readonly decodeObserved?: (content: Buffer) => string;
  readonly testHooks?: WorkspaceFileMutationTestHooks;
}): Promise<void> {
  try {
    beginWorkspaceMutation(input.admission);
  } catch (error) {
    cancelWorkspaceMutation(input.admission);
    throw error;
  }

  let guard: WorkspaceFilePathTransactionGuard;
  try {
    guard = await captureWorkspaceFilePathTransactionGuard(input.path);
  } catch (error) {
    // No target syscall has run, so this remains a true pre-effect failure.
    cancelWorkspaceMutation(input.admission);
    throw error;
  }

  try {
    let writeStarted = false;
    let transactionPostState: WorkspaceFilePathExpectedState | undefined;
    const originalState: WorkspaceFilePathExpectedState = guard.targetExisted
      ? {
          kind: "content",
          content: guard.backupContent ?? Buffer.alloc(0),
        }
      : { kind: "missing" };
    const write = async (): Promise<void> => {
      await guard.assertOriginalState();
      await guard.prepareBoundMutation(originalState, "write");
      if (input.writeUsesBoundMutation !== true) writeStarted = true;
      await input.write(guard.assertOriginalState, guard.targetExisted, {
        writeContent: (content) =>
          guard.writeBoundContent(originalState, content, () => {
            writeStarted = true;
          }),
      });
      const observed = await guard.observeState();
      if (observed.kind !== "content") {
        throw new WorkspacePathIdentityChangedError(guard.path);
      }
      const decode =
        input.decodeObserved ?? ((content: Buffer) => content.toString("utf8"));
      if (decode(observed.content) !== input.afterText) {
        throw new WorkspacePathIdentityChangedError(guard.path);
      }
      transactionPostState = {
        kind: "content",
        content: observed.content,
      };
      await guard.assertState(transactionPostState);
    };
    try {
      // A bound callback reports its exact effect boundary. The wrapper hook
      // still models a syscall that may truncate or partially replace bytes
      // and then reject.
      if (input.testHooks?.__testWrite !== undefined) {
        try {
          await input.testHooks.__testWrite({
            path: input.path,
            write,
          });
        } catch (error) {
          // The explicit fault-injection seam models a syscall that may have
          // changed bytes before rejecting. Capture its exact, still-anchored
          // result so rollback remains testable without trusting raw pathnames.
          if (transactionPostState === undefined) {
            const observed = await guard.observeState();
            if (observed.kind === "content") {
              transactionPostState = {
                kind: "content",
                content: observed.content,
              };
            }
          }
          throw error;
        }
      } else {
        await write();
      }
      if (transactionPostState === undefined) {
        throw new WorkspacePathIdentityChangedError(guard.path);
      }
      await guard.assertState(transactionPostState);
    } catch (writeError) {
      if (writeError instanceof WorkspaceFileMutationPreEffectConflictError) {
        // Exclusive creation reported that another writer published the target.
        // EEXIST guarantees this callback did not touch the file, so cancelling
        // is safe even though the open syscall itself was attempted.
        cancelWorkspaceMutation(input.admission);
        throw writeError;
      }
      if (
        writeError instanceof WorkspacePathIdentityChangedError &&
        !writeStarted
      ) {
        // The identity guard rejected the operation before invoking the caller's
        // filesystem callback. Restoring through the now-aliased pathname would
        // itself risk modifying an unrelated file.
        cancelWorkspaceMutation(input.admission);
        throw writeError;
      }
      if (writeError instanceof WorkspacePathIdentityChangedError) {
        // Once a syscall has started and the path identity changes, a path-based
        // rollback is no longer trustworthy. Preserve the original coordinator
        // intent as unknown instead of writing backup bytes through an alias.
        const observed = observedStateForCoordinator(
          await guard.observeState(),
          input.decodeObserved ?? ((content) => content.toString("utf8")),
        );
        let reconciliationError: unknown;
        if (input.admission.decision === "allow") {
          try {
            await reconcileUnknownMutation(
              input.admission.token,
              observed,
              input.metadata,
            );
          } catch (error) {
            reconciliationError = error;
          }
        } else {
          cancelWorkspaceMutation(input.admission);
        }
        throw new WorkspaceMutationCoordinatorError(
          "MUTATION_AUDIT_FAILED",
          `The write to ${input.path} crossed a changed filesystem path identity after a syscall began. Its outcome is unknown; re-read the file before another mutation${
            reconciliationError === undefined
              ? "."
              : ` (unknown-outcome audit failure: ${errorMessage(reconciliationError)}).`
          }`,
        );
      }

      if (
        transactionPostState === undefined &&
        (await guardedStateMatches(guard, originalState))
      ) {
        cancelWorkspaceMutation(input.admission);
        throw writeError;
      }

      let restoreError: unknown;
      if (transactionPostState !== undefined) {
        try {
          const restore = async (): Promise<void> => {
            await guard.assertState(transactionPostState!);
            if (guard.targetExisted) {
              await guard.writeBoundContent(
                transactionPostState!,
                guard.backupContent ?? Buffer.alloc(0),
              );
            } else {
              await guard.removeBoundEntry(transactionPostState!);
            }
            await guard.assertState(originalState);
          };
          if (input.testHooks?.__testRestoreBackup !== undefined) {
            await input.testHooks.__testRestoreBackup({
              path: input.path,
              restore,
            });
          } else {
            await restore();
          }
        } catch (error) {
          restoreError = error;
        }
      }

      if (
        restoreError === undefined &&
        transactionPostState !== undefined &&
        (await guardedStateMatches(guard, originalState))
      ) {
        cancelWorkspaceMutation(input.admission);
        throw writeError;
      }

      const observed = observedStateForCoordinator(
        await guard.observeState(),
        input.decodeObserved ?? ((content) => content.toString("utf8")),
      );
      let reconciliationError: unknown;
      if (input.admission.decision === "allow") {
        try {
          await reconcileUnknownMutation(
            input.admission.token,
            observed,
            input.metadata,
          );
        } catch (error) {
          reconciliationError = error;
        }
      } else {
        cancelWorkspaceMutation(input.admission);
      }
      const details = [
        `original write failure: ${errorMessage(writeError)}`,
        ...(restoreError !== undefined
          ? [`restore failure: ${errorMessage(restoreError)}`]
          : transactionPostState === undefined
            ? ["current bytes were not a proved transaction-owned post-state"]
            : ["restored bytes could not be verified"]),
        ...(reconciliationError !== undefined
          ? [
              `unknown-outcome audit failure: ${errorMessage(reconciliationError)}`,
            ]
          : []),
      ].join("; ");
      throw new WorkspaceMutationCoordinatorError(
        "MUTATION_AUDIT_FAILED",
        `The write to ${input.path} may have partially changed the file and rollback was not verified. Its outcome is unknown; re-read the file before another mutation (${details}).`,
      );
    }

    await commitWorkspaceMutation(
      input.admission,
      input.afterText,
      input.metadata,
    );
  } finally {
    await guard.dispose();
  }
}
