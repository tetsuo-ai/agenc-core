import {
  classifyShellWorkspaceWritePolicy,
  type ShellWorkspaceWritePolicyInput,
} from "../../llm/shell-write-policy.js";
import type { ToolPreflightFailure } from "../types.js";
import { selfTerminationRisk } from "../../permissions/self-termination.js";
import { shlexJoin } from "../../shell-command/parser.js";

export function preflightShellWorkspaceWritePolicy(
  input: Omit<ShellWorkspaceWritePolicyInput, "validationPhase">,
): ToolPreflightFailure | null {
  const selfTermination = preflightSelfTermination(input.args);
  if (selfTermination !== null) return selfTermination;
  const decision = classifyShellWorkspaceWritePolicy({
    ...input,
    validationPhase: "preflight",
  });
  return decision.blocked ? {
    code: "shell_workspace_write_policy",
    message: decision.message ?? "Shell workspace write policy blocked the command.",
  } : null;
}

export function preflightSelfTermination(input: Readonly<Record<string, unknown>>): ToolPreflightFailure | null {
  const command = input.command ?? input.cmd ?? input.chars;
  if (typeof command === "string") {
    const args = input.args;
    const risk = selfTerminationRisk(Array.isArray(args) && args.every(arg => typeof arg === "string")
      ? shlexJoin([command, ...args]) : command);
    if (risk !== null) return { code: "self_termination", message: risk };
  }
  return null;
}
