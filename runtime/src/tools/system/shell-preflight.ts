import {
  classifyShellWorkspaceWritePolicy,
  type ShellWorkspaceWritePolicyInput,
} from "../../llm/shell-write-policy.js";
import type { ToolPreflightFailure } from "../types.js";

export function preflightShellWorkspaceWritePolicy(
  input: Omit<ShellWorkspaceWritePolicyInput, "validationPhase">,
): ToolPreflightFailure | null {
  const decision = classifyShellWorkspaceWritePolicy({
    ...input,
    validationPhase: "preflight",
  });
  return decision.blocked ? {
    code: "shell_workspace_write_policy",
    message: decision.message ?? "Shell workspace write policy blocked the command.",
  } : null;
}
