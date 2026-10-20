import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { attachReadOnlyInspectionInvocation, attachReadOnlyShellInvocation, inspectReadOnlyCommand,
  inspectReadOnlyShellCommand, prepareReadOnlyInspectionInvocation,
  prepareReadOnlyShellInvocation } from "../permissions/readonly-inspection.js";
import type { UnifiedExecRuntimeSandbox } from "../unified-exec/types.js";
import type { Tool, ToolResult } from "./types.js";
import { sideEffectFreeTool } from "./side-effect-free.js";

export interface ShellObservationOptions {
  /** Whether a read-only command line can run through the session shell. */
  readonly readOnlyShellAvailable?: () => boolean;
}

const implementations = new WeakMap<Tool["execute"], ShellObservationOptions>();
export function observationCapableShell<T extends Tool>(tool: T, options: ShellObservationOptions = {}): T {
  implementations.set(tool.execute, options);
  return tool;
}

/**
 * Command lines (with their cwd) that ran read-only for an owner and did not
 * succeed. Running one read-only again could only fail the same way, so the
 * next identical call takes the ordinary path. That is the model's explicit
 * retry, never an automatic one: a failed read-only run returns its own
 * failure.
 */
const MAX_REMEMBERED_FAILURES = 256;
const failedReadOnlyCommands = new WeakMap<object, Set<string>>();
const failureKey = (cwd: string, command: string): string => `${cwd}\u0000${command}`;
function rememberFailure(owner: object, key: string): void {
  let failed = failedReadOnlyCommands.get(owner);
  if (failed === undefined) {
    failed = new Set();
    failedReadOnlyCommands.set(owner, failed);
  }
  failed.delete(key);
  failed.add(key);
  if (failed.size > MAX_REMEMBERED_FAILURES) failed.delete(failed.values().next().value!);
}

/** Anything but a clean exit: an error result, a nonzero status or a signal. */
function readOnlyRunFailed(result: ToolResult): boolean {
  if (result.isError === true) return true;
  const exitCode = (result.metadata as { exitCode?: unknown } | undefined)?.exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

/**
 * The one sandbox ingress for both read-only routes: the session broker
 * narrowed to read-only (every write grant lowered to read, read denials kept,
 * network disabled). Each call also rechecks the broker's lifecycle authority.
 */
function readOnlyRuntimeSandbox(broker: SandboxExecutionBrokerLike, cwd: string): UnifiedExecRuntimeSandbox | undefined {
  return broker.forkForReadOnlyInspection?.(cwd)?.runtimeSandbox("tool");
}

const observationMetadata = (tool: Tool): Partial<Tool> => ({
  isReadOnly: true, recoveryCategory: "idempotent",
  metadata: { ...tool.metadata, source: "builtin", mutating: false },
});

export interface ShellObservationContext {
  /** Owner (the session) whose failed read-only command lines are remembered; command lines need one. */
  readonly owner?: object;
  /**
   * Whether the ordinary path would run this call in a platform sandbox. Only
   * then does a read-only run see the same owners, processes and mounts: a
   * sandbox the ordinary path lacks would, for instance, list root-owned files
   * as nobody. Without it the call keeps the ordinary path.
   */
  readonly ordinaryPathSandboxed: boolean;
}

/**
 * Run a shell call as an observation when it cannot write or reach a network.
 * A literal inspection is executed as a verified native program, never via a
 * shell/profile/PATH override. A command line the read-only classification
 * admits (pipes, lists, cd, loops) runs through the session shell exactly as
 * the ordinary path would, but in the same mandatory no-write, no-network
 * sandbox, so a misclassified command fails on the refused write instead of
 * writing. Unsupported commands retain the original durable dispatch
 * unchanged; a chosen read-only run never falls back to it.
 */
export async function prepareShellObservation(tool: Tool, args: Record<string, unknown>,
  cwd: string, broker: SandboxExecutionBrokerLike | undefined, context: ShellObservationContext): Promise<Tool | undefined> {
  const options = implementations.get(tool.execute);
  if (options === undefined || tool.name !== "exec_command" || !context.ordinaryPathSandboxed ||
      !broker?.forkForReadOnlyInspection || args.detach === true ||
      args.dangerouslyDisableSandbox === true) return undefined;
  return await prepareInspectionObservation(tool, args, cwd, broker) ??
    prepareReadOnlyShellObservation(tool, args, cwd, broker, options, context.owner);
}

async function prepareInspectionObservation(tool: Tool, args: Record<string, unknown>, cwd: string,
  broker: SandboxExecutionBrokerLike): Promise<Tool | undefined> {
  const inspected = inspectReadOnlyCommand(tool.name, args, cwd, { enforceWorkspaceBoundary: false });
  if (!inspected.allowed) return undefined;
  // Keep AgenC's existing command validation as an independent gate.
  const { checkReadOnlyConstraints } = await import("./BashTool/readOnlyValidation.js");
  if (checkReadOnlyConstraints({ command: args.cmd as string }, false).behavior !== "allow") return undefined;
  try {
    const sandbox = readOnlyRuntimeSandbox(broker, inspected.invocation.cwd);
    if (!sandbox) return undefined;
    const invocation = prepareReadOnlyInspectionInvocation(inspected.invocation, sandbox);
    const identity = JSON.stringify(inspected.invocation);
    return sideEffectFreeTool({ ...tool, ...observationMetadata(tool),
      async execute(runtimeArgs) {
        const current = inspectReadOnlyCommand(tool.name, runtimeArgs, cwd, { enforceWorkspaceBoundary: false });
        if (!current.allowed || JSON.stringify(current.invocation) !== identity || runtimeArgs.detach === true ||
            runtimeArgs.dangerouslyDisableSandbox === true) throw new Error("Read-only inspection changed after approval");
        // Recheck current session lifecycle authority as well as the pinned
        // executable identity (checked again by exec_command before launch).
        readOnlyRuntimeSandbox(broker, current.invocation.cwd);
        attachReadOnlyInspectionInvocation(runtimeArgs, invocation);
        return tool.execute(runtimeArgs);
      },
    });
  } catch { return undefined; }
}

async function prepareReadOnlyShellObservation(tool: Tool, args: Record<string, unknown>, cwd: string,
  broker: SandboxExecutionBrokerLike, options: ShellObservationOptions, owner: object | undefined): Promise<Tool | undefined> {
  if (owner === undefined || options.readOnlyShellAvailable?.() !== true) return undefined;
  const inspected = inspectReadOnlyShellCommand(args, cwd);
  if (!inspected.allowed) return undefined;
  const key = failureKey(inspected.invocation.cwd, inspected.invocation.command);
  if (failedReadOnlyCommands.get(owner)?.has(key) === true) return undefined;
  try {
    const sandbox = readOnlyRuntimeSandbox(broker, inspected.invocation.cwd);
    if (!sandbox) return undefined;
    const invocation = prepareReadOnlyShellInvocation(inspected.invocation, sandbox);
    return sideEffectFreeTool({ ...tool, ...observationMetadata(tool),
      async execute(runtimeArgs) {
        const current = inspectReadOnlyShellCommand(runtimeArgs, cwd);
        if (!current.allowed || current.invocation.command !== invocation.command ||
            current.invocation.cwd !== invocation.cwd || runtimeArgs.detach === true ||
            runtimeArgs.dangerouslyDisableSandbox === true) throw new Error("Read-only command changed after approval");
        readOnlyRuntimeSandbox(broker, current.invocation.cwd);
        attachReadOnlyShellInvocation(runtimeArgs, invocation);
        let result: ToolResult;
        try {
          result = await tool.execute(runtimeArgs);
        } catch (error) {
          rememberFailure(owner, key);
          throw error;
        }
        if (readOnlyRunFailed(result)) rememberFailure(owner, key);
        return result;
      },
    });
  } catch { return undefined; }
}
