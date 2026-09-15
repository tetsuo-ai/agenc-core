import { posix } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  WorkspaceBoundDirectoryMutation,
  WorkspaceBoundReadFile, WorkspaceBoundReadFileStats, WorkspaceBoundTextWindow,
  WorkspaceFilePathExpectedState, WorkspaceFilePathObservedState, WorkspaceFilePathTransactionGuard,
  WorkspaceBoundDirectoryIdentity, WorkspaceBoundEntryIdentity, WorkspaceBoundRegularFileIdentity,
} from "../workspace/file-mutation-transaction.js";
import { WorkspaceBoundReadFileTooLargeError } from "../workspace/bound-read-error.js";
import { WorkspacePathIdentityChangedError } from "../workspace/mutation-error.js";
import { prepareAdmittedExecutionOperation } from "./call-context.js";
import type { DockerExecutionProcesses } from "./docker-process.js";
import { runDockerBoundRipgrep, type BoundRipgrepInput } from "./docker-ripgrep.js";
import { validateExecutionIdentity } from "./identity.js";
import { ExecutionEnvironmentError, type ExecutionFilesystem, type ExecutionOperationIdentity,
  type ExecutionFileIdentity, type ExecutionPathDescription, type ExecutionFileSnapshotCapability,
  type ExecutionDirectorySnapshotCapability, type ExecutionDirectoryEntry } from "./types.js";
import type { ExecutionBoundFileReadCapability, ExecutionBoundDirectoryReadCapability } from "./types.js";

const CHUNK_BYTES = 65536;
const CONTENT_BYTES = 32 * 1024 * 1024;
const MUTATIONS = new Set(["write", "remove", "remove_symlink", "remove_directory", "rename_file", "create_directory"]);
type BoundHandle = { handle: number; stats: WorkspaceBoundReadFileStats; existed?: boolean };
export interface DockerFilesystemEffectReceipt {
  readonly id: string;
  readonly state: "intent" | "acknowledged";
  readonly result: Readonly<Record<string, unknown>> | null;
  /** Retained operational request; absent in older receipts. Never redispatched. */
  readonly request?: Readonly<Record<string, unknown>>;
}

function invalid(message: string): never {
  throw new ExecutionEnvironmentError("invalid_request", message, false);
}
function protocol(message: string): never {
  throw new ExecutionEnvironmentError("host_protocol", message, true);
}
function absolutePath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") ||
      Buffer.byteLength(path) >= 16384 || Buffer.from(path).toString() !== path) invalid("Invalid absolute task filesystem path");
}
function relativePath(path: string): void {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) {
    invalid("A relative read must remain beneath its directory capability");
  }
  absolutePath(`/${path}`);
}
function entryName(name: string): void {
  if (typeof name !== "string" || !name || name.includes("/") || [".", ".."].includes(name) ||
      Buffer.byteLength(name) > 255) invalid("Invalid directory entry basename");
  absolutePath(`/${name}`);
}
function matchesIdentity(value: WorkspaceBoundReadFileStats, expected: WorkspaceBoundEntryIdentity): boolean {
  return [expected.dev, expected.ino, expected.mode].every((part) => Number.isSafeInteger(part) && part >= 0) &&
    value.dev === String(expected.dev) && value.ino === String(expected.ino) && value.mode === String(expected.mode);
}
function byteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) invalid("Invalid filesystem byte bound");
}
function handleId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0xffffffff) protocol("Invalid filesystem capability handle");
  return value as number;
}
function stats(value: unknown): WorkspaceBoundReadFileStats {
  if (value === null || typeof value !== "object") protocol("Missing protected filesystem metadata");
  const record = value as WorkspaceBoundReadFileStats;
  if ([record.dev, record.ino, record.mode].some((part) => typeof part !== "string" || !/^\d{1,20}$/.test(part)) ||
      !Number.isSafeInteger(record.size) || record.size < 0 ||
      !Number.isFinite(record.mtimeMs) || !Number.isFinite(record.ctimeMs)) protocol("Invalid protected filesystem metadata");
  return Object.freeze({ dev: record.dev, ino: record.ino, mode: record.mode, size: record.size,
    mtimeMs: record.mtimeMs, ctimeMs: record.ctimeMs });
}
function sameVersion(first: WorkspaceBoundReadFileStats, second: WorkspaceBoundReadFileStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode &&
    first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

function pathDescription(value: Record<string, unknown>): ExecutionPathDescription {
  const path = value.canonicalPath;
  const identity = value.identity as ExecutionFileIdentity | undefined;
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") ||
      Buffer.byteLength(path) >= 16384 || Buffer.from(path).toString() !== path || posix.normalize(path) !== path ||
      identity === null || typeof identity !== "object") protocol("Invalid protected path description");
  for (const key of ["dev", "ino", "mode", "nlink", "size"] as const) {
    const value = identity[key];
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) ||
        BigInt(value) > (key === "mode" ? 0xffffffffn : 0xffffffffffffffffn)) protocol("Invalid exact filesystem identity");
  }
  for (const key of ["mtimeNs", "ctimeNs"] as const) {
    const value = identity[key];
    if (typeof value !== "string" || !/^(0|-?[1-9]\d{0,28})$/.test(value) ||
        BigInt(value) < -9223372036854775808n * 1000000000n ||
        BigInt(value) > 9223372036854775807n * 1000000000n + 999999999n) protocol("Invalid exact filesystem timestamp");
  }
  return Object.freeze({ canonicalPath: path, identity: Object.freeze({ dev: identity.dev, ino: identity.ino,
    mode: identity.mode, nlink: identity.nlink, size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs }) });
}

/** Filesystem RPC carries capabilities and bytes; this backend cannot spawn on the controller. */
export class DockerExecutionFilesystem implements ExecutionFilesystem {
  private constructor(private readonly owner: DockerExecutionProcesses, readonly workerId: string,
    private readonly supportsDirectoryCreation: boolean, private readonly supportsBoundReadlink: boolean) {}

  static async connect(owner: DockerExecutionProcesses): Promise<DockerExecutionFilesystem> {
    owner.assertOpen();
    const capabilities = await owner.client.request({ method: "capabilities" });
    const features = capabilities.features;
    if (!Array.isArray(features) ||
        ["filesystem_original_guard", "filesystem_recursive_guard", "filesystem_directory_mutations", "filesystem_path_metadata", "filesystem_path_description"].some((feature) => !features.includes(feature))) {
      throw new ExecutionEnvironmentError("unsupported_host", "Execution host lacks required protected filesystem capabilities", false);
    }
    const result = await owner.client.request({ method: "filesystem", operation: "connect",
      generation: owner.binding.generation, owner: owner.ownerId, authorityRevision: owner.authorityRevision });
    if (typeof result.workerId !== "string" || !/^[a-f0-9]{32}$/.test(result.workerId)) protocol("Invalid filesystem worker epoch");
    return new DockerExecutionFilesystem(owner, result.workerId, features.includes("filesystem_create_directory"),
      features.includes("filesystem_bound_readlink"));
  }

  async readLink(description: ExecutionPathDescription): Promise<string> {
    if (!this.supportsBoundReadlink) throw new ExecutionEnvironmentError("unsupported_host", "Execution host lacks protected symlink reads", false);
    const expected = pathDescription(description as unknown as Record<string, unknown>);
    if ((BigInt(expected.identity.mode) & 0o170000n) !== 0o120000n) invalid("Symlink read requires an observed symlink");
    const parent = await this.bind(posix.dirname(expected.canonicalPath), "directory");
    return this.usingHandle(parent.handle, async () => {
      const result = await this.rpc("bind_entry", { base: parent.handle, name: posix.basename(expected.canonicalPath) });
      const handle = handleId(result.handle);
      return this.usingHandle(handle, async () => {
        const bound = stats(result.stats);
        const check = async () => {
          const current = await this.describePath(expected.canonicalPath, { followSymlinks: false });
          if (bound.dev !== expected.identity.dev || bound.ino !== expected.identity.ino || bound.mode !== expected.identity.mode ||
              current.canonicalPath !== expected.canonicalPath ||
              (Object.keys(expected.identity) as (keyof ExecutionFileIdentity)[]).some(key => current.identity[key] !== expected.identity[key])) {
            throw new ExecutionEnvironmentError("path_conflict", "Symlink changed during protected read", true, false);
          }
        };
        await check();
        const response = await this.rpc("readlink", { handle });
        if (typeof response.data !== "string" || response.data.length > Math.ceil(16384 / 3) * 4) protocol("Invalid symlink bytes");
        const bytes = Buffer.from(response.data, "base64");
        if (bytes.toString("base64") !== response.data) protocol("Invalid symlink encoding");
        const target = bytes.toString("utf8");
        if (!target || bytes.length >= 16384 || target.includes("\0") || !Buffer.from(target).equals(bytes)) {
          throw new ExecutionEnvironmentError("unsupported_resource", "Symlink target is not a supported task path", true, false);
        }
        await check();
        return target;
      });
    });
  }

  async createDirectory(parent: ExecutionPathDescription, name: string, mode: number): Promise<void> {
    if (!this.supportsDirectoryCreation) throw new ExecutionEnvironmentError("unsupported_host", "Execution host lacks protected directory creation", false);
    const expected = pathDescription(parent as unknown as Record<string, unknown>);
    entryName(name);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) invalid("Invalid directory creation mode");
    if ((BigInt(expected.identity.mode) & 0o170000n) !== 0o040000n) invalid("Directory creation requires a directory parent");
    const bound = await this.bind(expected.canonicalPath, "directory");
    await this.usingHandle(bound.handle, async () => {
      const current = pathDescription(await this.rpc("describe_handle", { handle: bound.handle }));
      if (current.canonicalPath !== expected.canonicalPath ||
          (Object.keys(expected.identity) as (keyof ExecutionFileIdentity)[]).some(key => current.identity[key] !== expected.identity[key])) {
        throw new ExecutionEnvironmentError("path_conflict", "Directory creation parent changed before dispatch", false, false);
      }
      await this.rpc("create_directory", { handle: bound.handle, path: expected.canonicalPath, name, mode });
    });
  }

  async rpc(operation: string, args: Readonly<Record<string, unknown>> = {},
    onEffectStart?: () => void): Promise<Record<string, unknown>> {
    this.owner.assertOpen();
    const dispatch = MUTATIONS.has(operation) ? prepareAdmittedExecutionOperation() : undefined;
    let result: Record<string, unknown>;
    try {
      result = await this.owner.client.request({ method: "filesystem", operation, arguments: args,
        generation: this.owner.binding.generation, owner: this.owner.ownerId,
        authorityRevision: this.owner.authorityRevision, workerId: this.workerId,
        ...(dispatch === undefined ? {} : { effect: dispatch.identity }) },
      dispatch === undefined ? {} : { signal: dispatch.signal, beforeSend: dispatch.crossEffectBoundary });
    } catch (error) {
      // Admission tracks possible dispatch. The transaction guard separately
      // tracks native mutation: an acknowledged precondition rejection must
      // not trigger rollback, while a lost acknowledgement stays uncertain.
      if (dispatch !== undefined && error instanceof ExecutionEnvironmentError && error.requestSent && error.mutationStarted !== false) {
        onEffectStart?.();
      }
      throw error;
    }
    if (dispatch !== undefined) onEffectStart?.();
    return result;
  }

  /** Inspection remains possible after authority closes or its worker is lost. */
  async inspectEffect(identity: ExecutionOperationIdentity): Promise<DockerFilesystemEffectReceipt | undefined> {
    validateExecutionIdentity(identity);
    const result = await this.owner.client.request({ method: "filesystem_effect", owner: this.owner.ownerId,
      generation: this.owner.binding.generation, effect: identity });
    if (result.effect === null) return undefined;
    const effect = result.effect as DockerFilesystemEffectReceipt;
    if (!effect || typeof effect.id !== "string" || !/^[a-f0-9]{32}$/.test(effect.id) ||
        !["intent", "acknowledged"].includes(effect.state) ||
        (effect.state === "intent" && effect.result !== null) ||
        (effect.state === "acknowledged" && (!effect.result || typeof effect.result.ok !== "boolean"))) {
      protocol("Invalid retained filesystem effect");
    }
    if (effect.request !== undefined && (!effect.request || typeof effect.request !== "object" || Array.isArray(effect.request))) {
      protocol("Invalid retained filesystem request");
    }
    return Object.freeze({ id: effect.id, state: effect.state, result: effect.result,
      ...(effect.request === undefined ? {} : { request: effect.request }) });
  }

  async *reconnectCall(identity: ExecutionOperationIdentity): AsyncGenerator<{
    readonly identity: ExecutionOperationIdentity; readonly receipt: DockerFilesystemEffectReceipt;
  }> {
    validateExecutionIdentity(identity);
    let after = -1;
    for (;;) {
      const response = await this.owner.client.request({ method: "call_operations", owner: this.owner.ownerId,
        generation: this.owner.binding.generation, ...identity, kind: "filesystem", after, maximum: 128 });
      const entries = response.operations as { operationId: string; operationIndex: number }[];
      if (!Array.isArray(entries) || entries.length > 128) protocol("Invalid filesystem recovery page");
      for (const entry of entries) {
        if (!entry || !Number.isSafeInteger(entry.operationIndex) || entry.operationIndex <= after) protocol("Filesystem recovery cursor did not advance");
        const coordinate = Object.freeze({ runId: identity.runId, callId: identity.callId,
          attempt: identity.attempt, operationIndex: entry.operationIndex });
        const receipt = await this.inspectEffect(coordinate);
        if (!receipt || receipt.id !== entry.operationId) protocol("Original filesystem effect changed during inspection");
        yield { identity: coordinate, receipt };
        after = entry.operationIndex;
      }
      if (entries.length < 128) return;
    }
  }

  async bind(path: string, kind: "file" | "directory", base = 0): Promise<BoundHandle> {
    if (base === 0) absolutePath(path); else relativePath(path);
    const result = await this.rpc("bind", { path, kind, base });
    return { handle: handleId(result.handle), stats: stats(result.stats) };
  }

  async inspectPath(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<WorkspaceBoundReadFileStats> {
    absolutePath(path);
    const followSymlinks = options.followSymlinks === undefined ? true : options.followSymlinks;
    if (typeof followSymlinks !== "boolean") invalid("Invalid filesystem symlink policy");
    return stats((await this.rpc("inspect_path", { path, followSymlinks })).stats);
  }

  async describePath(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<ExecutionPathDescription> {
    absolutePath(path);
    const followSymlinks = options.followSymlinks === undefined ? true : options.followSymlinks;
    if (typeof followSymlinks !== "boolean") invalid("Invalid filesystem symlink policy");
    return pathDescription(await this.rpc("describe_path", { path, followSymlinks }));
  }

  async bindFileSnapshot(path: string): Promise<ExecutionFileSnapshotCapability> {
    const bound = await this.bind(path, "file");
    let disposed = false;
    const assertLive = () => {
      if (disposed) throw new ExecutionEnvironmentError("stale_capability", "File snapshot capability was released", false);
    };
    return Object.freeze({
      describe: async () => { assertLive(); return pathDescription(await this.rpc("describe_handle", { handle: bound.handle })); },
      readFile: async (maximumBytes: number) => { assertLive(); return (await this.readBound(bound, path, maximumBytes)).content; },
      dispose: async () => { if (disposed) return; disposed = true; await this.release(bound.handle); },
    });
  }

  async bindDirectorySnapshot(path: string): Promise<ExecutionDirectorySnapshotCapability> {
    const bound = await this.bind(path, "directory");
    const filesystem = this;
    let disposed = false, consumed = false;
    const assertLive = () => {
      if (disposed) throw new ExecutionEnvironmentError("stale_capability", "Directory snapshot capability was released", false);
    };
    return Object.freeze({
      describe: async () => { assertLive(); return pathDescription(await this.rpc("describe_handle", { handle: bound.handle })); },
      entries: async function* () {
        assertLive();
        if (consumed) invalid("Directory snapshot cursor was already consumed");
        consumed = true;
        for (;;) {
          assertLive();
          const page = await filesystem.directoryPage(bound.handle);
          for (const entry of page) { assertLive(); yield entry; }
          if (page.length < 128) return;
        }
      },
      dispose: async () => { if (disposed) return; disposed = true; await this.release(bound.handle); },
    });
  }

  private async directoryPage(handle: number): Promise<ExecutionDirectoryEntry[]> {
    const response = await this.rpc("list", { handle, maximum: 128 });
    const entries = response.entries as { name: string; type: number }[];
    if (!Array.isArray(entries) || entries.length > 128) protocol("Invalid directory page");
    return entries.map((entry) => {
      if (!entry || typeof entry.name !== "string" || !entry.name || entry.name.includes("/") ||
          entry.name.includes("\0") || [".", ".."].includes(entry.name) || Buffer.byteLength(entry.name) > 255 ||
          Buffer.from(entry.name).toString() !== entry.name || !Number.isInteger(entry.type) || entry.type < 0 || entry.type > 255) {
        protocol("Invalid directory entry");
      }
      return Object.freeze({ name: entry.name,
        kind: entry.type === 8 ? "file" : entry.type === 4 ? "directory" : entry.type === 10 ? "symlink" : "other" });
    });
  }

  async release(handle: number): Promise<void> { await this.rpc("release", { handle }); }

  async usingHandle<T>(handle: number, action: () => Promise<T>): Promise<T> {
    let result: T;
    try { result = await action(); }
    catch (error) {
      try { await this.release(handle); }
      catch (cleanup) {
        // Retain the original dispatch/mutation evidence even if releasing the
        // auxiliary capability also fails. Nothing here repeats an effect.
        if (error instanceof Error && error.cause === undefined) error.cause = cleanup;
      }
      throw error;
    }
    await this.release(handle);
    return result;
  }

  async readChunk(handle: number, offset: number, maximum: number, expected = false): Promise<Buffer> {
    const response = await this.rpc(expected ? "expected" : "read", { handle, offset, maximum });
    if (typeof response.data !== "string" || response.data.length > Math.ceil(maximum / 3) * 4) protocol("Invalid bounded filesystem bytes");
    const data = Buffer.from(response.data, "base64");
    if (data.length > maximum || data.toString("base64") !== response.data) protocol("Invalid filesystem byte encoding");
    return data;
  }

  async readBound(bound: BoundHandle, path: string, maximum: number, truncate = false, expected = false): Promise<WorkspaceBoundReadFile> {
    byteLimit(maximum);
    if (bound.stats.size > maximum && !truncate) throw new WorkspaceBoundReadFileTooLargeError(path, bound.stats.size);
    const size = Math.min(maximum, bound.stats.size);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size;) {
      const wanted = Math.min(CHUNK_BYTES, size - offset);
      const data = await this.readChunk(bound.handle, offset, wanted, expected);
      if (data.length !== wanted) throw new ExecutionEnvironmentError("path_conflict", "Bound file changed during read", true, false);
      parts.push(data); offset += data.length;
    }
    if (!expected) await this.assertVersion(bound);
    return { content: Buffer.concat(parts, size), stats: bound.stats };
  }

  async assertVersion(bound: BoundHandle): Promise<void> {
    const current = stats((await this.rpc("stat", { handle: bound.handle })).stats);
    if (!sameVersion(bound.stats, current)) throw new ExecutionEnvironmentError("path_conflict", "Bound file version changed", true, false);
  }

  async bindDirectoryRead(path: string): Promise<ExecutionBoundDirectoryReadCapability> {
    return new DockerBoundRead(this, path, await this.bind(path, "directory"));
  }
  async bindFileRead(path: string): Promise<ExecutionBoundFileReadCapability> {
    absolutePath(path);
    const parent = await this.bind(posix.dirname(path), "directory");
    try {
      const file = await this.bind(path, "file");
      try {
        const directory = pathDescription(await this.rpc("describe_handle", { handle: parent.handle }));
        await this.rpc("describe_handle", { handle: file.handle });
        // A leaf symlink may legitimately target another directory. Correlate
        // the lexical parent used for acquisition, not the target's parent.
        const currentParent = await this.describePath(posix.dirname(path));
        if (directory.canonicalPath !== currentParent.canonicalPath ||
            (Object.keys(directory.identity) as (keyof ExecutionFileIdentity)[]).some(key => directory.identity[key] !== currentParent.identity[key])) {
          throw new ExecutionEnvironmentError("path_conflict", "File read parent changed during acquisition", true, false);
        }
        return new DockerBoundFileRead(this, path, file, parent);
      } catch (error) {
        try { await this.release(file.handle); } catch (cleanup) { if (error instanceof Error) error.cause ??= cleanup; }
        throw error;
      }
    } catch (error) {
      try { await this.release(parent.handle); } catch (cleanup) { if (error instanceof Error) error.cause ??= cleanup; }
      throw error;
    }
  }
  async runBoundRipgrep(path: string, directory: BoundHandle, input: BoundRipgrepInput, source?: BoundHandle) {
    return runDockerBoundRipgrep(this.owner, path, { cwd: { workerId: this.workerId, handle: directory.handle },
      ...(source === undefined ? {} : { stdin: { workerId: this.workerId, handle: source.handle } }) }, input);
  }
  async readFile(path: string, maximumBytes: number): Promise<Buffer> {
    byteLimit(maximumBytes);
    const file = await this.bind(path, "file");
    return this.usingHandle(file.handle, async () => (await this.readBound(file, path, maximumBytes)).content);
  }
  async readDirectory(path: string): Promise<ExecutionDirectoryEntry[]> {
    const directory = await this.bindDirectorySnapshot(path);
    try {
      const result: ExecutionDirectoryEntry[] = [];
      for await (const entry of directory.entries()) {
        if (result.length >= 1_000_000) throw new ExecutionEnvironmentError("directory_limit", "Directory listing exceeds its entry bound", true);
        result.push(entry);
      }
      return result;
    } finally { await directory.dispose(); }
  }

  async capture(path: string): Promise<BoundHandle & { existed: boolean; missingParents: boolean }> {
    absolutePath(path);
    const result = await this.rpc("capture", { path });
    if (typeof result.existed !== "boolean" || typeof result.missingParents !== "boolean" ||
        (result.existed && result.missingParents)) protocol("Invalid captured file/ancestor state");
    return { handle: handleId(result.handle), stats: stats(result.stats), existed: result.existed, missingParents: result.missingParents };
  }
  async captureFileGuard(path: string): Promise<WorkspaceFilePathTransactionGuard> {
    const captured = await this.capture(path);
    try {
      const backup = captured.existed ? (await this.readBound(captured, path, CONTENT_BYTES, false, true)).content : undefined;
      return new DockerFileGuard(this, path, captured.handle, backup, captured.missingParents);
    } catch (error) {
      return this.usingHandle(captured.handle, async () => { throw error; });
    }
  }
  async stage(content: Buffer): Promise<number> {
    if (!Buffer.isBuffer(content) || content.length > CONTENT_BYTES) invalid("File mutation exceeds its content bound");
    const handle = handleId((await this.rpc("stage")).handle);
    try {
      for (let offset = 0; offset < content.length; offset += CHUNK_BYTES) {
        await this.rpc("append", { handle, offset, data: content.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
      }
      await this.rpc("seal", { handle });
      return handle;
    } catch (error) { return this.usingHandle(handle, async () => { throw error; }); }
  }
  async withExpected<T>(expected: WorkspaceFilePathExpectedState, action: (handle: number) => Promise<T>): Promise<T> {
    if (expected.kind === "missing") return action(0);
    if (expected.kind !== "content" || !Buffer.isBuffer(expected.content)) invalid("Invalid expected file state");
    const handle = await this.stage(Buffer.from(expected.content));
    return this.usingHandle(handle, () => action(handle));
  }

  async bindDirectoryMutation(parent: WorkspaceBoundDirectoryIdentity, name: string): Promise<WorkspaceBoundDirectoryMutation> {
    entryName(name); absolutePath(parent.path);
    const directory = await this.bind(parent.path, "directory");
    if (!matchesIdentity(directory.stats, parent)) {
      return this.usingHandle(directory.handle, async () => { throw new WorkspacePathIdentityChangedError(parent.path); });
    }
    return new DockerDirectoryMutation(this, parent.path, name, directory);
  }
}

class DockerDirectoryMutation implements WorkspaceBoundDirectoryMutation {
  private disposed = false;
  constructor(private readonly filesystem: DockerExecutionFilesystem, private readonly path: string,
    private readonly name: string, private readonly directory: BoundHandle) {}
  private async withEntry<T>(expected: WorkspaceBoundEntryIdentity, kind: number, action: (entry: BoundHandle) => Promise<T>): Promise<T> {
    if (this.disposed) throw new ExecutionEnvironmentError("stale_capability", "Directory mutation capability is disposed", false);
    const path = `${this.path}/${this.name}`;
    try {
      const bound = await this.filesystem.rpc("bind_entry", { base: this.directory.handle, name: this.name });
      const entry = { handle: handleId(bound.handle), stats: stats(bound.stats) };
      return await this.filesystem.usingHandle(entry.handle, async () => {
        if (!matchesIdentity(entry.stats, expected) || (Number(entry.stats.mode) & 0o170000) !== kind) {
          throw new WorkspacePathIdentityChangedError(path);
        }
        return action(entry);
      });
    } catch (error) {
      if (error instanceof ExecutionEnvironmentError && error.mutationStarted === false &&
          ["path_conflict", "not_found"].includes(error.code)) {
        const conflict = new WorkspacePathIdentityChangedError(path); conflict.cause = error; throw conflict;
      }
      throw error;
    }
  }
  async removeSymlink(expected: WorkspaceBoundEntryIdentity, linkTarget: string, onEffectStart?: () => void): Promise<void> {
    if (typeof linkTarget !== "string" || linkTarget.includes("\0") || Buffer.from(linkTarget).toString() !== linkTarget) invalid("Invalid expected symbolic link target");
    await this.withEntry(expected, 0o120000, async (entry) => {
      const result = await this.filesystem.rpc("readlink", { handle: entry.handle });
      if (typeof result.data !== "string" || result.data.length > 22000) protocol("Invalid symbolic link content");
      const bytes = Buffer.from(result.data, "base64");
      if (bytes.toString("base64") !== result.data) protocol("Invalid symbolic link byte encoding");
      if (!bytes.equals(Buffer.from(linkTarget))) throw new WorkspacePathIdentityChangedError(`${this.path}/${this.name}`);
      await this.filesystem.rpc("remove_symlink", { handle: entry.handle, path: `${this.path}/${this.name}`,
        quarantine: `.agenc-delete-${randomUUID()}` }, onEffectStart);
    });
  }
  async removeDirectory(expected: WorkspaceBoundEntryIdentity, onEffectStart?: () => void): Promise<void> {
    await this.withEntry(expected, 0o040000, (entry) => this.filesystem.rpc("remove_directory", {
      handle: entry.handle, path: `${this.path}/${this.name}`, quarantine: `.agenc-delete-${randomUUID()}` }, onEffectStart));
  }
  async renameRegularFile(targetName: string, expected: WorkspaceBoundRegularFileIdentity, onEffectStart?: () => void): Promise<WorkspaceBoundEntryIdentity> {
    entryName(targetName);
    if (targetName === this.name) invalid("Rename requires a different target basename");
    return this.withEntry(expected, 0o100000, async (entry) => {
      if (entry.stats.size !== expected.size || entry.stats.mtimeMs !== expected.mtimeMs || entry.stats.ctimeMs !== expected.ctimeMs) {
        throw new WorkspacePathIdentityChangedError(`${this.path}/${this.name}`);
      }
      const content = (await this.filesystem.readBound(entry, `${this.path}/${this.name}`, CONTENT_BYTES)).content;
      if (createHash("sha256").update(content).digest("hex") !== expected.contentSha256) throw new WorkspacePathIdentityChangedError(`${this.path}/${this.name}`);
      const snapshot = await this.filesystem.stage(content);
      return this.filesystem.usingHandle(snapshot, async () => {
        const result = await this.filesystem.rpc("rename_file", { handle: entry.handle, expected: snapshot,
          path: `${this.path}/${this.name}`, target: targetName }, onEffectStart);
        const moved = stats(result.stats);
        if (!matchesIdentity(moved, expected)) protocol("Renamed entry does not match the original inode");
        return { dev: expected.dev, ino: expected.ino, mode: expected.mode };
      });
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.filesystem.release(this.directory.handle);
  }
}

class DockerBoundRead implements ExecutionBoundDirectoryReadCapability {
  private disposed = false;
  constructor(protected readonly filesystem: DockerExecutionFilesystem, readonly rootPath: string,
    protected readonly bound: BoundHandle) {}
  protected assertOpen(): void {
    if (this.disposed) throw new ExecutionEnvironmentError("stale_capability", "Filesystem capability is disposed", false);
  }
  async describe(): Promise<ExecutionPathDescription> {
    this.assertOpen();
    return pathDescription(await this.filesystem.rpc("describe_handle", { handle: this.bound.handle }));
  }
  async readRelativeFile(path: string, maximum: number, options?: { readonly truncate?: boolean }): Promise<WorkspaceBoundReadFile> {
    this.assertOpen(); byteLimit(maximum);
    const file = await this.filesystem.bind(path, "file", this.bound.handle);
    return this.filesystem.usingHandle(file.handle, () => this.filesystem.readBound(file, path, maximum, options?.truncate));
  }
  async readRelativeFileIfExists(path: string, maximum: number): Promise<WorkspaceBoundReadFile | undefined> {
    try { return await this.readRelativeFile(path, maximum); }
    catch (error) { if (error instanceof ExecutionEnvironmentError && error.code === "not_found") return undefined; throw error; }
  }
  async validateRelativeFile(path: string): Promise<void> {
    this.assertOpen();
    const file = await this.filesystem.bind(path, "file", this.bound.handle);
    await this.filesystem.release(file.handle);
  }
  async runRipgrep(input: BoundRipgrepInput) {
    this.assertOpen();
    if (input.relativeInputFile === undefined) return this.filesystem.runBoundRipgrep(this.rootPath, this.bound, input);
    if (input.stdin !== undefined) invalid("Bound search cannot replace file input with supplied bytes");
    const source = await this.filesystem.bind(input.relativeInputFile, "file", this.bound.handle);
    return this.filesystem.usingHandle(source.handle, () => this.filesystem.runBoundRipgrep(this.rootPath, this.bound, input, source));
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.filesystem.release(this.bound.handle);
  }
}

class DockerBoundFileRead extends DockerBoundRead implements ExecutionBoundFileReadCapability {
  private parentReleased = false;
  constructor(filesystem: DockerExecutionFilesystem, readonly filePath: string, bound: BoundHandle,
    private readonly parent: BoundHandle) {
    super(filesystem, posix.dirname(filePath), bound);
  }
  override async runRipgrep(input: BoundRipgrepInput) {
    this.assertOpen();
    if (input.relativeInputFile !== posix.basename(this.filePath) || input.stdin !== undefined) {
      invalid("An exact-file search requires its original bound input file");
    }
    return this.filesystem.runBoundRipgrep(this.rootPath, this.parent, input, this.bound);
  }
  override async dispose(): Promise<void> {
    try { await super.dispose(); }
    finally {
      if (!this.parentReleased) { this.parentReleased = true; await this.filesystem.release(this.parent.handle); }
    }
  }
  override async readRelativeFile(): Promise<never> { invalid("An exact-file capability cannot authorize relative reads"); }
  override async validateRelativeFile(): Promise<never> { invalid("An exact-file capability cannot authorize relative reads"); }
  async readFile(maximum: number): Promise<WorkspaceBoundReadFile> {
    this.assertOpen();
    return this.filesystem.readBound(this.bound, this.filePath, maximum);
  }
  async readTextWindow(offset: number, limit: number, maximum: number): Promise<WorkspaceBoundTextWindow> {
    this.assertOpen(); byteLimit(maximum);
    if (![offset, limit].every((value) => Number.isSafeInteger(value) && value >= 1)) invalid("Invalid text window");
    const sampleSize = Math.min(8192, this.bound.stats.size);
    const binarySample = sampleSize === 0 ? Buffer.alloc(0) : await this.filesystem.readChunk(this.bound.handle, 0, sampleSize);
    const selected: string[] = [];
    let totalLines = 0, lineBytes = 0, contentBytes = 0;
    let fragments: Buffer[] = [], hasLine = false, skipLf = false;
    const select = (): boolean => totalLines + 1 >= offset && selected.length < limit;
    const append = (fragment: Buffer): void => {
      if (fragment.length === 0) return;
      hasLine = true;
      if (select()) {
        lineBytes += fragment.length;
        if (lineBytes + contentBytes > maximum) throw new WorkspaceBoundReadFileTooLargeError(this.filePath, this.bound.stats.size);
        fragments.push(fragment);
      }
    };
    const endLine = (): void => {
      if (select()) {
        const line = Buffer.concat(fragments, lineBytes).toString("utf8");
        contentBytes += Buffer.byteLength(line) + (selected.length === 0 ? 0 : 1);
        if (contentBytes > maximum) throw new WorkspaceBoundReadFileTooLargeError(this.filePath, this.bound.stats.size);
        selected.push(line);
      }
      totalLines++; lineBytes = 0; fragments = []; hasLine = false;
    };
    for (let position = 0; position < this.bound.stats.size && selected.length < limit;) {
      const chunk = await this.filesystem.readChunk(this.bound.handle, position, Math.min(CHUNK_BYTES, this.bound.stats.size - position));
      if (chunk.length === 0) throw new ExecutionEnvironmentError("path_conflict", "Bound text changed during read", true, false);
      position += chunk.length;
      let start = 0;
      for (let index = 0; index < chunk.length && selected.length < limit; index++) {
        const byte = chunk[index];
        if (skipLf) { skipLf = false; if (byte === 10) { start = index + 1; continue; } }
        if (byte === 10 || byte === 13) {
          append(chunk.subarray(start, index)); endLine(); start = index + 1; skipLf = byte === 13;
        }
      }
      if (selected.length < limit) append(chunk.subarray(start));
    }
    if (hasLine && selected.length < limit) endLine();
    await this.filesystem.assertVersion(this.bound);
    return { content: selected.join("\n"), binarySample, startLine: offset,
      endLine: selected.length > 0 ? offset + selected.length - 1 : Math.max(offset, Math.min(totalLines, offset + limit - 1)),
      totalLines, numLines: selected.length, isPartial: true, stats: this.bound.stats };
  }
}

class DockerFileGuard implements WorkspaceFilePathTransactionGuard {
  private disposed = false;
  readonly targetExisted: boolean;
  constructor(private readonly filesystem: DockerExecutionFilesystem, readonly path: string,
    private readonly handle: number, private readonly backup: Buffer | undefined,
    readonly mayCreateParents: boolean) { this.targetExisted = backup !== undefined; }
  get backupContent(): Buffer | undefined { return this.backup === undefined ? undefined : Buffer.from(this.backup); }
  private assertOpen(): void {
    if (this.disposed) throw new ExecutionEnvironmentError("stale_capability", "Transaction guard is disposed", false);
  }
  private async checked<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try { return await action(); }
    catch (error) {
      if (error instanceof ExecutionEnvironmentError && error.code === "path_conflict" && error.mutationStarted === false) {
        const conflict = new WorkspacePathIdentityChangedError(this.path);
        conflict.cause = error;
        throw conflict;
      }
      throw error;
    }
  }
  async assertOriginalState(): Promise<void> { await this.checked(() => this.filesystem.rpc("assert_original", { handle: this.handle })); }
  async assertState(expected: WorkspaceFilePathExpectedState): Promise<void> {
    await this.checked(() => this.filesystem.withExpected(expected, (handle) => this.filesystem.rpc("assert", { handle: this.handle, expected: handle })));
  }
  async observeState(): Promise<WorkspaceFilePathObservedState> {
    this.assertOpen();
    try {
      const captured = await this.filesystem.capture(this.path);
      return await this.filesystem.usingHandle(captured.handle, async () => {
        const state: WorkspaceFilePathObservedState = captured.existed
          ? { kind: "content", content: (await this.filesystem.readBound(captured, this.path, CONTENT_BYTES, false, true)).content }
          : { kind: "missing" };
        await this.assertState(state);
        return state;
      });
    } catch (error) {
      if (error instanceof WorkspacePathIdentityChangedError || (error instanceof ExecutionEnvironmentError &&
          ["path_conflict", "not_found", "unsupported_resource", "file_limit", "permission_denied"].includes(error.code))) return { kind: "unreadable" };
      throw error;
    }
  }
  async prepareBoundMutation(expected: WorkspaceFilePathExpectedState, operation: "write" | "remove"): Promise<void> {
    if (operation !== "write" && operation !== "remove") invalid("Unsupported guarded mutation");
    await this.assertState(expected);
  }
  async writeBoundContent(expected: WorkspaceFilePathExpectedState, content: Buffer, onEffectStart?: () => void): Promise<void> {
    if (!Buffer.isBuffer(content) || content.length > CONTENT_BYTES) invalid("File mutation exceeds its content bound");
    const bytes = Buffer.from(content);
    await this.checked(() => this.filesystem.withExpected(expected, async (expectedHandle) => {
      const contentHandle = await this.filesystem.stage(bytes);
      await this.filesystem.usingHandle(contentHandle, () => this.filesystem.rpc("write",
        { handle: this.handle, expected: expectedHandle, content: contentHandle }, onEffectStart));
    }));
  }
  async removeBoundEntry(expected: WorkspaceFilePathExpectedState, onEffectStart?: () => void): Promise<void> {
    if (expected.kind === "missing") invalid("Removal requires an existing file");
    await this.checked(() => this.filesystem.withExpected(expected, (expectedHandle) => this.filesystem.rpc("remove",
      { handle: this.handle, expected: expectedHandle }, onEffectStart)));
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.filesystem.release(this.handle);
  }
}
