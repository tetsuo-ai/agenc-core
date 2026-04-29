/**
 * Delegation runtime dependencies shared across gateway/tool-handler wiring.
 *
 * Provides policy checks, verifier toggles, and lifecycle event emission for
 * sub-agent orchestration.
 *
 * @module
 */

import {
  SUB_AGENT_SESSION_PREFIX,
  type SubAgentManager,
} from "./sub-agent.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import type { SubAgentProgressTracker } from "./sub-agent-progress.js";
import type { GatewaySubagentFallbackBehavior } from "./types.js";
import type { DelegationContractSpec } from "../utils/delegation-validation.js";
import {
  createVerifierRequirement,
  type VerifierRequirement,
  type ProjectVerifierBootstrap,
} from "./verifier-probes.js";

interface DelegationPolicyRuntimeConfig {
  readonly enabled: boolean;
  readonly spawnDecisionThreshold: number;
  readonly allowedParentTools?: readonly string[];
  readonly forbiddenParentTools?: readonly string[];
  readonly fallbackBehavior: GatewaySubagentFallbackBehavior;
  readonly unsafeBenchmarkMode?: boolean;
}

interface DelegationPolicyInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly isSubAgentSession: boolean;
}

interface DelegationPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly matchedRule?:
    | "not_delegation_tool"
    | "delegation_disabled"
    | "subagent_delegation_blocked"
    | "forbidden_tool"
    | "tool_not_allowlisted"
    | "unsafe_benchmark_bypass"
    | "allowed";
  readonly threshold: number;
}

export function isSubAgentSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SUB_AGENT_SESSION_PREFIX);
}

function isDelegationToolName(toolName: string): boolean {
  return (
    toolName === "execute_with_agent" ||
    toolName === "coordinator_mode" ||
    toolName.startsWith("subagent.") ||
    toolName.startsWith("agenc.subagent.")
  );
}

export class DelegationPolicyEngine {
  private config: DelegationPolicyRuntimeConfig;

  constructor(config: DelegationPolicyRuntimeConfig) {
    this.config = {
      ...config,
      allowedParentTools: config.allowedParentTools
        ? [...config.allowedParentTools]
        : undefined,
      forbiddenParentTools: config.forbiddenParentTools
        ? [...config.forbiddenParentTools]
        : undefined,
    };
  }

  updateConfig(config: DelegationPolicyRuntimeConfig): void {
    this.config = {
      ...config,
      allowedParentTools: config.allowedParentTools
        ? [...config.allowedParentTools]
        : undefined,
      forbiddenParentTools: config.forbiddenParentTools
        ? [...config.forbiddenParentTools]
        : undefined,
    };
  }

  snapshot(): DelegationPolicyRuntimeConfig {
    return {
      ...this.config,
      allowedParentTools: this.config.allowedParentTools
        ? [...this.config.allowedParentTools]
        : undefined,
      forbiddenParentTools: this.config.forbiddenParentTools
        ? [...this.config.forbiddenParentTools]
        : undefined,
      unsafeBenchmarkMode: this.config.unsafeBenchmarkMode === true,
    };
  }

  isDelegationTool(toolName: string): boolean {
    return isDelegationToolName(toolName);
  }

  evaluate(input: DelegationPolicyInput): DelegationPolicyDecision {
    if (!isDelegationToolName(input.toolName)) {
      return {
        allowed: true,
        matchedRule: "not_delegation_tool",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    if (!this.config.enabled) {
      return {
        allowed: false,
        reason:
          this.config.fallbackBehavior === "fail_request"
            ? "Delegation is disabled by configuration"
            : "Delegation disabled; continue without delegation",
        matchedRule: "delegation_disabled",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    if (this.config.unsafeBenchmarkMode === true) {
      return {
        allowed: true,
        matchedRule: "unsafe_benchmark_bypass",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    // Parent sessions may be constrained by explicit allow/deny lists.
    const forbidden = new Set(this.config.forbiddenParentTools ?? []);
    if (forbidden.has(input.toolName)) {
      return {
        allowed: false,
        reason: `Delegation blocked by forbiddenParentTools for "${input.toolName}"`,
        matchedRule: "forbidden_tool",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    const allowlist = this.config.allowedParentTools;
    if (allowlist && allowlist.length > 0 && !allowlist.includes(input.toolName)) {
      return {
        allowed: false,
        reason: `Delegation tool "${input.toolName}" is not allowlisted`,
        matchedRule: "tool_not_allowlisted",
        threshold: this.config.spawnDecisionThreshold,
      };
    }

    return {
      allowed: true,
      matchedRule: "allowed",
      threshold: this.config.spawnDecisionThreshold,
    };
  }
}

interface DelegationVerifierRuntimeConfig {
  readonly enabled: boolean;
  readonly forceVerifier: boolean;
}

export class DelegationVerifierService {
  private config: DelegationVerifierRuntimeConfig;
  private bootstrapCache = new Map<string, ProjectVerifierBootstrap>();

  constructor(config: DelegationVerifierRuntimeConfig) {
    this.config = { ...config };
  }

  updateConfig(config: DelegationVerifierRuntimeConfig): void {
    this.config = { ...config };
  }

  snapshot(): DelegationVerifierRuntimeConfig {
    return { ...this.config };
  }

  resolveVerifierRequirement(params?: {
    readonly requested?: boolean;
    readonly runtimeRequired?: boolean;
    readonly projectBootstrap?: boolean;
    readonly workspaceRoot?: string;
  }): VerifierRequirement {
    return createVerifierRequirement({
      enabled: this.config.enabled,
      requested:
        params?.requested === true || this.config.forceVerifier === true,
      runtimeRequired: params?.runtimeRequired,
      projectBootstrap: params?.projectBootstrap,
      workspaceRoot: params?.workspaceRoot,
      bootstrapCache: this.bootstrapCache,
    });
  }

  shouldVerifySubAgentResult(
    requested = false,
  ): boolean {
    return this.resolveVerifierRequirement({ requested }).required;
  }
}

type SubAgentLifecycleEventType =
  | "subagents.planned"
  | "subagents.policy_bypassed"
  | "subagents.spawned"
  | "subagents.started"
  | "subagents.progress"
  | "subagents.tool.executing"
  | "subagents.tool.result"
  | "subagents.acceptance_probe.started"
  | "subagents.acceptance_probe.completed"
  | "subagents.acceptance_probe.failed"
  | "subagents.completed"
  | "subagents.failed"
  | "subagents.cancelled"
  | "subagents.synthesized";

export interface SubAgentLifecycleEvent {
  readonly type: SubAgentLifecycleEventType;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly toolName?: string;
  readonly payload?: Record<string, unknown>;
}

type SubAgentLifecycleListener = (event: SubAgentLifecycleEvent) => void;

export class SubAgentLifecycleEmitter {
  private readonly listeners = new Set<SubAgentLifecycleListener>();

  on(listener: SubAgentLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SubAgentLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let listener exceptions break the caller.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface DelegationToolCompositionContext {
  readonly subAgentManager: SubAgentManager | null;
  readonly workerManager?: PersistentWorkerManager | null;
  readonly policyEngine: DelegationPolicyEngine | null;
  readonly verifier: DelegationVerifierService | null;
  readonly lifecycleEmitter: SubAgentLifecycleEmitter | null;
  /**
   * Per-sub-agent progress aggregator. When present, tool-handler emit
   * sites call `onToolExecuting` / `onToolResult` and then emit an
   * enriched `subagents.progress` event carrying
   * `payload.progress = SubAgentAgentProgress` so UIs can render
   * live tool counts, tokens, and last-tool name under the spawning
   * `execute_with_agent` card.
   */
  readonly progressTracker?: SubAgentProgressTracker | null;
  readonly launchShellAgentTask?: (params: {
    readonly parentSessionId: string;
    readonly roleId: string;
    readonly objective: string;
    readonly prompt?: string;
    readonly shellProfile?: string;
    readonly tools?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly workspaceRoot?: string;
    readonly workingDirectory?: string;
    readonly continuationSessionId?: string;
    readonly requireToolCall?: boolean;
    readonly delegationSpec?: DelegationContractSpec;
    readonly worktree?: "auto" | string;
    readonly wait?: boolean;
    readonly timeoutMs?: number;
    readonly name?: string;
    readonly createTaskIfMissing?: boolean;
    readonly unsafeBenchmarkMode?: boolean;
  }) => Promise<{
    readonly sessionId: string;
    readonly taskId?: string;
    readonly output: string;
    readonly success: boolean;
    readonly status: string;
    readonly waited: boolean;
    readonly outputPath?: string;
    readonly name?: string;
  }>;
  readonly unsafeBenchmarkMode?: boolean;
}

export type DelegationToolCompositionResolver =
  () => DelegationToolCompositionContext | undefined;
