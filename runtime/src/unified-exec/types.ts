import type { ToolExecutionInjectedArgs } from "../tools/types.js";
import type { ReadOnlyInspectionInvocation, ReadOnlyShellInvocation } from "../permissions/readonly-inspection.js";
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

declare const ownerLifetimeBrand: unique symbol;
declare const ownerBindingBrand: unique symbol;

/** Manager-owned identity for one logical child execution lifetime. */
export interface UnifiedExecOwnerLifetime {
  readonly [ownerLifetimeBrand]: never;
  readonly ownerId: string;
  readonly closed: boolean;
  bind(): UnifiedExecOwnerBinding;
  prepareForDurableClose(): Promise<void>;
}

/** A revoked projection cannot acquire authority from a later projection. */
export interface UnifiedExecOwnerBinding {
  readonly [ownerBindingBrand]: never;
  readonly ownerId: string;
  /** Reject stale projections before Session teardown can touch shared services. */
  assertCurrent(): void;
  release(): void;
  prepareForDurableClose(): Promise<void>;
}

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
  readonly persistentSession?: boolean;
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
  /**
   * Darwin: prepare each command's contained launch while the previous one
   * runs, so a command does not wait for its gate and watchdog to start. See
   * `prepareContainedProcessLaunch`.
   */
  readonly prepareContainedLaunches?: boolean;
  /**
   * Live background sessions one owner may hold (default 8). At the limit a
   * `startInBackground` request is refused before it spawns, and a command
   * whose `onTimeout: "background"` limit passes is stopped as before.
   */
  readonly maxBackgroundSessions?: number;
  /**
   * How long a running session must have printed nothing before a poll
   * reports its processes' state (default 60 s). Injectable for tests.
   */
  readonly quietProcessStateAfterMs?: number;
}

export interface ExecCommandRequest extends ToolExecutionInjectedArgs {
  readonly ownerBinding?: UnifiedExecOwnerBinding;
  readonly directInvocation?: ReadOnlyInspectionInvocation;
  /**
   * A command line classified as read-only: it runs through the session shell
   * with the session environment, but only in this invocation's mandatory
   * no-write, no-network sandbox.
   */
  readonly readOnlyShell?: ReadOnlyShellInvocation;
  readonly callId?: string;
  readonly cmd: string;
  readonly workdir?: string;
  readonly shell?: string;
  readonly login?: boolean;
  readonly tty?: boolean;
  readonly yield_time_ms?: number;
  readonly max_output_tokens?: number;
  readonly timeoutMs?: number;
  /**
   * What happens when `timeoutMs` passes while the command still runs.
   * "kill" (the default) stops it. "background" leaves it running as a
   * tracked session: a call or poll waiting on it returns with its
   * session_id and a note, and the session stays under write_stdin,
   * kill_process, the end notice and session-end cleanup like any yielded
   * session. An abort, a kill_process, session end and the background-session
   * limit still stop it.
   */
  readonly onTimeout?: "kill" | "background";
  /**
   * The caller wants the command as a background session from the start
   * (exec_command `background: true`). Refused before spawning when the
   * owner already holds `maxBackgroundSessions` live background sessions.
   */
  readonly startInBackground?: boolean;
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
  readonly ownerId?: string;
  readonly ownerBinding?: UnifiedExecOwnerBinding;
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
  readonly ownerBinding?: UnifiedExecOwnerBinding;
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
  /** Launch authority for polled output, which may differ from the polling call. */
  readonly sandboxApplied?: boolean;
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
  /** The authenticated init observed live descendants after task exit, then
   * completed cleanup. Does not claim which actor terminated them. */
  readonly residual_processes_observed?: boolean;
  /** Cleanup is proven, but the dispatched command has no terminal report.
   * Neither state authorizes an automatic retry or a no-effect claim. */
  readonly command_outcome?: "aborted" | "unavailable";
  /**
   * The command's `onTimeout: "background"` limit (ms) passed while it ran,
   * and AgenC kept it running as `session_id`. Set on the one result that
   * first observes it.
   */
  readonly timeout_backgrounded_ms?: number;
  /**
   * The timeout passed while the owner already held this many live
   * background sessions, so AgenC stopped the command as a hard timeout.
   */
  readonly timeout_stopped_at_session_limit?: number;
  /** One line on what a session that printed nothing for a while is doing. */
  readonly process_state?: string;
}

/**
 * A background session that ended while no result was showing it: the
 * notice the next exec-family result of its owner carries. Never queued for
 * a session the model, the user or session end stopped.
 */
export interface SessionEndNotice {
  readonly sessionId: number;
  readonly command: string;
  readonly exitCode: number | null;
  /** The signal that ended it, from the exit itself or a 128+N shell status. */
  readonly signal?: string;
  /** It died by SIGKILL while the cgroup OOM killer fired (Linux). */
  readonly outOfMemory?: boolean;
  readonly durationMs: number;
}

export interface TakeSessionEndNoticesRequest {
  readonly ownerId?: string;
}

export interface UnifiedExecProcessManagerLike {
  /** Explicit-timeout cap; Infinity means no configured cap. */
  readonly maxTimeoutMs: number;
  /** Shell used when a request names none, when the manager exposes it. */
  readonly shellPath?: string;
  /** Whether commands inherit shell startup hooks (BASH_ENV, exported functions, SHELLOPTS). */
  shellStartupHooksPresent?(): boolean;
  /** Whether a read-only command line can run through the session shell here. */
  readOnlyShellAvailable?(): boolean;
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
  /**
   * Drain the end notices of the requester's background sessions that ended
   * since the last call and whose exit no result has shown yet.
   */
  takeSessionEndNotices?(request: TakeSessionEndNoticesRequest): SessionEndNotice[];
  listBackgroundProcesses?(): UnifiedExecBackgroundProcess[];
  stopBackgroundProcess?(taskId: string): Promise<{ stopped: boolean }>;
  closeAll(reason?: string): Promise<void>;
  /** Prepare an empty containment boundary; never admits or executes a command. */
  prepareOneShotCommandBoundary?(
    ownerId: string | undefined,
    ownerBinding: UnifiedExecOwnerBinding | undefined,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Concrete managers freeze admission and verify cleanup before sealing. */
  prepareForDurableClose?(): Promise<void>;
  createOwnerLifetime?(
    ownerId: string,
    parentBinding?: UnifiedExecOwnerBinding,
  ): UnifiedExecOwnerLifetime;
  assertOwnerAdmission?(ownerId: string | undefined, binding?: UnifiedExecOwnerBinding): void;
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
