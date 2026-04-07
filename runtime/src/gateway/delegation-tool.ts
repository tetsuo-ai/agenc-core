/**
 * Canonical delegation tool schema and argument parsing helpers.
 *
 * This module keeps the `execute_with_agent` contract shared across runtime
 * entry points so tool registration, routing, and execution stay aligned.
 *
 * @module
 */

import type { Tool } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import { normalizeWorkspaceRoot } from "../workflow/path-normalization.js";

export const EXECUTE_WITH_AGENT_TOOL_NAME = "execute_with_agent";

const DIRECT_EXECUTION_ERROR =
  "execute_with_agent must run through a session-scoped tool handler";

export interface ExecuteWithAgentInput {
  readonly task: string;
  readonly objective?: string;
  readonly continuationSessionId?: string;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly executionContext?: DelegationExecutionContext;
  readonly delegationAdmission?: {
    readonly shape?: string;
    readonly isolationReason?: string;
    readonly ownedArtifacts?: readonly string[];
    readonly verifierObligations?: readonly string[];
  };
  readonly spawnDecisionScore?: number;
}

export type ParseExecuteWithAgentResult =
  | { ok: true; value: ExecuteWithAgentInput }
  | { ok: false; error: string };

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toTrimmedStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result.length > 0 ? result : undefined;
}

function toOptionalScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toOptionalTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  if (rounded < 1_000 || rounded > 3_600_000) return undefined;
  return rounded;
}

function hasOwnNonEmptyString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwnNonEmptyStringArray(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return Array.isArray(value) && value.some((entry) =>
    typeof entry === "string" && entry.trim().length > 0
  );
}

function findPublicExecutionContextAuthorityFields(
  value: unknown,
): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  if (
    hasOwnNonEmptyString(record, "workspaceRoot") ||
    hasOwnNonEmptyString(record, "workspace_root")
  ) {
    fields.push("executionContext.workspaceRoot");
  }
  if (
    hasOwnNonEmptyStringArray(record, "allowedReadRoots") ||
    hasOwnNonEmptyStringArray(record, "allowed_read_roots")
  ) {
    fields.push("executionContext.allowedReadRoots");
  }
  if (
    hasOwnNonEmptyStringArray(record, "allowedWriteRoots") ||
    hasOwnNonEmptyStringArray(record, "allowed_write_roots")
  ) {
    fields.push("executionContext.allowedWriteRoots");
  }
  return fields;
}

function toPublicExecutionContext(
  value: unknown,
): DelegationExecutionContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowedTools = toTrimmedStringArray(record.allowedTools);
  const inputArtifacts = toTrimmedStringArray(record.inputArtifacts);
  const requiredSourceArtifacts = toTrimmedStringArray(
    record.requiredSourceArtifacts,
  );
  const targetArtifacts = toTrimmedStringArray(record.targetArtifacts);
  const effectClass = toNonEmptyString(record.effectClass);
  const verificationMode = toNonEmptyString(record.verificationMode);
  const stepKind = toNonEmptyString(record.stepKind);
  const fallbackPolicy = toNonEmptyString(record.fallbackPolicy);
  const resumePolicy = toNonEmptyString(record.resumePolicy);
  const approvalProfile = toNonEmptyString(record.approvalProfile);

  if (
    !allowedTools &&
    !inputArtifacts &&
    !requiredSourceArtifacts &&
    !targetArtifacts &&
    !effectClass &&
    !verificationMode &&
    !stepKind &&
    !fallbackPolicy &&
    !resumePolicy &&
    !approvalProfile
  ) {
    return undefined;
  }

  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(inputArtifacts ? { inputArtifacts } : {}),
    ...(requiredSourceArtifacts ? { requiredSourceArtifacts } : {}),
    ...(targetArtifacts ? { targetArtifacts } : {}),
    ...(effectClass ? { effectClass: effectClass as any } : {}),
    ...(verificationMode ? { verificationMode: verificationMode as any } : {}),
    ...(stepKind ? { stepKind: stepKind as any } : {}),
    ...(fallbackPolicy ? { fallbackPolicy: fallbackPolicy as any } : {}),
    ...(resumePolicy ? { resumePolicy: resumePolicy as any } : {}),
    ...(approvalProfile ? { approvalProfile: approvalProfile as any } : {}),
  };
}

function toDelegationAdmission(value: unknown): ExecuteWithAgentInput["delegationAdmission"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ownedArtifacts =
    toTrimmedStringArray(record.ownedArtifacts) ??
    toTrimmedStringArray(record.owned_artifacts);
  const verifierObligations =
    toTrimmedStringArray(record.verifierObligations) ??
    toTrimmedStringArray(record.verifier_obligations);
  const shape =
    toNonEmptyString(record.shape) ??
    toNonEmptyString(record.delegationShape) ??
    toNonEmptyString(record.delegation_shape);
  const isolationReason =
    toNonEmptyString(record.isolationReason) ??
    toNonEmptyString(record.isolation_reason);
  if (!shape && !isolationReason && !ownedArtifacts && !verifierObligations) {
    return undefined;
  }
  return {
    ...(shape ? { shape } : {}),
    ...(isolationReason ? { isolationReason } : {}),
    ...(ownedArtifacts ? { ownedArtifacts } : {}),
    ...(verifierObligations ? { verifierObligations } : {}),
  };
}

export interface DelegatedWorkingDirectoryResolution {
  readonly path: string;
  readonly source: "execution_envelope";
}

interface DelegatedWorkingDirectoryInput {
  readonly task?: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly executionContext?: DelegationExecutionContext;
}

function expandHomeDirectory(rawPath: string): string {
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~\\")
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home || home.trim().length === 0) return rawPath;
    if (rawPath === "~") return home;
    return `${home}${rawPath.slice(1)}`;
  }
  return rawPath;
}

function normalizeDelegatedPathToken(rawPath: string): string {
  const expanded = expandHomeDirectory(rawPath.trim());
  const withoutTrailingPunctuation = expanded.replace(/[),.;:]+$/g, "");
  if (withoutTrailingPunctuation === "/") return "/";
  return withoutTrailingPunctuation.replace(/\/+$/g, "");
}

export function resolveDelegatedWorkingDirectory(
  input: DelegatedWorkingDirectoryInput,
): DelegatedWorkingDirectoryResolution | undefined {
  // Audit S1.6: normalize the workspace root before passing it as the
  // child working directory so the spawned subagent sees the same
  // canonical path the parent verifier and contract checks see.
  const explicitWorkspaceRoot = normalizeWorkspaceRoot(
    input.executionContext?.workspaceRoot,
  );
  if (explicitWorkspaceRoot) {
    return {
      path: normalizeDelegatedPathToken(explicitWorkspaceRoot),
      source: "execution_envelope",
    };
  }
  return undefined;
}

export function parseExecuteWithAgentInput(
  args: Record<string, unknown>,
): ParseExecuteWithAgentResult {
  const objective = toNonEmptyString(args.objective);
  const task = toNonEmptyString(args.task) ?? objective;
  if (!task) {
    return {
      ok: false,
      error:
        'execute_with_agent requires a non-empty "task" string (or "objective")',
    };
  }

  const tools = toTrimmedStringArray(args.tools);
  const requiredToolCapabilities =
    toTrimmedStringArray(args.requiredToolCapabilities) ??
    toTrimmedStringArray(args.required_tool_capabilities) ??
    toTrimmedStringArray(args.requiredCapabilities);
  const acceptanceCriteria =
    toTrimmedStringArray(args.acceptanceCriteria) ??
    toTrimmedStringArray(args.acceptance_criteria);
  if (Object.hasOwn(args, "execution_context")) {
    return {
      ok: false,
      error:
        'execute_with_agent does not accept "execution_context" on the public path; runtime owns child scope authority.',
    };
  }
  const blockedAuthorityFields = findPublicExecutionContextAuthorityFields(
    args.executionContext,
  );
  if (blockedAuthorityFields.length > 0) {
    return {
      ok: false,
      error:
        `execute_with_agent does not accept ${blockedAuthorityFields.join(", ")} on the public path; runtime owns the first trusted child root.`,
    };
  }
  const explicitExecutionContext = toPublicExecutionContext(args.executionContext);

  return {
    ok: true,
    value: {
      task,
      objective,
      continuationSessionId:
        toNonEmptyString(args.continuationSessionId) ??
        toNonEmptyString(args.subagentSessionId),
      timeoutMs: toOptionalTimeout(args.timeoutMs),
      tools,
      requiredToolCapabilities,
      inputContract:
        toNonEmptyString(args.inputContract) ??
        toNonEmptyString(args.input_contract),
      acceptanceCriteria,
      executionContext: explicitExecutionContext,
      delegationAdmission:
        toDelegationAdmission(args.delegationAdmission) ??
        toDelegationAdmission(args.delegation_admission),
      spawnDecisionScore:
        toOptionalScore(args.spawnDecisionScore) ??
        toOptionalScore(args.spawn_decision_score) ??
        toOptionalScore(args.delegationScore) ??
        toOptionalScore(args.delegation_score) ??
        toOptionalScore(args.utilityScore),
    },
  };
}

/**
 * Registerable tool definition for `execute_with_agent`.
 *
 * Runtime execution happens in the session tool-handler layer where session
 * identity and lifecycle dependencies are available.
 */
export function createExecuteWithAgentTool(): Tool {
  return {
    name: EXECUTE_WITH_AGENT_TOOL_NAME,
    description:
      "Delegate a bounded child objective to a sub-agent with scoped tools, then return the child result.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Child task objective to execute",
        },
        objective: {
          type: "string",
          description: "Alias for task when planner emits objective-centric payloads",
        },
        tools: {
          type: "array",
          description: "Optional explicit tool allowlist for the child task",
          items: { type: "string" },
        },
        requiredToolCapabilities: {
          type: "array",
          description: "Capability-oriented tool requirements for child execution",
          items: { type: "string" },
        },
        timeoutMs: {
          type: "number",
          description: "Optional child timeout in milliseconds (1000-3600000)",
        },
        inputContract: {
          type: "string",
          description: "Optional output format contract for child execution",
        },
        acceptanceCriteria: {
          type: "array",
          description: "Optional acceptance criteria checklist for the child task",
          items: { type: "string" },
        },
        executionContext: {
          type: "object",
          description:
            "Optional bounded artifact and verification hints for the child task. The runtime derives child workspace scope from trusted parent state.",
          properties: {
            allowedTools: {
              type: "array",
              items: { type: "string" },
            },
            inputArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            requiredSourceArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            targetArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            effectClass: {
              type: "string",
            },
            verificationMode: {
              type: "string",
            },
            stepKind: {
              type: "string",
            },
            fallbackPolicy: {
              type: "string",
            },
            resumePolicy: {
              type: "string",
            },
            approvalProfile: {
              type: "string",
            },
          },
        },
        delegationAdmission: {
          type: "object",
          description:
            "Optional runtime-owned delegation admission record describing why this child is isolated",
          properties: {
            shape: {
              type: "string",
            },
            isolationReason: {
              type: "string",
            },
            ownedArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            verifierObligations: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        spawnDecisionScore: {
          type: "number",
          description: "Optional planner/policy delegation score for policy gating",
        },
      },
      required: ["task"],
    },
    execute: async () => ({
      content: safeStringify({ error: DIRECT_EXECUTION_ERROR }),
      isError: true,
    }),
  };
}
