import type { ToolExecutionInjectedArgs } from "../tools/types.js";
import type { ReadOnlyInspectionInvocation } from "../permissions/readonly-inspection.js";
import type {
  AdditionalPermissionProfile,
  NetworkProxyConfig,
  PermissionProfile,
  SandboxManager,
  SandboxablePreference,
  WindowsSandboxLevel,
} from "../sandbox/engine/index.js";
import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../sandbox/network-policy.js";

export type UnifiedExecStream = "stdout" | "stderr";

export interface UnifiedExecProgressEvent {
  readonly chunk: string;
  readonly stream: UnifiedExecStream;
  readonly processId?: number;
}

export interface UnifiedExecObserver {
  readonly onBegin?: (begin: {
    readonly callId: string;
    readonly command: string;
    readonly cwd: string;
    readonly processId: number;
    readonly tty: boolean;
  }) => void;
  readonly onEnd?: (end: {
    readonly callId: string;
    readonly exitCode: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly durationMs: number;
    readonly processId?: number;
    readonly sessionId?: number;
    readonly tty?: boolean;
  }) => void;
}

export type UnifiedExecSandboxManager = Pick<
  SandboxManager,
  "selectInitial" | "transform"
>;

export interface UnifiedExecRuntimeSandbox {
  readonly permissionProfile: PermissionProfile;
  readonly additionalPermissions?: AdditionalPermissionProfile;
  readonly sandboxPolicyCwd: string;
  readonly sessionTempRoot: string;
  readonly preference?: SandboxablePreference;
  readonly enforceManagedNetwork?: boolean;
  readonly network?: NetworkProxyConfig;
  readonly networkPolicyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
  readonly agencLinuxSandboxExe?: string;
  readonly windowsSandboxLevel?: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop?: boolean;
  /** Opt-in GPU compute inside the sandbox (config `sandbox.allow_gpu`). */
  readonly allowGpu?: boolean;
}

export interface UnifiedExecManagerOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Immutable temp-root authority captured when this manager is created. */
  readonly sessionTempRoot?: string;
  readonly shellPath?: string;
  readonly commandWrapperArgv?: readonly string[];
  /** Optional cap applied only when a request explicitly supplies timeoutMs. */
  readonly maxTimeoutMs?: number;
  readonly maxProcesses?: number;
  readonly sandboxManager?: UnifiedExecSandboxManager;
  /** Injectable only for deterministic sandbox-authority drain tests. */
  readonly sandboxAuthorityQuiesceTimeoutMs?: number;
}

export interface ExecCommandRequest extends ToolExecutionInjectedArgs {
  readonly directInvocation?: ReadOnlyInspectionInvocation;
  readonly callId?: string;
  readonly cmd: string;
  readonly workdir?: string;
  readonly shell?: string;
  readonly login?: boolean;
  readonly tty?: boolean;
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
  readonly timeoutMs?: number;
  readonly observer?: UnifiedExecObserver;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  /** Conversation/agent owner id for multi-agent process isolation (TOOL-01). */
  readonly ownerId?: string;
}

/**
 * A command started with `detach: true`: a service the model wants to keep
 * running after the command returns and after the session ends. The manager
 * starts it in its own session with stdout/stderr going to a log file, waits
 * at most `yield_time_ms` for an early exit, and then neither tracks nor
 * stops it.
 */
export interface DetachedProcessRequest extends ToolExecutionInjectedArgs {
  readonly callId?: string;
  readonly cmd: string;
  readonly workdir?: string;
  readonly shell?: string;
  readonly login?: boolean;
  /** How long to wait for an early exit before returning with the process still running. */
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
  readonly observer?: UnifiedExecObserver;
}

export interface WriteStdinRequest extends ToolExecutionInjectedArgs {
  readonly callId?: string;
  readonly session_id: number;
  readonly chars?: string;
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
  /** Must match the owning session when the process was stamped with an owner. */
  readonly ownerId?: string;
}

export interface TerminateProcessRequest {
  readonly processId: number;
  readonly ownerId?: string;
}

/**
 * The model-facing, owner-scoped view of one yielded session (#2477). A
 * recovering agent enumerates *its own* live work through this view instead
 * of matching task filenames against `/proc/*\/cmdline`, which also selects
 * the AgenC CLI and its process brokers.
 */
export interface OwnedProcessView {
  /** The `session_id` exec_command returned; the handle kill_process accepts. */
  readonly sessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  /**
   * `stopping` is a stop that has been signalled but whose exit the manager
   * has not yet observed; it is reported as such rather than as a finished
   * stop so no cleanup is claimed before it is proven.
   */
  readonly status: "running" | "stopping" | "completed" | "failed" | "killed";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number;
}

export interface ListOwnedProcessesRequest {
  readonly ownerId?: string;
}

export interface TerminateOwnedProcessesRequest {
  readonly ownerId?: string;
  /**
   * Sessions to stop. Omit to stop every live yielded session the owner
   * started. Ownership of every named session is checked before any signal
   * is sent, so a refused batch has no effect.
   */
  readonly processIds?: readonly number[];
}

export interface TerminateOwnedProcessesOutcome {
  readonly results: readonly {
    readonly sessionId: number;
    /** False for an unknown or already-exited id; a benign race, not an error. */
    readonly terminated: boolean;
  }[];
}

/** Operator-visible state; taskId is unique across manager lifetimes. */
export interface UnifiedExecBackgroundProcess {
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly ownerId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: "running" | "completed" | "failed" | "killed";
  readonly exitCode?: number;
  readonly outputTail: string;
  readonly outputBytes: number;
}

export interface ExecCommandToolOutput {
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exit_code: number | null;
  readonly process_id?: number;
  readonly session_id?: number;
  readonly durationMs: number;
  readonly wall_time_seconds: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly original_token_count: number;
  /** True when the command ran with `detach: true`; AgenC neither tracks nor stops it. */
  readonly detached?: boolean;
  /** OS pid of a detached process that was still running when the yield window closed. */
  readonly pid?: number;
  /** File a detached process keeps writing its stdout and stderr to. */
  readonly log_path?: string;
  /**
   * True when processes the command left behind (a shell `&` job, nohup,
   * setsid, a daemon that forked) were still alive after the command returned
   * and the supervisor stopped them.
   */
  readonly residual_processes_terminated?: boolean;
}

export interface UnifiedExecProcessManagerLike {
  /** Explicit-timeout cap; Infinity means no configured cap. */
  readonly maxTimeoutMs: number;
  execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput>;
  /** Start a service that outlives the command and the session; see DetachedProcessRequest. */
  startDetachedProcess?(
    request: DetachedProcessRequest,
  ): Promise<ExecCommandToolOutput>;
  writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput>;
  /**
   * Terminate one live background process by its session/process id.
   * Prefer the request form so ownership can be checked (TOOL-01).
   * Numeric overload kept for call-site compatibility.
   */
  terminateProcess?(
    processIdOrRequest: number | TerminateProcessRequest,
  ): { terminated: boolean };
  /**
   * Yielded sessions the requesting owner started, live or retained after
   * exit. Never another owner's work, and never a process table scan.
   */
  listOwnedProcesses?(request: ListOwnedProcessesRequest): OwnedProcessView[];
  /**
   * Bulk stop through manager-owned identities. Named sessions keep the
   * per-id ownership rule (`owner_denied` before any signal); an unnamed
   * request stops only the owner's own live yielded sessions.
   */
  terminateOwnedProcesses?(
    request: TerminateOwnedProcessesRequest,
  ): TerminateOwnedProcessesOutcome;
  listBackgroundProcesses?(): UnifiedExecBackgroundProcess[];
  stopBackgroundProcess?(taskId: string): Promise<{ stopped: boolean }>;
  closeAll(reason?: string): Promise<void>;
}

export class UnifiedExecError extends Error {
  readonly code:
    | "create_process"
    | "tty_unavailable_in_contained_operation"
    | "missing_command"
    | "unknown_process"
    | "stdin_closed"
    | "write_stdin"
    /** The write itself failed after bytes may have reached the process. */
    | "stdin_write_failed"
    | "process_limit"
    | "owner_denied";

  constructor(
    code: UnifiedExecError["code"],
    message: string,
  ) {
    super(message);
    this.name = "UnifiedExecError";
    this.code = code;
  }
}
