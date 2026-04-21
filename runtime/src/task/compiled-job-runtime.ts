import type { ChatExecuteParams } from "../llm/chat-executor-types.js";
import type { LLMTool, ToolHandler } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import {
  createCompiledJobPolicyEngine,
  type CompiledJobEnforcement,
  type CompiledJobSideEffectPolicy,
} from "./compiled-job-enforcement.js";

export interface CompiledJobScopedTooling {
  readonly allowedToolNames: readonly string[];
  readonly missingToolNames: readonly string[];
  readonly blockedToolNames: readonly string[];
  readonly llmTools: readonly LLMTool[];
  readonly toolHandler: ToolHandler;
}

export interface CompiledJobExecutionRuntime {
  readonly enforcement: CompiledJobEnforcement;
  buildScopedTooling(
    registry: ToolRegistry,
    logger?: Logger,
  ): CompiledJobScopedTooling;
  applyChatExecuteParams(params: ChatExecuteParams): ChatExecuteParams;
}

const L0_BLOCKED_TOOL_PREFIXES = [
  "agenc.",
  "desktop.",
  "social.",
  "verification.",
  "wallet.",
  "x.",
] as const;

const L0_BLOCKED_SYSTEM_TOOLS = new Set([
  "system.appendFile",
  "system.browserSessionResume",
  "system.bash",
  "system.delete",
  "system.editFile",
  "system.evaluateJs",
  "system.mkdir",
  "system.move",
  "system.processStart",
  "system.processStop",
  "system.remoteJobCancel",
  "system.remoteJobResume",
  "system.remoteJobStart",
  "system.sandboxExec",
  "system.sandboxStart",
  "system.sandboxStop",
  "system.serverStart",
  "system.serverStop",
  "system.writeFile",
]);

export function createCompiledJobExecutionRuntime(
  enforcement: CompiledJobEnforcement,
): CompiledJobExecutionRuntime {
  return {
    enforcement,
    buildScopedTooling(
      registry: ToolRegistry,
      logger: Logger = silentLogger,
    ): CompiledJobScopedTooling {
      const scopedRegistry = new ToolRegistry({
        logger,
        policyEngine: createCompiledJobPolicyEngine(enforcement, logger),
      });
      const missingToolNames: string[] = [];
      const blockedToolNames: string[] = [];
      const baseToolNames = resolveAdvertisedRuntimeToolNames(enforcement);

      for (const toolName of baseToolNames.allowedToolNames) {
        const tool = registry.get(toolName);
        if (!tool) {
          missingToolNames.push(toolName);
          continue;
        }
        if (shouldBlockRegisteredTool(tool, enforcement.sideEffectPolicy)) {
          blockedToolNames.push(tool.name);
          continue;
        }
        scopedRegistry.register(tool);
      }

      const allowedToolNames = scopedRegistry.listNames();
      return {
        allowedToolNames,
        missingToolNames,
        blockedToolNames: uniqueToolNames([
          ...baseToolNames.blockedToolNames,
          ...blockedToolNames,
        ]),
        llmTools: scopedRegistry.toLLMTools(),
        toolHandler: scopedRegistry.createToolHandler(),
      };
    },
    applyChatExecuteParams(params: ChatExecuteParams): ChatExecuteParams {
      return {
        ...params,
        maxToolRounds: capRuntimeLimit(
          params.maxToolRounds,
          enforcement.chat.maxToolRounds,
        ),
        toolBudgetPerRequest: capRuntimeLimit(
          params.toolBudgetPerRequest,
          enforcement.chat.toolBudgetPerRequest,
        ),
        requestTimeoutMs: capRuntimeLimit(
          params.requestTimeoutMs,
          enforcement.chat.requestTimeoutMs,
        ),
        contextInjection: {
          skills: mergeBooleanGate(
            params.contextInjection?.skills,
            enforcement.chat.contextInjection?.skills,
          ),
          memory: mergeBooleanGate(
            params.contextInjection?.memory,
            enforcement.chat.contextInjection?.memory,
          ),
        },
        toolRouting: mergeToolRouting(params.toolRouting, enforcement),
        requiredToolEvidence: mergeRequiredToolEvidence(
          params.requiredToolEvidence,
          enforcement.chat.requiredToolEvidence,
        ),
      };
    },
  };
}

function mergeRequiredToolEvidence(
  base: ChatExecuteParams["requiredToolEvidence"],
  enforced: ChatExecuteParams["requiredToolEvidence"],
): ChatExecuteParams["requiredToolEvidence"] {
  if (!base && !enforced) return undefined;

  return {
    ...(base?.maxCorrectionAttempts !== undefined
      ? { maxCorrectionAttempts: base.maxCorrectionAttempts }
      : {}),
    ...(base?.delegationSpec ? { delegationSpec: base.delegationSpec } : {}),
    ...(base?.unsafeBenchmarkMode !== undefined
      ? { unsafeBenchmarkMode: base.unsafeBenchmarkMode }
      : {}),
    ...(base?.verificationContract
      ? { verificationContract: base.verificationContract }
      : {}),
    ...(base?.completionContract
      ? { completionContract: base.completionContract }
      : {}),
    ...(base?.executionEnvelope ?? enforced?.executionEnvelope
      ? {
          executionEnvelope:
            base?.executionEnvelope ?? enforced?.executionEnvelope,
        }
      : {}),
  };
}

function mergeToolRouting(
  base: ChatExecuteParams["toolRouting"],
  enforcement: CompiledJobEnforcement,
): ChatExecuteParams["toolRouting"] {
  const safeToolNames = resolveAdvertisedRuntimeToolNames(enforcement)
    .allowedToolNames;
  const allowed =
    enforcement.chat.toolRouting?.advertisedToolNames?.length &&
    enforcement.chat.toolRouting.advertisedToolNames.length > 0
      ? uniqueToolNames(
          enforcement.chat.toolRouting.advertisedToolNames.filter((toolName) =>
            safeToolNames.includes(toolName),
          ),
        )
      : [...safeToolNames];
  const allowedSet = new Set(allowed);
  const filterAllowed = (names: readonly string[] | undefined): string[] =>
    uniqueToolNames(
      (names ?? []).filter((toolName) => allowedSet.has(toolName)),
    );

  const advertisedToolNames = (() => {
    const filteredBase = filterAllowed(base?.advertisedToolNames);
    return filteredBase.length > 0 ? filteredBase : allowed;
  })();
  const advertisedSet = new Set(advertisedToolNames);
  const filterAdvertised = (names: readonly string[] | undefined): string[] =>
    uniqueToolNames(
      (names ?? []).filter((toolName) => advertisedSet.has(toolName)),
    );
  const routedToolNames = (() => {
    const filteredBase = filterAdvertised(base?.routedToolNames);
    if (filteredBase.length > 0) return filteredBase;
    const enforcedRouted = filterAdvertised(
      enforcement.chat.toolRouting?.routedToolNames,
    );
    return enforcedRouted.length > 0 ? enforcedRouted : advertisedToolNames;
  })();
  const expandedToolNames = (() => {
    const filteredBase = filterAdvertised(base?.expandedToolNames);
    if (filteredBase.length > 0) return filteredBase;
    const enforcedExpanded = filterAdvertised(
      enforcement.chat.toolRouting?.expandedToolNames,
    );
    return enforcedExpanded.length > 0 ? enforcedExpanded : routedToolNames;
  })();

  return {
    advertisedToolNames,
    routedToolNames,
    expandedToolNames,
    expandOnMiss:
      base?.expandOnMiss === true &&
      enforcement.chat.toolRouting?.expandOnMiss === true,
    persistDiscovery:
      base?.persistDiscovery === true &&
      enforcement.chat.toolRouting?.persistDiscovery === true,
  };
}

function capRuntimeLimit(
  requested: number | undefined,
  enforced: number | undefined,
): number | undefined {
  if (enforced === undefined) return requested;
  if (requested === undefined || requested <= 0) return enforced;
  return Math.min(requested, enforced);
}

function mergeBooleanGate(
  requested: boolean | undefined,
  enforced: boolean | undefined,
): boolean | undefined {
  if (requested === false || enforced === false) return false;
  if (requested === true || enforced === true) return true;
  return undefined;
}

function uniqueToolNames(input: readonly string[]): string[] {
  return [...new Set(input)];
}

function resolveAdvertisedRuntimeToolNames(
  enforcement: CompiledJobEnforcement,
): {
  readonly allowedToolNames: readonly string[];
  readonly blockedToolNames: readonly string[];
} {
  const allowedToolNames: string[] = [];
  const blockedToolNames: string[] = [];

  for (const toolName of enforcement.allowedRuntimeTools) {
    if (shouldBlockToolName(toolName, enforcement.sideEffectPolicy)) {
      blockedToolNames.push(toolName);
      continue;
    }
    allowedToolNames.push(toolName);
  }

  return {
    allowedToolNames: uniqueToolNames(allowedToolNames),
    blockedToolNames: uniqueToolNames(blockedToolNames),
  };
}

function shouldBlockRegisteredTool(
  tool: Tool,
  sideEffectPolicy: CompiledJobSideEffectPolicy,
): boolean {
  if (!isStrictL0SideEffectPolicy(sideEffectPolicy)) {
    return false;
  }
  if (sideEffectPolicy.allowedMutatingRuntimeTools.includes(tool.name)) {
    return false;
  }
  return tool.metadata?.mutating === true;
}

function shouldBlockToolName(
  toolName: string,
  sideEffectPolicy: CompiledJobSideEffectPolicy,
): boolean {
  if (!isStrictL0SideEffectPolicy(sideEffectPolicy)) {
    return false;
  }
  if (sideEffectPolicy.allowedMutatingRuntimeTools.includes(toolName)) {
    return false;
  }
  if (L0_BLOCKED_SYSTEM_TOOLS.has(toolName)) {
    return true;
  }
  return L0_BLOCKED_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isStrictL0SideEffectPolicy(
  sideEffectPolicy: CompiledJobSideEffectPolicy,
): boolean {
  return (
    sideEffectPolicy.riskTier === "L0" &&
    sideEffectPolicy.approvalRequired !== true &&
    sideEffectPolicy.humanReviewGate === "none"
  );
}
