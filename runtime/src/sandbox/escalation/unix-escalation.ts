import path from "node:path";

import type { ApprovalPolicy, GranularApprovalConfig } from "../../permissions/approval-policy.js";
import { isDangerousCommand, shouldUseSandbox } from "../../permissions/bash.js";
import { parseWordOnlyShellSequence } from "../../shell-command/parser.js";
import type { Decision } from "../execpolicy/decision.js";
import type { Evaluation, Policy } from "../execpolicy/policy.js";
import {
  hasAdditionalSandboxPermissions,
  normalizeSandboxPermissionsRequest,
  sandboxPermissionsRequireEscalation,
  type AdditionalSandboxPermissions,
  type SandboxPermissionsInput,
} from "./sandboxing.js";

const PROMPT_CONFLICT_REASON =
  "approval required by policy, but approval policy is never";
const REJECT_SANDBOX_APPROVAL_REASON =
  "approval required by policy, but granular sandbox approval is disabled";
export const REJECT_RULES_APPROVAL_REASON =
  "approval required by policy rule, but granular rule approval is disabled";

export type EscalationDecisionSource =
  | "prefix_rule"
  | "unmatched_command_fallback";

export type ShellEscalationExecution =
  | { readonly kind: "turn_default" }
  | { readonly kind: "unsandboxed" }
  | {
      readonly kind: "sandboxed_additional_permissions";
      readonly additionalPermissions: AdditionalSandboxPermissions;
    };

export type InterceptedExecAction =
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly decision: Decision;
      readonly source: EscalationDecisionSource;
    }
  | {
      readonly kind: "prompt";
      readonly reason: string;
      readonly execution: ShellEscalationExecution;
      readonly decision: "prompt";
      readonly source: EscalationDecisionSource;
      readonly needsEscalation: boolean;
    }
  | {
      readonly kind: "run";
      readonly execution: ShellEscalationExecution;
      readonly decision: "allow";
      readonly source: EscalationDecisionSource;
      readonly needsEscalation: boolean;
    };

export interface InterceptedExecEvaluation {
  readonly evaluation: Evaluation;
  readonly commands: readonly (readonly string[])[];
  readonly usedComplexParsing: boolean;
}

export interface InterceptedExecCommands {
  readonly commands: readonly (readonly string[])[];
  readonly usedComplexParsing: boolean;
}

export type EscalationFileSystemSandboxKind =
  | "restricted"
  | "unrestricted"
  | "external_sandbox";

export interface UnmatchedCommandContext {
  readonly approvalPolicy: ApprovalPolicy;
  readonly fileSystemSandboxKind: EscalationFileSystemSandboxKind;
  readonly sandboxPermissions?: SandboxPermissionsInput;
  readonly usedComplexParsing: boolean;
  readonly environmentLacksSandboxProtections?: boolean;
}

export function execvePromptRejectedByPolicy(
  approvalPolicy: ApprovalPolicy,
  decisionSource: EscalationDecisionSource,
  granular?: GranularApprovalConfig,
): string | null {
  if (approvalPolicy === "never") {
    return PROMPT_CONFLICT_REASON;
  }
  if (approvalPolicy !== "granular") {
    return null;
  }
  if (decisionSource === "prefix_rule" && granular?.rules === false) {
    return REJECT_RULES_APPROVAL_REASON;
  }
  if (
    decisionSource === "unmatched_command_fallback" &&
    granular?.sandbox_approval === false
  ) {
    return REJECT_SANDBOX_APPROVAL_REASON;
  }
  return null;
}

function shellRequestEscalationExecution(
  sandboxPermissions: SandboxPermissionsInput,
): ShellEscalationExecution {
  const normalized = normalizeSandboxPermissionsRequest(sandboxPermissions);
  switch (normalized.kind) {
    case "default":
      return { kind: "turn_default" };
    case "require_escalated":
      return { kind: "unsandboxed" };
    case "with_additional_permissions":
      return hasAdditionalSandboxPermissions(normalized.additionalPermissions)
        ? {
            kind: "sandboxed_additional_permissions",
            additionalPermissions: normalized.additionalPermissions,
          }
        : { kind: "turn_default" };
    default: {
      const _exhaustive: never = normalized;
      return _exhaustive;
    }
  }
}

export function determineInterceptedExecAction(opts: {
  readonly evaluation: Evaluation;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxPermissions?: SandboxPermissionsInput;
  readonly granular?: GranularApprovalConfig;
}): InterceptedExecAction {
  const source = decisionSourceForEvaluation(opts.evaluation);
  if (opts.evaluation.decision === "forbidden") {
    return {
      kind: "deny",
      reason: "Execution forbidden by policy",
      decision: opts.evaluation.decision,
      source,
    };
  }

  const policyPromptRejection =
    opts.evaluation.decision === "prompt"
      ? execvePromptRejectedByPolicy(
          opts.approvalPolicy,
          source,
          opts.granular,
        )
      : null;
  if (policyPromptRejection !== null) {
    return {
      kind: "deny",
      reason: policyPromptRejection,
      decision: opts.evaluation.decision,
      source,
    };
  }

  const policyDriven = decisionDrivenByPolicy(opts.evaluation);
  const execution =
    policyDriven
      ? { kind: "unsandboxed" as const }
      : shellRequestEscalationExecution(opts.sandboxPermissions ?? "default");

  if (opts.evaluation.decision === "prompt") {
    return {
      kind: "prompt",
      reason: "approval required by policy",
      execution,
      decision: "prompt",
      source,
      needsEscalation:
        execution.kind === "unsandboxed" ||
        execution.kind === "sandboxed_additional_permissions" ||
        policyDriven,
    };
  }

  return {
    kind: "run",
    execution,
    decision: "allow",
    source,
    needsEscalation:
      execution.kind === "unsandboxed" ||
      execution.kind === "sandboxed_additional_permissions" ||
      policyDriven,
  };
}

function decisionDrivenByPolicy(evaluation: Evaluation): boolean {
  return evaluation.matchedRules.some(
    (match) =>
      match.type === "prefix_rule_match" &&
      match.decision === evaluation.decision,
  );
}

function decisionSourceForEvaluation(
  evaluation: Evaluation,
): EscalationDecisionSource {
  return decisionDrivenByPolicy(evaluation)
    ? "prefix_rule"
    : "unmatched_command_fallback";
}

export function evaluateInterceptedExecPolicy(opts: {
  readonly policy: Policy;
  readonly program: string;
  readonly argv: readonly string[];
  readonly unmatchedCommandContext: Omit<
    UnmatchedCommandContext,
    "usedComplexParsing"
  >;
  readonly parseShellWrapper?: boolean;
}): InterceptedExecEvaluation {
  const parsed = commandsForInterceptedExecPolicyDetailed({
    program: opts.program,
    argv: opts.argv,
    parseShellWrapper: opts.parseShellWrapper ?? false,
  });
  return {
    commands: parsed.commands,
    usedComplexParsing: parsed.usedComplexParsing,
    evaluation: opts.policy.checkMultipleWithOptions(
      parsed.commands,
      (command) =>
        renderDecisionForUnmatchedCommand(command, {
          ...opts.unmatchedCommandContext,
          usedComplexParsing: parsed.usedComplexParsing,
        }),
      { resolveHostExecutables: true },
    ),
  };
}

export function commandsForInterceptedExecPolicy(opts: {
  readonly program: string;
  readonly argv: readonly string[];
  readonly parseShellWrapper?: boolean;
}): readonly (readonly string[])[] {
  return commandsForInterceptedExecPolicyDetailed(opts).commands;
}

function commandsForInterceptedExecPolicyDetailed(opts: {
  readonly program: string;
  readonly argv: readonly string[];
  readonly parseShellWrapper?: boolean;
}): InterceptedExecCommands {
  const normalizedCommand = joinProgramAndArgv(opts.program, opts.argv);
  if (opts.parseShellWrapper !== true) {
    return { commands: [normalizedCommand], usedComplexParsing: false };
  }
  const script = extractShellScript(opts.program, opts.argv);
  if (script === null) {
    return { commands: [normalizedCommand], usedComplexParsing: false };
  }
  const parsed = parseWordOnlyShellSequence(script.script);
  return parsed === null
    ? { commands: [normalizedCommand], usedComplexParsing: true }
    : { commands: parsed, usedComplexParsing: false };
}

function renderDecisionForUnmatchedCommand(
  command: readonly string[],
  context: UnmatchedCommandContext,
): Decision {
  const commandText = command.join(" ");
  if (shouldUseSandbox({ command: commandText }) && !context.usedComplexParsing) {
    return "allow";
  }

  const dangerous =
    isDangerousCommand(commandText) ||
    context.environmentLacksSandboxProtections === true;
  if (dangerous) {
    if (context.approvalPolicy === "never") {
      return context.fileSystemSandboxKind === "restricted"
        ? "forbidden"
        : "allow";
    }
    return "prompt";
  }

  switch (context.approvalPolicy) {
    case "never":
    case "on_failure":
      return "allow";
    case "untrusted":
      return "prompt";
    case "on_request":
    case "granular":
      if (
        context.fileSystemSandboxKind === "unrestricted" ||
        context.fileSystemSandboxKind === "external_sandbox"
      ) {
        return "allow";
      }
      return sandboxPermissionsRequireEscalation(context.sandboxPermissions)
        ? "prompt"
        : "allow";
    default: {
      const _exhaustive: never = context.approvalPolicy;
      return _exhaustive;
    }
  }
}

function extractShellScript(
  program: string,
  argv: readonly string[],
): { readonly shell: string; readonly flag: "-c" | "-lc"; readonly script: string } | null {
  const shell = path.basename(program);
  if (shell !== "sh" && shell !== "bash" && shell !== "zsh") {
    return null;
  }
  for (let i = 0; i + 1 < argv.length; i += 1) {
    const flag = argv[i];
    const script = argv[i + 1];
    if ((flag === "-c" || flag === "-lc") && typeof script === "string") {
      return { shell, flag, script };
    }
  }
  return null;
}

export function joinProgramAndArgv(
  program: string,
  argv: readonly string[],
): readonly string[] {
  const normalizedProgram = program.length > 0 ? program : argv[0] ?? "";
  if (argv.length === 0) return [normalizedProgram];
  const argv0 = argv[0];
  if (
    argv0 === normalizedProgram ||
    (argv0 !== undefined && path.basename(argv0) === path.basename(normalizedProgram))
  ) {
    return [normalizedProgram, ...argv.slice(1)];
  }
  return [normalizedProgram, ...argv];
}
