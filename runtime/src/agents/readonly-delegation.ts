import type { Session } from "../session/session.js";
import type { AgentRole } from "./role.js";
import type { AgentMetadata } from "./registry.js";
import { inspectReadOnlyCommand } from "../permissions/readonly-inspection.js";
import { expandTilde, isPathAllowed, matchPathRuleContent } from "../permissions/path-validation.js";
import { hasTrustedBuiltinImplementation } from "../tools/builtin-provenance.js";
import { resolve } from "node:path";
import { getDenyRuleForTool, getRuleByContentsForTool, findMatchingContentRule } from "../permissions/rules.js";
import { canReadPathWithCwd, hasFullDiskReadAccess } from "../sandbox/engine/index.js";
import { permissionProfileForSandboxMode } from "../tools/runtimes/sandboxing.js";
import { isDirectExecEligible, lexShellCommand } from "../utils/shell/command-line.js";

const COORDINATION_TOOLS = new Set(["spawn_agent", "list_agents", "wait_agent", "close_agent", "send_message", "assign_task"]);
const NATIVE_INSPECTION_TOOLS = new Set(["FileRead", "Glob", "Grep", "system.searchTools"]);

export interface ReadOnlyDelegationTool {
  readonly name: string;
  readonly execute?: unknown;
  readonly metadata?: { readonly source?: string; readonly mutating?: boolean };
}

export function isReadOnlyCoordinationTool(tool: ReadOnlyDelegationTool): boolean {
  return hasTrustedBuiltinImplementation(tool) && COORDINATION_TOOLS.has(tool.name);
}

export function isReadOnlyCoordinationName(name: string): boolean {
  return COORDINATION_TOOLS.has(name);
}

export function readOnlyDelegationToolAvailable(tool: ReadOnlyDelegationTool): boolean {
  return hasTrustedBuiltinImplementation(tool) && (
    COORDINATION_TOOLS.has(tool.name) || NATIVE_INSPECTION_TOOLS.has(tool.name) ||
    ["exec_command", "system.bash", "write_stdin", "kill_process"].includes(tool.name)
  );
}

export function readOnlyDelegationPathAllowed(session: Session, target: string): boolean {
  const resolved = resolve(session.sessionConfiguration.cwd, target);
  const currentContext = session.permissionModeRegistry.current();
  const inheritedContext = { ...currentContext, alwaysDenyRules: { session: session.services.readOnlyDelegation?.deniedRules ?? [] } };
  const broker = session.services.sandboxExecutionBroker;
  const profile = broker?.executionAuthority?.().permissionProfile;
  if (profile?.fileSystem.entries.some((entry) => entry.access === "none" && entry.path.kind === "glob" && matchPathRuleContent(resolve(broker!.cwd, entry.path.pattern), resolved))) return false;
  return (profile === undefined || canReadPathWithCwd(profile.fileSystem, resolved, broker!.cwd, broker!.sessionTempRoot)) &&
    [currentContext, inheritedContext].every((context) => isPathAllowed(resolved, context, "read", session.sessionConfiguration.cwd).allowed);
}

export function readOnlyDelegationDeniedReadPatterns(session: Session): readonly string[] {
  const currentContext = session.permissionModeRegistry.current();
  const inheritedContext = { ...currentContext, alwaysDenyRules: { session: session.services.readOnlyDelegation?.deniedRules ?? [] } };
  return [...new Set([currentContext, inheritedContext].flatMap((context) =>
    ["FileRead", "Read"].flatMap((name) => [...getRuleByContentsForTool(context, name, "deny").keys()].map((pattern) => resolve(session.sessionConfiguration.cwd, expandTilde(pattern)))),
  ))];
}

function readOnlyGitObjectsHaveReadAuthority(session: Session): boolean {
  const broker = session.services.sandboxExecutionBroker;
  const authority = broker?.executionAuthority?.();
  if (broker === undefined || authority === undefined) return false;
  const profile = authority.permissionProfile ?? permissionProfileForSandboxMode(authority.mode, { cwd: broker.cwd });
  return profile.fileSystem.kind !== "external_sandbox" && hasFullDiskReadAccess(profile.fileSystem);
}

export function readOnlyDelegationToolRefusal(
  session: Session,
  tool: ReadOnlyDelegationTool,
  input: unknown,
): string | undefined {
  if (sessionReadOnlyDelegation(session) === undefined) return undefined;
  if (!readOnlyDelegationToolAvailable(tool)) return `Read-only delegation cannot use ${tool.name}. Report findings without changing the project or external state.`;
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const currentContext = session.permissionModeRegistry.current();
  const inheritedContext = {
    ...currentContext,
    alwaysDenyRules: { session: session.services.readOnlyDelegation?.deniedRules ?? [] },
  };
  if (getDenyRuleForTool(inheritedContext, tool.name) !== null) return "Read-only delegation retains the parent's original tool denial.";
  if (args.sandbox_permissions === "require_escalated" || args.additional_permissions !== undefined) return "Read-only delegation cannot request wider execution permissions.";
  if (tool.name === "spawn_agent" && args.isolation !== undefined && args.isolation !== "none") return "Read-only delegation cannot create a worktree. Use isolation none.";
  if (tool.name === "write_stdin" && args.chars !== undefined && args.chars !== "") return "Read-only delegation may poll its command, but cannot send interactive input.";
  if (NATIVE_INSPECTION_TOOLS.has(tool.name)) {
    const pathInput = tool.name === "FileRead" ? args.file_path : args.path ?? args.cwd;
    if (typeof pathInput === "string" && !readOnlyDelegationPathAllowed(session, pathInput)) {
      return "Read-only delegation cannot read the requested path.";
    }
  }
  if (tool.name === "exec_command" || tool.name === "system.bash") {
    const result = inspectReadOnlyCommand(tool.name, input, session.sessionConfiguration.cwd);
    if (!result.allowed) return result.reason;
    if (result.invocation.command === "git" && (readOnlyDelegationDeniedReadPatterns(session).length > 0 || !readOnlyGitObjectsHaveReadAuthority(session))) return "Read-only Git inspection cannot enforce filesystem read restrictions over repository objects. Use authorized native file reads and searches.";
    const command = tool.name === "exec_command" ? args.cmd : args.command;
    const commandRules = getRuleByContentsForTool(inheritedContext, tool.name, "deny");
    const literalCommand = [result.invocation.command, ...result.invocation.args].join(" ");
    const literalRuleMatches = [...commandRules.keys()].some((content) => {
      const parsed = lexShellCommand(content);
      return isDirectExecEligible(parsed) && parsed.tokens.map((token) => token.value).join(" ") === literalCommand;
    });
    if (literalRuleMatches || [command, literalCommand].some((candidate) => typeof candidate === "string" && findMatchingContentRule(commandRules, candidate) !== null)) return "Read-only delegation retains the parent's original command denial.";
    for (const target of result.invocation.readPaths) {
      if (!readOnlyDelegationPathAllowed(session, target)) return `Read-only inspection cannot read ${target}.`;
    }
  }
  return undefined;
}

export interface ReadOnlyDelegationConstraint {
  readonly kind: "read-only";
  readonly ownerThreadId: string;
  readonly deniedRules?: readonly string[];
}

export function normalizeReadOnlyDelegationConstraint(
  input: unknown,
): ReadOnlyDelegationConstraint | undefined {
  if (input === undefined) return undefined;
  if (
    input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "kind" && key !== "ownerThreadId" && key !== "deniedRules")
  ) {
    throw new TypeError("invalid agent execution constraint");
  }
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "read-only" || typeof value.ownerThreadId !== "string" ||
    value.ownerThreadId.trim().length === 0 || value.ownerThreadId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value.ownerThreadId)
  ) {
    throw new TypeError("invalid agent execution constraint");
  }
  if (value.deniedRules !== undefined && (!Array.isArray(value.deniedRules) || value.deniedRules.length > 4096 || value.deniedRules.some((rule) => typeof rule !== "string" || rule.length > 32_768))) {
    throw new TypeError("invalid agent execution constraint denied rules");
  }
  return Object.freeze({ kind: "read-only", ownerThreadId: value.ownerThreadId, ...(value.deniedRules !== undefined ? { deniedRules: Object.freeze([...(value.deniedRules as string[])]) } : {}) });
}

export function sessionReadOnlyDelegation(
  session: Session | null | undefined,
): ReadOnlyDelegationConstraint | undefined {
  return session?.services?.readOnlyDelegation;
}

export function sessionIsPlanning(session: Session | null | undefined): boolean {
  return session?.permissionModeRegistry?.current?.().mode === "plan";
}

export function childReadOnlyDelegation(
  session: Session,
  role: AgentRole | undefined,
  inherited?: ReadOnlyDelegationConstraint,
): ReadOnlyDelegationConstraint | undefined {
  const existing = inherited ?? sessionReadOnlyDelegation(session);
  if (existing !== undefined) return normalizeReadOnlyDelegationConstraint(existing);
  if (!sessionIsPlanning(session) && role?.config.executionConstraint !== "read-only") {
    return undefined;
  }
  return Object.freeze({ kind: "read-only", ownerThreadId: session.conversationId, deniedRules: Object.freeze(Object.values(session.permissionModeRegistry?.current?.().alwaysDenyRules ?? {}).flat()) });
}

export function readOnlyCoordinationRefusal(
  session: Session,
  senderPath: string,
  target: AgentMetadata | undefined,
  senderConstraint?: ReadOnlyDelegationConstraint,
): string | undefined {
  const constraint = senderConstraint ?? sessionReadOnlyDelegation(session);
  if (constraint === undefined && !sessionIsPlanning(session)) return undefined;
  const ownerThreadId = constraint?.ownerThreadId ?? session.conversationId;
  if (
    target?.executionConstraint?.ownerThreadId !== ownerThreadId ||
    !target.agentPath?.startsWith(`${senderPath}/`)
  ) {
    return "Read-only delegation can control only its own constrained descendants. It cannot direct writable workers or another agent subtree.";
  }
  return undefined;
}

export const READ_ONLY_DELEGATION_PROMPT =
  "This worker has permanent read-only execution authority. Read and inspect the assigned project and report findings in your final answer. Do not edit files, create worktrees, run builds or tests that write output, schedule work, request wider permissions, or leave plan mode. A later parent mode change does not remove this restriction. Use native read/search tools or one literal supported inspection command per shell call. Shell profiles, expansion, redirection, pipelines, scripts, and interactive input are unavailable.";
