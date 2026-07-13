import type { ToolExecutionInjectedArgs } from "../tools/types.js";
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
  readonly preference?: SandboxablePreference;
  readonly enforceManagedNetwork?: boolean;
  readonly network?: NetworkProxyConfig;
  readonly networkPolicyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
  readonly agencLinuxSandboxExe?: string;
  readonly useLegacyLandlock?: boolean;
  readonly windowsSandboxLevel?: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop?: boolean;
}

export interface UnifiedExecManagerOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly maxTimeoutMs?: number;
  readonly maxProcesses?: number;
  readonly sandboxManager?: UnifiedExecSandboxManager;
}

export interface ExecCommandRequest extends ToolExecutionInjectedArgs {
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
}

export interface UnifiedExecProcessManagerLike {
  readonly maxTimeoutMs: number;
  execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput>;
  writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput>;
  /**
   * Terminate one live background process by its session/process id.
   * Prefer the request form so ownership can be checked (TOOL-01).
   * Numeric overload kept for call-site compatibility.
   */
  terminateProcess?(
    processIdOrRequest: number | TerminateProcessRequest,
  ): { terminated: boolean };
  closeAll(reason?: string): Promise<void>;
}

export class UnifiedExecError extends Error {
  readonly code:
    | "create_process"
    | "missing_command"
    | "unknown_process"
    | "stdin_closed"
    | "write_stdin"
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
