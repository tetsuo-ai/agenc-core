import type {
  WorkspaceBoundDirectoryMutation,
  WorkspaceBoundDirectoryIdentity,
  WorkspaceBoundFileReadCapability,
  WorkspaceBoundReadCapability,
  WorkspaceFilePathTransactionGuard,
} from "../workspace/file-mutation-transaction.js";

/** Operator input at bootstrap. Task instructions cannot replace this selector. */
export type ExecutionTarget =
  | { readonly kind: "local" }
  | { readonly kind: "docker"; readonly container: string };

/** Persisted identity contains no host PID, control socket or credential. */
export type ExecutionEnvironmentBinding =
  | { readonly kind: "local" }
  | {
      readonly kind: "docker";
      readonly containerId: string;
      readonly generation: string;
      /** Prevent restored handles from binding to a replacement receipt store. */
      readonly processHandleNamespace: string;
    };

/** Existing canonical call identity, captured after admission. */
export interface ExecutionCallIdentity {
  readonly runId: string;
  readonly callId: string;
  readonly attempt: number;
}

/** A physical operation remains subordinate to the admitted logical call. */
export interface ExecutionOperationIdentity extends ExecutionCallIdentity {
  /** Missing means index zero for older operational receipts. */
  readonly operationIndex?: number;
}

export interface ExecutionProcessSpecification {
  readonly program: string;
  readonly argv: readonly string[];
  readonly argv0?: string;
  readonly cwd: string;
  /** Explicit task environment. Never merged with the controller's process.env. */
  readonly environment: Readonly<Record<string, string>>;
  readonly terminal: boolean;
  readonly lifetime: "operation" | "environment";
}

export interface ExecutionProcessReceipt {
  readonly operationId: string;
  readonly leaderExited: boolean;
  readonly outputComplete: boolean;
  readonly cleanupProven: boolean;
  readonly exitCode: number | null;
  /** Observed descendants after leader exit, followed by proved scope cleanup. */
  readonly residualProcessesTerminated?: boolean;
  readonly failure?: string;
  readonly detachedService?: {
    readonly logPath: string;
    readonly startupState: "waiting" | "prepared" | "bootstrap_closed" | "failed";
    readonly pid?: number;
    readonly error?: string;
  };
}

export interface ExecutionOutputChunk {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly nextOffset: number;
}

/** An environment owns process creation, I/O and strict cleanup. No host-spawn callbacks. */
export interface ExecutionProcess {
  readonly operationId: string;
  /** Durable within the environment host's processHandleNamespace; never a PID. */
  readonly sessionId: number;
  readonly specification: ExecutionProcessSpecification;
  inspect(): Promise<ExecutionProcessReceipt>;
  output(offset: number, maximumBytes?: number): Promise<ExecutionOutputChunk>;
  write(identity: ExecutionOperationIdentity, bytes: Buffer, eof?: boolean,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  terminate(): Promise<{ readonly terminated: boolean; readonly cleanupProven: boolean }>;
}

/** Exact descriptor metadata. Decimal strings preserve inode and timestamp bits. */
export interface ExecutionFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface ExecutionPathDescription {
  readonly canonicalPath: string;
  readonly identity: ExecutionFileIdentity;
}

export interface ExecutionFileSnapshotCapability {
  /** Revalidate pathname provenance against the same held descriptor. */
  describe(): Promise<ExecutionPathDescription>;
  readFile(maximumBytes: number): Promise<Buffer>;
  dispose(): Promise<void>;
}

export interface ExecutionDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface ExecutionDirectorySnapshotCapability {
  describe(): Promise<ExecutionPathDescription>;
  /** One cursor per capability. Consumers may stop without scanning the rest. */
  entries(): AsyncIterable<ExecutionDirectoryEntry>;
  dispose(): Promise<void>;
}

export interface ExecutionBoundFileReadCapability extends WorkspaceBoundFileReadCapability {
  describe(): Promise<ExecutionPathDescription>;
}

export interface ExecutionBoundDirectoryReadCapability extends WorkspaceBoundReadCapability {
  describe(): Promise<ExecutionPathDescription>;
}

export interface ExecutionFilesystem {
  /** Read the exact observed symlink entry without following it or running task code. */
  readLink(expected: ExecutionPathDescription): Promise<string>;
  /** Exclusive mkdir beneath a validated held parent; never follows the new entry. */
  createDirectory(parent: ExecutionPathDescription, name: string, mode: number): Promise<void>;
  describePath(path: string, options?: { readonly followSymlinks?: boolean }): Promise<ExecutionPathDescription>;
  bindFileSnapshot(path: string): Promise<ExecutionFileSnapshotCapability>;
  bindDirectorySnapshot(path: string): Promise<ExecutionDirectorySnapshotCapability>;
  /** Confined metadata only; special resources never receive I/O descriptors. */
  inspectPath(path: string, options?: { readonly followSymlinks?: boolean }):
    Promise<import("../workspace/file-mutation-transaction.js").WorkspaceBoundReadFileStats>;
  bindDirectoryRead(path: string): Promise<ExecutionBoundDirectoryReadCapability>;
  bindFileRead(path: string): Promise<ExecutionBoundFileReadCapability>;
  captureFileGuard(path: string): Promise<WorkspaceFilePathTransactionGuard>;
  bindDirectoryMutation(parent: WorkspaceBoundDirectoryIdentity, entryName: string): Promise<WorkspaceBoundDirectoryMutation>;
  readFile(path: string, maximumBytes: number): Promise<Buffer>;
  readDirectory(path: string): Promise<readonly ExecutionDirectoryEntry[]>;
}

export interface ExecutionEnvironment {
  readonly binding: ExecutionEnvironmentBinding;
  readonly ownerId: string;
  readonly authorityRevision: number;
  /** Persist alongside handles; a replacement receipt store cannot restore them. */
  readonly processHandleNamespace: string;
  readonly filesystem: ExecutionFilesystem;
  launch(specification: ExecutionProcessSpecification, identity: ExecutionOperationIdentity,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }): Promise<ExecutionProcess>;
  reconnect(identity: ExecutionOperationIdentity): Promise<ExecutionProcess | undefined>;
  /** Drain operation scopes. Environment-lifetime services retain their scopes. */
  close(): Promise<void>;
}

export class ExecutionEnvironmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** True once the host request may have crossed dispatch. Never a replay hint. */
    readonly requestSent: boolean,
    readonly mutationStarted?: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionEnvironmentError";
  }
}

export function executionEnvironmentCacheKey(binding: ExecutionEnvironmentBinding, path: string): string {
  return JSON.stringify(binding.kind === "local"
    ? ["local", path]
    : ["docker", binding.containerId, binding.generation, binding.processHandleNamespace, path]);
}
