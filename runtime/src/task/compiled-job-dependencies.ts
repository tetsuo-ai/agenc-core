import type { TaskExecutionContext } from "./types.js";

export type CompiledJobDependencyDenyReason =
  | "dependency_preflight_failed"
  | "dependency_chat_executor_unavailable"
  | "dependency_tool_registry_unavailable"
  | "dependency_policy_runtime_unavailable"
  | "dependency_network_broker_unavailable"
  | "dependency_sandbox_unavailable"
  | "dependency_review_broker_unavailable";

export interface CompiledJobDependencyDecision {
  readonly allowed: boolean;
  readonly reason?: CompiledJobDependencyDenyReason;
  readonly message?: string;
  readonly dependency?: string;
}

export type CompiledJobDependencyCheck = (
  context: TaskExecutionContext,
) =>
  | CompiledJobDependencyDecision
  | Promise<CompiledJobDependencyDecision>;

export interface EvaluateCompiledJobDependencyChecksOptions {
  readonly context: TaskExecutionContext;
  readonly checks?: readonly CompiledJobDependencyCheck[];
}

export async function evaluateCompiledJobDependencyChecks(
  options: EvaluateCompiledJobDependencyChecksOptions,
): Promise<CompiledJobDependencyDecision> {
  for (const check of options.checks ?? []) {
    try {
      const decision = await check(options.context);
      if (!decision.allowed) {
        return {
          allowed: false,
          reason: decision.reason ?? "dependency_preflight_failed",
          message:
            decision.message ??
            "Compiled job dependency preflight denied execution",
          ...(decision.dependency ? { dependency: decision.dependency } : {}),
        };
      }
    } catch (error) {
      return {
        allowed: false,
        reason: "dependency_preflight_failed",
        message: formatDependencyPreflightError(error),
      };
    }
  }

  return { allowed: true };
}

function formatDependencyPreflightError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Compiled job dependency preflight failed: ${error.message}`;
  }
  return "Compiled job dependency preflight failed";
}
