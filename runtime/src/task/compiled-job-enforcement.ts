import type { ChatExecuteParams } from "../llm/chat-executor-types.js";
import { PolicyEngine } from "../policy/engine.js";
import type {
  PolicyEvaluationScope,
  RuntimePolicyConfig,
} from "../policy/types.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import {
  createExecutionEnvelope,
  type ExecutionEffectClass,
  type ExecutionEnvelope,
  type ExecutionVerificationMode,
} from "../workflow/execution-envelope.js";
import type { CompiledJob, CompiledJobAllowedTool } from "./compiled-job.js";

const WORKSPACE_READ_RUNTIME_TOOLS = [
  "system.readFile",
  "system.listDir",
  "system.stat",
  "system.glob",
  "system.grep",
  "system.repoInventory",
] as const;

const WORKSPACE_WRITE_RUNTIME_TOOLS = [
  "system.writeFile",
  "system.appendFile",
  "system.editFile",
  "system.mkdir",
] as const;

const NETWORK_RUNTIME_TOOLS = ["system.httpGet"] as const;
const LOCAL_EXTRACT_RUNTIME_TOOLS = ["system.pdfExtractText"] as const;
const APPROVED_CHECK_RUNTIME_TOOLS = ["system.bash"] as const;

export interface ResolveCompiledJobEnforcementOptions {
  readonly workspaceRoot?: string;
  readonly inputArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
}

export interface CompiledJobChatExecutionPolicy
  extends Pick<
    ChatExecuteParams,
    | "contextInjection"
    | "maxToolRounds"
    | "requestTimeoutMs"
    | "requiredToolEvidence"
    | "toolBudgetPerRequest"
    | "toolRouting"
  > {}

export interface CompiledJobEnforcement {
  readonly allowedRuntimeTools: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly executionEnvelope: ExecutionEnvelope;
  readonly runtimePolicy: RuntimePolicyConfig;
  readonly chat: CompiledJobChatExecutionPolicy;
  readonly scope: PolicyEvaluationScope;
  readonly sideEffectPolicy: CompiledJobSideEffectPolicy;
}

export interface CompiledJobSideEffectPolicy {
  readonly riskTier: CompiledJob["policy"]["riskTier"];
  readonly approvalRequired: boolean;
  readonly humanReviewGate: CompiledJob["policy"]["humanReviewGate"];
  readonly allowedMutatingRuntimeTools: readonly string[];
}

export function resolveCompiledJobEnforcement(
  compiledJob: CompiledJob,
  options: ResolveCompiledJobEnforcementOptions = {},
): CompiledJobEnforcement {
  const workspaceRoot =
    options.workspaceRoot ?? compiledJob.executionContext?.workspaceRoot;
  const inputArtifacts =
    options.inputArtifacts ?? compiledJob.executionContext?.inputArtifacts;
  const targetArtifacts =
    options.targetArtifacts ?? compiledJob.executionContext?.targetArtifacts;
  const allowedRuntimeTools = resolveRuntimeToolNames(compiledJob);
  const allowedHosts = resolveAllowedHosts(compiledJob.policy.allowedDomains);
  const runtimeWindowMs = Math.max(
    60_000,
    compiledJob.policy.maxRuntimeMinutes * 60_000,
  );
  const allowWorkspaceRead =
    workspaceRoot !== undefined &&
    (compiledJob.policy.writeScope === "workspace_only" ||
      compiledJob.policy.allowedTools.some((tool) =>
        requiresWorkspaceRead(compiledJob, tool)
      ));
  const allowWorkspaceWrite =
    workspaceRoot !== undefined &&
    compiledJob.policy.writeScope === "workspace_only";
  const effectClass: ExecutionEffectClass =
    compiledJob.policy.writeScope === "workspace_only"
      ? "filesystem_write"
      : "read_only";
  const verificationMode: ExecutionVerificationMode =
    compiledJob.policy.writeScope === "workspace_only"
      ? "conditional_mutation"
      : "grounded_read";
  const executionEnvelope =
    createExecutionEnvelope({
      workspaceRoot,
      allowedReadRoots: allowWorkspaceRead
        ? [workspaceRoot]
        : undefined,
      allowedWriteRoots: allowWorkspaceWrite
        ? [workspaceRoot]
        : undefined,
      allowedTools: allowedRuntimeTools,
      inputArtifacts,
      targetArtifacts,
      effectClass,
      verificationMode,
      completionContract: undefined,
    }) ?? {
      version: "v1",
      allowedTools: allowedRuntimeTools,
    };
  const scope: PolicyEvaluationScope = {
    sessionId: `task:${compiledJob.source.taskPda}`,
    channel: "task_executor",
    projectId: compiledJob.audit.templateId,
    runId: compiledJob.source.taskPda,
  };
  const runtimePolicy = buildRuntimePolicy({
    compiledJob,
    allowedRuntimeTools,
    allowedHosts,
    runtimeWindowMs,
    allowWorkspaceWriteRoot: allowWorkspaceWrite
      ? workspaceRoot
      : undefined,
  });
  const sideEffectPolicy: CompiledJobSideEffectPolicy = {
    riskTier: compiledJob.policy.riskTier,
    approvalRequired: compiledJob.policy.approvalRequired,
    humanReviewGate: compiledJob.policy.humanReviewGate,
    allowedMutatingRuntimeTools: resolveAllowedMutatingRuntimeTools(compiledJob),
  };

  return {
    allowedRuntimeTools,
    allowedHosts,
    executionEnvelope,
    runtimePolicy,
    scope,
    sideEffectPolicy,
    chat: {
      contextInjection: {
        skills: false,
        memory: compiledJob.policy.memoryScope !== "job_only",
      },
      maxToolRounds: compiledJob.policy.maxToolCalls,
      toolBudgetPerRequest: compiledJob.policy.maxToolCalls,
      requestTimeoutMs: runtimeWindowMs,
      toolRouting: {
        advertisedToolNames: allowedRuntimeTools,
        routedToolNames: allowedRuntimeTools,
        expandedToolNames: allowedRuntimeTools,
        expandOnMiss: false,
        persistDiscovery: false,
      },
      requiredToolEvidence: {
        executionEnvelope,
      },
    },
  };
}

export function createCompiledJobPolicyEngine(
  enforcement: CompiledJobEnforcement,
  logger: Logger = silentLogger,
): PolicyEngine {
  return new PolicyEngine({
    logger,
    policy: enforcement.runtimePolicy,
  });
}

function buildRuntimePolicy(params: {
  readonly compiledJob: CompiledJob;
  readonly allowedRuntimeTools: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly runtimeWindowMs: number;
  readonly allowWorkspaceWriteRoot?: string;
}): RuntimePolicyConfig {
  const { compiledJob } = params;
  const actionBudgets: NonNullable<RuntimePolicyConfig["actionBudgets"]> = {
    "tool_call:*": {
      limit: compiledJob.policy.maxToolCalls,
      windowMs: params.runtimeWindowMs,
    },
  };

  if (
    compiledJob.policy.networkPolicy === "allowlist_only" &&
    params.allowedRuntimeTools.includes("system.httpGet")
  ) {
    actionBudgets["tool_call:system.httpGet"] = {
      limit: compiledJob.policy.maxFetches,
      windowMs: params.runtimeWindowMs,
    };
  }

  return {
    enabled: true,
    toolAllowList: [...params.allowedRuntimeTools],
    ...(params.allowedHosts.length > 0
      ? {
          networkAccess: {
            allowHosts: [...params.allowedHosts],
          },
        }
      : {}),
    ...(params.allowWorkspaceWriteRoot
      ? {
          writeScope: {
            allowRoots: [params.allowWorkspaceWriteRoot],
          },
        }
      : {}),
    actionBudgets,
    runtimeBudget: {
      maxElapsedMs: params.runtimeWindowMs,
    },
    policyClassRules: {
      credential_secret_access: { deny: true },
      irreversible_financial_action: { deny: true },
      ...(compiledJob.policy.writeScope === "none"
        ? {
            destructive_side_effect: { deny: true },
          }
        : {}),
    },
  };
}

function resolveRuntimeToolNames(compiledJob: CompiledJob): readonly string[] {
  const toolNames = new Set<string>();
  for (const tool of compiledJob.policy.allowedTools) {
    for (const runtimeTool of mapRuntimeTools(compiledJob, tool)) {
      toolNames.add(runtimeTool);
    }
  }

  if (compiledJob.policy.writeScope === "workspace_only") {
    for (const runtimeTool of WORKSPACE_WRITE_RUNTIME_TOOLS) {
      toolNames.add(runtimeTool);
    }
  }

  if (compiledJob.policy.networkPolicy !== "allowlist_only") {
    for (const runtimeTool of NETWORK_RUNTIME_TOOLS) {
      toolNames.delete(runtimeTool);
    }
  }

  return [...toolNames];
}

function resolveAllowedMutatingRuntimeTools(
  compiledJob: CompiledJob,
): readonly string[] {
  const toolNames = new Set<string>();

  if (compiledJob.policy.writeScope === "workspace_only") {
    for (const runtimeTool of WORKSPACE_WRITE_RUNTIME_TOOLS) {
      toolNames.add(runtimeTool);
    }
  }

  if (compiledJob.policy.allowedTools.includes("run_approved_checks")) {
    for (const runtimeTool of APPROVED_CHECK_RUNTIME_TOOLS) {
      toolNames.add(runtimeTool);
    }
  }

  return [...toolNames];
}

function mapRuntimeTools(
  compiledJob: CompiledJob,
  tool: CompiledJobAllowedTool,
): readonly string[] {
  switch (tool) {
    case "fetch_url":
      return NETWORK_RUNTIME_TOOLS;
    case "extract_text":
      return [...NETWORK_RUNTIME_TOOLS, ...LOCAL_EXTRACT_RUNTIME_TOOLS];
    case "classify_rows":
      return compiledJob.jobType === "spreadsheet_cleanup_classification"
        ? WORKSPACE_READ_RUNTIME_TOOLS
        : [];
    case "normalize_table":
      return compiledJob.jobType === "spreadsheet_cleanup_classification"
        ? WORKSPACE_READ_RUNTIME_TOOLS
        : [];
    case "parse_transcript":
      return compiledJob.jobType === "transcript_to_deliverables"
        ? WORKSPACE_READ_RUNTIME_TOOLS
        : [];
    case "collect_rows":
    case "dedupe_rows":
      return [];
    case "read_workspace":
      return WORKSPACE_READ_RUNTIME_TOOLS;
    case "run_approved_checks":
      return [
        ...WORKSPACE_READ_RUNTIME_TOOLS,
        ...APPROVED_CHECK_RUNTIME_TOOLS,
      ];
    default:
      return [];
  }
}

function requiresWorkspaceRead(
  compiledJob: CompiledJob,
  tool: CompiledJobAllowedTool,
): boolean {
  switch (tool) {
    case "classify_rows":
      return compiledJob.jobType === "spreadsheet_cleanup_classification";
    case "normalize_table":
      return compiledJob.jobType === "spreadsheet_cleanup_classification";
    case "parse_transcript":
      return compiledJob.jobType === "transcript_to_deliverables";
    case "read_workspace":
    case "run_approved_checks":
      return true;
    default:
      return false;
  }
}

function resolveAllowedHosts(
  allowedDomains: readonly string[],
): readonly string[] {
  const hosts = new Set<string>();
  for (const domain of allowedDomains) {
    const normalized = normalizeAllowedHost(domain);
    if (normalized) {
      hosts.add(normalized);
    }
  }
  return [...hosts];
}

function normalizeAllowedHost(input: string): string | null {
  const candidate = input.trim();
  if (candidate.length === 0) {
    return null;
  }
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    const withoutScheme = candidate.replace(/^[a-z]+:\/\//i, "");
    const host = withoutScheme.split("/")[0]?.trim().toLowerCase();
    return host && host.length > 0 ? host : null;
  }
}
