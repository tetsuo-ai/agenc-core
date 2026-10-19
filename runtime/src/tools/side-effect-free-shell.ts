import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import { attachReadOnlyInspectionInvocation, inspectReadOnlyCommand,
  prepareReadOnlyInspectionInvocation } from "../permissions/readonly-inspection.js";
import type { Tool } from "./types.js";
import { sideEffectFreeTool } from "./side-effect-free.js";

const implementations = new WeakSet<Tool["execute"]>();
export function observationCapableShell<T extends Tool>(tool: T): T {
  implementations.add(tool.execute);
  return tool;
}

/** A literal inspection is executed as a verified native program, never via
 * a shell/profile/PATH override, in a mandatory no-write/no-network sandbox.
 * Unsupported commands retain the original durable dispatch unchanged. */
export async function prepareShellObservation(tool: Tool, args: Record<string, unknown>,
  cwd: string, broker?: SandboxExecutionBrokerLike): Promise<Tool | undefined> {
  if (!implementations.has(tool.execute) || tool.name !== "exec_command" ||
      !broker?.forkForReadOnlyInspection || args.detach === true ||
      args.dangerouslyDisableSandbox === true) return undefined;
  const inspected = inspectReadOnlyCommand(tool.name, args, cwd, { enforceWorkspaceBoundary: false });
  if (!inspected.allowed) return undefined;
  // Keep AgenC's existing command validation as an independent gate.
  const { checkReadOnlyConstraints } = await import("./BashTool/readOnlyValidation.js");
  if (checkReadOnlyConstraints({ command: args.cmd as string }, false).behavior !== "allow") return undefined;
  try {
    const boundary = broker.forkForReadOnlyInspection(inspected.invocation.cwd);
    const sandbox = boundary.runtimeSandbox("tool");
    if (!sandbox) return undefined;
    const invocation = prepareReadOnlyInspectionInvocation(inspected.invocation, sandbox);
    const identity = JSON.stringify(inspected.invocation);
    return sideEffectFreeTool({ ...tool, isReadOnly: true, recoveryCategory: "idempotent",
      metadata: { ...tool.metadata, source: "builtin", mutating: false },
      async execute(runtimeArgs) {
        const current = inspectReadOnlyCommand(tool.name, runtimeArgs, cwd, { enforceWorkspaceBoundary: false });
        if (!current.allowed || JSON.stringify(current.invocation) !== identity || runtimeArgs.detach === true ||
            runtimeArgs.dangerouslyDisableSandbox === true) throw new Error("Read-only inspection changed after approval");
        // Recheck current session lifecycle authority as well as the pinned
        // executable identity (checked again by exec_command before launch).
        broker.forkForReadOnlyInspection!(current.invocation.cwd);
        attachReadOnlyInspectionInvocation(runtimeArgs, invocation);
        return tool.execute(runtimeArgs);
      },
    });
  } catch { return undefined; }
}
