/**
 * Sub-agent spawning — parallel isolated task execution within a session.
 *
 * Sub-agents are independently scoped ChatExecutor instances that execute a
 * task description with configurable tool access, workspace isolation, and
 * timeout enforcement.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type {
  IsolatedSessionContext,
  SubAgentSessionIdentity,
} from "./session-isolation.js";
import type { MemoryBackend } from "../memory/types.js";
import { createGatewayMessage } from "./message.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { runSubagentToLegacyResult } from "./subagent-query.js";
import { buildModelRoutingPolicy } from "../llm/model-routing-policy.js";
import {
  createPromptEnvelope,
  normalizePromptEnvelope,
  type PromptEnvelopeV1,
} from "../llm/prompt-envelope.js";
import type { GatewayLLMConfig } from "./types.js";
import type { PromptBudgetConfig } from "../llm/prompt-budget.js";
import {
  buildRuntimeEconomicsPolicy,
  type RuntimeBudgetMode,
} from "../llm/run-budget.js";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
  ToolCallRecord,
} from "../llm/chat-executor-types.js";
import type {
  LLMProvider,
  LLMProviderExecutionProfile,
  LLMMessage,
  LLMProviderEvidence,
  LLMStructuredOutputResult,
  LLMUsage,
  ToolHandler,
} from "../llm/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
  logStructuredTraceEvent,
} from "../llm/provider-trace-logger.js";
import { resolveMaxToolRoundsForToolNames } from "./tool-round-budget.js";
import {
  hasRuntimeLimit,
  isRuntimeLimitExceeded,
  isRuntimeLimitReached,
  normalizeRuntimeLimit,
} from "../llm/runtime-limit-policy.js";
import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import type { VerifierRequirement } from "./verifier-probes.js";
import { SubAgentSpawnError } from "./errors.js";
import {
  appendShellProfilePromptSection,
  type SessionShellProfile,
} from "./shell-profile.js";
import type { RuntimeExecutionLocation } from "../runtime-contract/types.js";
import type { CanUseToolFn } from "../llm/can-use-tool.js";
import {
  appendTranscriptBatch,
  createTranscriptMessageEvent,
  loadTranscript,
  recoverTranscriptHistory,
  subAgentTranscriptStreamId,
} from "./session-transcript.js";

// ============================================================================
// Constants
// ============================================================================

// 0 = unlimited execution deadline. Sub-agents inherit any explicit timeout
// from their config or parent envelope; the default is "no deadline" because
// long-running implementation phases routinely exceed any fixed budget.
// Reverted from a 5-minute cap added by PR #174 because the cap silently
// killed legitimate long-horizon child phases.
export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 0;
const DEFAULT_SUB_AGENT_CONTEXT_STARTUP_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_SUB_AGENTS = 16;
const DEFAULT_MAX_SUB_AGENT_DEPTH = 4;
export const DEFAULT_MAX_RETAINED_TERMINAL_SUB_AGENTS = 256;
export const DEFAULT_TERMINAL_SUB_AGENT_RETENTION_MS = 6 * 60 * 60 * 1000; // 6h
export const SUB_AGENT_SESSION_PREFIX = "subagent:";
const SUB_AGENT_STATE_KEY_PREFIX = "sub-agent:state:";

const DEFAULT_SUB_AGENT_SYSTEM_PROMPT =
  "You are a sub-agent. Execute only the assigned delegated contract, stay within the provided scope, " +
  "and report the result concisely. Do not widen a bounded phase into a new broader parent plan, and do not delegate unless the " +
  "task explicitly grants that authority. If the delegated contract owns the remaining request end to end, keep working until it is complete or concretely blocked. " +
  "Honor the declared isolation reason, owned artifacts, and verifier obligations for the delegated contract.";

const ABORT_SENTINEL = Symbol("abort");
const TIMEOUT_SENTINEL = Symbol("timeout");

/**
 * Race a promise against an AbortSignal.
 * Resolves/rejects normally if the promise settles first,
 * or returns `ABORT_SENTINEL` if the signal fires first.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORT_SENTINEL> {
  if (signal.aborted) return Promise.resolve(ABORT_SENTINEL);
  return Promise.race([
    promise,
    new Promise<typeof ABORT_SENTINEL>((resolve) => {
      signal.addEventListener("abort", () => resolve(ABORT_SENTINEL), {
        once: true,
      });
    }),
  ]);
}

function raceAbortOrTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T | typeof ABORT_SENTINEL | typeof TIMEOUT_SENTINEL> {
  if (signal.aborted) return Promise.resolve(ABORT_SENTINEL);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve(ABORT_SENTINEL);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ============================================================================
// Types
// ============================================================================

export type SubAgentStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "timed_out"
  | "failed";

export interface SubAgentConfig {
  readonly parentSessionId: string;
  readonly shellProfile?: SessionShellProfile;
  readonly task: string;
  readonly role?: string;
  readonly roleSource?: string;
  readonly toolBundle?: string;
  readonly taskId?: string;
  readonly prompt?: string;
  readonly promptEnvelope?: PromptEnvelopeV1;
  readonly forkContext?: {
    readonly enabled: true;
    readonly sourceSessionId: string;
    readonly preserveParentTools?: boolean;
  };
  readonly continuationSessionId?: string;
  readonly timeoutMs?: number;
  readonly maxToolRounds?: number;
  readonly toolBudgetPerRequest?: number;
  readonly workingDirectory?: string;
  readonly workingDirectorySource?: "execution_envelope";
  readonly workspace?: string;
  readonly workspaceRoot?: string;
  readonly tools?: readonly string[];
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly requiredCapabilities?: readonly string[];
  readonly requireToolCall?: boolean;
  readonly structuredOutput?: ChatExecuteParams["structuredOutput"];
  readonly delegationSpec?: DelegationContractSpec;
  readonly verifierRequirement?: VerifierRequirement;
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly unsafeBenchmarkMode?: boolean;
  /**
   * Phase 2.8: Memory inheritance policy for sub-agents.
   * - "none": fully isolated (default — sub-agent gets empty memory)
   * - "read_snapshot": copy parent's recent N semantic entries as read-only context
   * - "shared_workspace": same workspace scope, different agentId
   */
  readonly memoryInheritance?: "none" | "read_snapshot" | "shared_workspace";
}

export interface SubAgentResult {
  readonly sessionId: string;
  readonly output: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly providerEvidence?: LLMProviderEvidence;
  readonly structuredOutput?: LLMStructuredOutputResult;
  readonly tokenUsage?: LLMUsage;
  readonly providerName?: string;
  readonly completionState?: ChatExecutorResult["completionState"];
  readonly completionProgress?: ChatExecutorResult["completionProgress"];
  readonly verifierSnapshot?: ChatExecutorResult["verifierSnapshot"];
  readonly contractFingerprint?: string;
  readonly stopReason?: ChatExecutorResult["stopReason"];
  readonly stopReasonDetail?: string;
  readonly validationCode?: DelegationOutputValidationCode;
}

export interface SubAgentManagerConfig {
  readonly createContext: (
    sessionIdentity: SubAgentSessionIdentity,
  ) => Promise<IsolatedSessionContext>;
  readonly destroyContext: (
    sessionIdentity: SubAgentSessionIdentity,
  ) => Promise<void>;
  readonly defaultWorkspaceId?: string;
  readonly contextStartupTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxDepth?: number;
  readonly maxRetainedTerminalHandles?: number;
  readonly terminalHandleRetentionMs?: number;
  readonly promptEnvelope?: PromptEnvelopeV1;
  readonly composeToolHandler?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    context: IsolatedSessionContext;
    baseToolHandler: ToolHandler;
    task: string;
    allowedToolNames?: readonly string[];
    workingDirectory?: string;
    executionContext?: DelegationContractSpec["executionContext"];
    desktopRoutingSessionId: string;
  }) => ToolHandler;
  readonly selectLLMProvider?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    contextProvider: LLMProvider;
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) => LLMProvider | undefined;
  readonly resolveExecutionBudget?: (params: {
    sessionIdentity: SubAgentSessionIdentity;
    contextProvider: LLMProvider;
    selectedProvider: LLMProvider;
    task: string;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
  }) =>
    | Promise<ResolvedSubAgentExecutionBudget | undefined>
    | ResolvedSubAgentExecutionBudget
    | undefined;
  readonly resolveDefaultMaxToolRounds?: () => number | undefined;
  readonly logger?: Logger;
  readonly traceExecution?: boolean;
  readonly traceProviderPayloads?: boolean;
  readonly promptBudget?: PromptBudgetConfig;
  readonly sessionTokenBudget?: number;
  readonly sessionCompactionThreshold?: number;
  readonly economicsMode?: RuntimeBudgetMode;
  readonly onCompaction?: (sessionId: string, summary: string) => void;
  readonly memoryBackend?: MemoryBackend;
  readonly canUseTool?: CanUseToolFn;
}

interface ResolvedSubAgentExecutionBudget {
  readonly promptBudget?: PromptBudgetConfig;
  readonly sessionTokenBudget?: number;
  readonly sessionCompactionThreshold?: number;
  readonly providerProfile?: LLMProviderExecutionProfile;
}

export interface SubAgentInfo {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly status: SubAgentStatus;
  readonly startedAt: number;
  readonly task: string;
  readonly role?: string;
  readonly roleSource?: string;
  readonly toolBundle?: string;
  readonly taskId?: string;
  readonly shellProfile?: SessionShellProfile;
  readonly workspaceRoot?: string;
  readonly workingDirectory?: string;
  readonly executionLocation?: RuntimeExecutionLocation["mode"];
  readonly worktreePath?: string;
}

// ============================================================================
// Internal handle (not exported)
// ============================================================================

interface SubAgentHandle {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly task: string;
  readonly config: SubAgentConfig;
  history: LLMMessage[];
  readonly startedAt: number;
  status: SubAgentStatus;
  result: SubAgentResult | null;
  readonly abortController: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  execution: Promise<void>;
  finishedAt: number | null;
}

interface PersistedSubAgentState {
  readonly version: 1;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly task: string;
  readonly config: SubAgentConfig;
  readonly status: SubAgentStatus;
  readonly result: SubAgentResult | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

interface LegacySubAgentConfigRecord extends Record<string, unknown> {
  readonly promptEnvelope?: PromptEnvelopeV1;
  readonly systemPrompt?: string;
}

function subAgentStateKey(sessionId: string): string {
  return `${SUB_AGENT_STATE_KEY_PREFIX}${sessionId}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSubAgentPromptEnvelope(
  envelope: PromptEnvelopeV1 | undefined,
  fallbackBaseSystemPrompt: string,
): PromptEnvelopeV1 {
  return normalizePromptEnvelope(
    envelope ?? createPromptEnvelope(fallbackBaseSystemPrompt),
  );
}

function normalizeSubAgentConfig(
  config: SubAgentConfig,
  managerPromptEnvelope?: PromptEnvelopeV1,
): SubAgentConfig {
  return {
    ...config,
    promptEnvelope: normalizeSubAgentPromptEnvelope(
      config.promptEnvelope,
      managerPromptEnvelope?.baseSystemPrompt ?? DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
    ),
  };
}

function normalizePersistedSubAgentConfig(
  value: unknown,
): SubAgentConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rawConfig = value as LegacySubAgentConfigRecord;
  const promptEnvelope = normalizeSubAgentPromptEnvelope(
    rawConfig.promptEnvelope,
    typeof rawConfig.systemPrompt === "string"
      ? rawConfig.systemPrompt
      : DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
  );
  const normalized = {
    ...(cloneJson(rawConfig) as Record<string, unknown>),
    promptEnvelope,
  };
  delete (normalized as Record<string, unknown>).systemPrompt;
  return normalized as SubAgentConfig;
}

function normalizePromptEnvelopeFingerprint(
  envelope: PromptEnvelopeV1 | undefined,
): string {
  return stableConfigFragment(normalizePromptEnvelope(envelope ?? createPromptEnvelope("")));
}

function coercePersistedSubAgentState(
  value: unknown,
): PersistedSubAgentState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.sessionId !== "string" ||
    typeof raw.parentSessionId !== "string" ||
    typeof raw.depth !== "number" ||
    typeof raw.task !== "string" ||
    !raw.config ||
    typeof raw.config !== "object" ||
    typeof raw.status !== "string" ||
    typeof raw.startedAt !== "number"
  ) {
    return undefined;
  }
  if (
    raw.status !== "running" &&
    raw.status !== "completed" &&
    raw.status !== "cancelled" &&
    raw.status !== "timed_out" &&
    raw.status !== "failed"
  ) {
    return undefined;
  }
  const normalizedConfig = normalizePersistedSubAgentConfig(raw.config);
  if (!normalizedConfig) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: raw.sessionId,
    parentSessionId: raw.parentSessionId,
    depth: raw.depth,
    task: raw.task,
    config: normalizedConfig,
    status: raw.status,
    result:
      raw.result && typeof raw.result === "object"
        ? cloneJson(raw.result as SubAgentResult)
        : null,
    startedAt: raw.startedAt,
    finishedAt:
      typeof raw.finishedAt === "number" && Number.isFinite(raw.finishedAt)
        ? raw.finishedAt
        : null,
  };
}

function mapChatCompletionToSubAgentStatus(input: {
  readonly completionState?: ChatExecutorResult["completionState"];
  readonly stopReason?: ChatExecutorResult["stopReason"];
}): Exclude<SubAgentStatus, "running"> {
  if (input.stopReason === "timeout") return "timed_out";
  if (input.stopReason === "cancelled") return "cancelled";
  if (input.completionState === "completed") return "completed";
  return "failed";
}

function normalizeStringList(values: readonly string[] | undefined): readonly string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function stableConfigFragment(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableConfigFragment(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableConfigFragment(entry)}`)
    .join(",")}}`;
}

function normalizeVerifierRequirement(
  requirement: VerifierRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  return stableConfigFragment({
    required: requirement.required,
    profiles: normalizeStringList(requirement.profiles),
    probeCategories: normalizeStringList(requirement.probeCategories),
    mutationPolicy: requirement.mutationPolicy,
    allowTempArtifacts: requirement.allowTempArtifacts,
    bootstrapSource: requirement.bootstrapSource,
  });
}

function normalizeExecutionContextFingerprint(
  executionContext: DelegationContractSpec["executionContext"] | undefined,
): string | undefined {
  if (!executionContext) return undefined;
  return stableConfigFragment({
    workspaceRoot: executionContext.workspaceRoot,
    allowedTools: normalizeStringList(executionContext.allowedTools),
    allowedReadRoots: normalizeStringList(executionContext.allowedReadRoots),
    allowedWriteRoots: normalizeStringList(executionContext.allowedWriteRoots),
    inputArtifacts: normalizeStringList(executionContext.inputArtifacts),
    requiredSourceArtifacts: normalizeStringList(
      executionContext.requiredSourceArtifacts,
    ),
    targetArtifacts: normalizeStringList(executionContext.targetArtifacts),
    effectClass: executionContext.effectClass,
    verificationMode: executionContext.verificationMode,
    stepKind: executionContext.stepKind,
    fallbackPolicy: executionContext.fallbackPolicy,
    resumePolicy: executionContext.resumePolicy,
    approvalProfile: executionContext.approvalProfile,
  });
}

function normalizeForkContextFingerprint(
  forkContext: SubAgentConfig["forkContext"] | undefined,
): string | undefined {
  if (!forkContext) return undefined;
  return stableConfigFragment({
    enabled: forkContext.enabled === true,
    sourceSessionId: forkContext.sourceSessionId,
    preserveParentTools: forkContext.preserveParentTools === true,
  });
}

function trimConfigPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveSubAgentWorkspaceRoot(
  config: SubAgentConfig,
): string | undefined {
  return (
    trimConfigPath(config.workspaceRoot) ??
    trimConfigPath(config.executionLocation?.workspaceRoot) ??
    trimConfigPath(config.workingDirectory) ??
    trimConfigPath(config.executionLocation?.workingDirectory)
  );
}

function resolveSubAgentWorkingDirectory(
  config: SubAgentConfig,
): string | undefined {
  return (
    trimConfigPath(config.workingDirectory) ??
    trimConfigPath(config.executionLocation?.workingDirectory) ??
    resolveSubAgentWorkspaceRoot(config)
  );
}

function validateContinuationCompatibility(params: {
  readonly existing: SubAgentConfig;
  readonly next: SubAgentConfig;
}): string | undefined {
  const existingWorkingDirectory = resolveSubAgentWorkingDirectory(
    params.existing,
  );
  const nextWorkingDirectory = resolveSubAgentWorkingDirectory(params.next);
  if (existingWorkingDirectory !== nextWorkingDirectory) {
    return "continuationSessionId cannot change the delegated working directory";
  }

  const existingTools = normalizeStringList(params.existing.tools);
  const nextTools = normalizeStringList(params.next.tools);
  if (
    existingTools.length > 0 &&
    (nextTools.length === 0 ||
      nextTools.some((toolName) => !existingTools.includes(toolName)))
  ) {
    return "continuationSessionId cannot widen the delegated tool scope";
  }

  if (
    params.existing.requireToolCall === true &&
    params.next.requireToolCall !== true
  ) {
    return "continuationSessionId must preserve required child tool evidence";
  }

  const existingContext = normalizeExecutionContextFingerprint(
    params.existing.delegationSpec?.executionContext,
  );
  const nextContext = normalizeExecutionContextFingerprint(
    params.next.delegationSpec?.executionContext,
  );
  if (existingContext !== nextContext) {
    return "continuationSessionId cannot change the delegated execution envelope";
  }

  const existingVerifier = normalizeVerifierRequirement(
    params.existing.verifierRequirement,
  );
  const nextVerifier = normalizeVerifierRequirement(
    params.next.verifierRequirement,
  );
  if (existingVerifier !== nextVerifier) {
    return "continuationSessionId must preserve verifier obligations";
  }

  const existingPromptEnvelope = normalizePromptEnvelopeFingerprint(
    params.existing.promptEnvelope,
  );
  const nextPromptEnvelope = normalizePromptEnvelopeFingerprint(
    params.next.promptEnvelope,
  );
  if (existingPromptEnvelope !== nextPromptEnvelope) {
    return "continuationSessionId must preserve delegated prompt state";
  }

  const existingForkContext = normalizeForkContextFingerprint(
    params.existing.forkContext,
  );
  const nextForkContext = normalizeForkContextFingerprint(
    params.next.forkContext,
  );
  if (existingForkContext !== nextForkContext) {
    return "continuationSessionId must preserve forked child context";
  }

  return undefined;
}

// ============================================================================
// SubAgentManager
// ============================================================================

export class SubAgentManager {
  private readonly handles = new Map<string, SubAgentHandle>();
  private readonly config: SubAgentManagerConfig;
  private readonly maxConcurrent: number;
  private readonly maxDepth: number;
  private readonly maxRetainedTerminalHandles: number;
  private readonly terminalHandleRetentionMs: number;
  private readonly logger: Logger;

  constructor(config: SubAgentManagerConfig) {
    this.config = config;
    this.maxConcurrent = normalizeRuntimeLimit(
      config.maxConcurrent,
      MAX_CONCURRENT_SUB_AGENTS,
    );
    this.maxDepth = normalizeRuntimeLimit(
      config.maxDepth,
      DEFAULT_MAX_SUB_AGENT_DEPTH,
    );
    this.maxRetainedTerminalHandles = Math.max(
      1,
      Math.floor(
        config.maxRetainedTerminalHandles ??
          DEFAULT_MAX_RETAINED_TERMINAL_SUB_AGENTS,
      ),
    );
    this.terminalHandleRetentionMs = Math.max(
      0,
      Math.floor(
        config.terminalHandleRetentionMs ??
          DEFAULT_TERMINAL_SUB_AGENT_RETENTION_MS,
      ),
    );
    this.logger = config.logger ?? silentLogger;
  }

  get activeCount(): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      if (handle.status === "running") count++;
    }
    return count;
  }

  async spawn(config: SubAgentConfig): Promise<string> {
    this.pruneTerminalHandles();
    const normalizedConfig = normalizeSubAgentConfig(
      config,
      this.config.promptEnvelope,
    );

    // Validate inputs
    if (!normalizedConfig.parentSessionId) {
      throw new SubAgentSpawnError("", "parentSessionId must be non-empty");
    }
    if (!normalizedConfig.task) {
      throw new SubAgentSpawnError(
        normalizedConfig.parentSessionId,
        "task must be non-empty",
      );
    }
    if (isRuntimeLimitReached(this.activeCount, this.maxConcurrent)) {
      throw new SubAgentSpawnError(
        normalizedConfig.parentSessionId,
        `max concurrent sub-agents reached (${this.maxConcurrent})`,
      );
    }
    const continuationHandle = await this.resolveContinuationHandle(normalizedConfig);
    const parentDepth = this.resolveSessionDepth(normalizedConfig.parentSessionId);
    const depth = continuationHandle
      ? continuationHandle.depth
      : parentDepth + 1;
    if (!continuationHandle && isRuntimeLimitExceeded(depth, this.maxDepth)) {
      throw new SubAgentSpawnError(
        normalizedConfig.parentSessionId,
        `max sub-agent depth reached (${this.maxDepth})`,
      );
    }

    const sessionId = continuationHandle?.sessionId ??
      `${SUB_AGENT_SESSION_PREFIX}${randomUUID()}`;
    const abortController = new AbortController();

    const handle: SubAgentHandle = {
      sessionId,
      parentSessionId: normalizedConfig.parentSessionId,
      depth,
      task: normalizedConfig.task,
      config: normalizedConfig,
      // Phase 2.8: sub-agent memory inheritance
      // "none" = empty history (default, fully isolated)
      // "read_snapshot" handled by caller injecting parent context as system messages
      // "shared_workspace" handled by workspace-scoped retrieval (same workspaceId)
      history: continuationHandle ? [...continuationHandle.history] : [],
      startedAt: Date.now(),
      status: "running",
      result: null,
      abortController,
      timeoutTimer: null,
      execution: Promise.resolve(),
      finishedAt: null,
    };

    this.handles.set(sessionId, handle);
    await this.persistHandleState(handle);

    // Fire-and-forget execution
    handle.execution = this.executeSubAgent(handle).catch(() => {
      // Errors are captured in the handle, no unhandled rejection
    });

    this.logger.info(
      `Sub-agent ${sessionId} spawned for parent ${normalizedConfig.parentSessionId}`,
    );
    return sessionId;
  }

  getResult(sessionId: string): SubAgentResult | null {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    if (handle.status === "running") return null;
    return handle.result;
  }

  async waitForResult(sessionId: string): Promise<SubAgentResult | null> {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    await handle.execution;
    return handle.result;
  }

  getInfo(sessionId: string): SubAgentInfo | null {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return null;
    return {
      sessionId: handle.sessionId,
      parentSessionId: handle.parentSessionId,
      depth: handle.depth,
      status: handle.status,
      startedAt: handle.startedAt,
      task: handle.task,
      ...(handle.config.role ? { role: handle.config.role } : {}),
      ...(handle.config.roleSource ? { roleSource: handle.config.roleSource } : {}),
      ...(handle.config.toolBundle ? { toolBundle: handle.config.toolBundle } : {}),
      ...(handle.config.taskId ? { taskId: handle.config.taskId } : {}),
      ...(handle.config.shellProfile
        ? { shellProfile: handle.config.shellProfile }
        : {}),
      ...(resolveSubAgentWorkspaceRoot(handle.config)
        ? { workspaceRoot: resolveSubAgentWorkspaceRoot(handle.config) }
        : {}),
      ...(resolveSubAgentWorkingDirectory(handle.config)
        ? { workingDirectory: resolveSubAgentWorkingDirectory(handle.config) }
        : {}),
      ...(handle.config.executionLocation?.mode
        ? { executionLocation: handle.config.executionLocation.mode }
        : {}),
      ...(handle.config.executionLocation?.mode === "worktree" &&
        handle.config.executionLocation.worktreePath
        ? { worktreePath: handle.config.executionLocation.worktreePath }
        : {}),
    };
  }

  getExecutionContext(
    sessionId: string,
  ): DelegationContractSpec["executionContext"] | undefined {
    this.pruneTerminalHandles();
    return this.handles.get(sessionId)?.config.delegationSpec?.executionContext;
  }

  getVerifierRequirement(
    sessionId: string,
  ): VerifierRequirement | undefined {
    this.pruneTerminalHandles();
    return this.handles.get(sessionId)?.config.verifierRequirement;
  }

  cancel(sessionId: string): boolean {
    this.pruneTerminalHandles();
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    if (handle.status !== "running") return false;

    this.markTerminalState(handle, "cancelled", {
      sessionId,
      output: "Sub-agent was cancelled",
      success: false,
      completionState: "blocked",
      durationMs: Date.now() - handle.startedAt,
      toolCalls: [],
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
    handle.abortController.abort();
    if (handle.timeoutTimer !== null) {
      clearTimeout(handle.timeoutTimer);
      handle.timeoutTimer = null;
    }
    this.logger.info(`Sub-agent ${sessionId} cancelled`);
    return true;
  }

  listActive(): readonly string[] {
    this.pruneTerminalHandles();
    const active: string[] = [];
    for (const handle of this.handles.values()) {
      if (handle.status === "running") active.push(handle.sessionId);
    }
    return active;
  }

  listAll(): readonly SubAgentInfo[] {
    this.pruneTerminalHandles();
    const infos: SubAgentInfo[] = [];
    for (const handle of this.handles.values()) {
      infos.push({
        sessionId: handle.sessionId,
        parentSessionId: handle.parentSessionId,
        depth: handle.depth,
        status: handle.status,
        startedAt: handle.startedAt,
        task: handle.task,
        ...(handle.config.role ? { role: handle.config.role } : {}),
        ...(handle.config.roleSource ? { roleSource: handle.config.roleSource } : {}),
        ...(handle.config.toolBundle ? { toolBundle: handle.config.toolBundle } : {}),
        ...(handle.config.taskId ? { taskId: handle.config.taskId } : {}),
        ...(handle.config.shellProfile
          ? { shellProfile: handle.config.shellProfile }
          : {}),
        ...(resolveSubAgentWorkspaceRoot(handle.config)
          ? { workspaceRoot: resolveSubAgentWorkspaceRoot(handle.config) }
          : {}),
        ...(resolveSubAgentWorkingDirectory(handle.config)
          ? { workingDirectory: resolveSubAgentWorkingDirectory(handle.config) }
          : {}),
        ...(handle.config.executionLocation?.mode
          ? { executionLocation: handle.config.executionLocation.mode }
          : {}),
        ...(handle.config.executionLocation?.mode === "worktree" &&
          handle.config.executionLocation.worktreePath
          ? { worktreePath: handle.config.executionLocation.worktreePath }
          : {}),
      });
    }
    return infos;
  }

  findLatestSuccessfulSessionId(parentSessionId: string): string | undefined {
    this.pruneTerminalHandles();
    let latest:
      | {
        readonly sessionId: string;
        readonly finishedAt: number;
      }
      | undefined;

    for (const handle of this.handles.values()) {
      if (
        handle.parentSessionId !== parentSessionId ||
        handle.status !== "completed" ||
        handle.result?.completionState !== "completed"
      ) {
        continue;
      }
      const finishedAt = handle.finishedAt ?? handle.startedAt;
      if (!latest || finishedAt > latest.finishedAt) {
        latest = {
          sessionId: handle.sessionId,
          finishedAt,
        };
      }
    }

    return latest?.sessionId;
  }

  async destroyAll(): Promise<void> {
    const executions = Array.from(this.handles.values()).map((h) => h.execution);

    // Cancel all running sub-agents
    for (const handle of this.handles.values()) {
      if (handle.status === "running") {
        this.markTerminalState(handle, "cancelled", {
          sessionId: handle.sessionId,
          output: "Sub-agent was cancelled",
          success: false,
          completionState: "blocked",
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
        });
        handle.abortController.abort();
        if (handle.timeoutTimer !== null) {
          clearTimeout(handle.timeoutTimer);
          handle.timeoutTimer = null;
        }
      }
    }

    // Await all executions
    await Promise.allSettled(executions);

    this.handles.clear();
    this.logger.info("All sub-agents destroyed");
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private startExecutionTimeout(
    handle: SubAgentHandle,
    timeoutMs: number,
  ): void {
    if (handle.timeoutTimer !== null) {
      clearTimeout(handle.timeoutTimer);
    }
    if (!hasRuntimeLimit(timeoutMs)) {
      handle.timeoutTimer = null;
      return;
    }
    handle.timeoutTimer = setTimeout(() => {
      if (handle.status === "running") {
        this.markTerminalState(handle, "timed_out", {
          sessionId: handle.sessionId,
          output: `Sub-agent timed out after ${timeoutMs}ms`,
          success: false,
          completionState: "blocked",
          durationMs: Date.now() - handle.startedAt,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
        });
        handle.abortController.abort();
        this.logger.warn(
          `Sub-agent ${handle.sessionId} timed out after ${timeoutMs}ms`,
        );
      }
    }, timeoutMs);
  }

  private async persistHandleState(handle: SubAgentHandle): Promise<void> {
    const memoryBackend = this.config.memoryBackend;
    if (!memoryBackend) return;
    const persisted: PersistedSubAgentState = {
      version: 1,
      sessionId: handle.sessionId,
      parentSessionId: handle.parentSessionId,
      depth: handle.depth,
      task: handle.task,
      config: cloneJson(handle.config),
      status: handle.status,
      result: handle.result ? cloneJson(handle.result) : null,
      startedAt: handle.startedAt,
      finishedAt: handle.finishedAt,
    };
    await memoryBackend.set(subAgentStateKey(handle.sessionId), persisted);
  }

  private async appendConversationTurn(
    handle: SubAgentHandle,
    turn: {
      readonly user: LLMMessage;
      readonly assistant: LLMMessage;
    },
  ): Promise<void> {
    handle.history = [...handle.history, cloneJson(turn.user), cloneJson(turn.assistant)];
    const memoryBackend = this.config.memoryBackend;
    if (!memoryBackend) return;
    await appendTranscriptBatch(
      memoryBackend,
      subAgentTranscriptStreamId(handle.sessionId),
      [
        createTranscriptMessageEvent({
          surface: "subagent",
          message: turn.user,
          dedupeKey: `subagent:user:${handle.sessionId}:${handle.history.length - 1}`,
        }),
        createTranscriptMessageEvent({
          surface: "subagent",
          message: turn.assistant,
          dedupeKey: `subagent:assistant:${handle.sessionId}:${handle.history.length}`,
        }),
      ],
    );
  }

  private async loadPersistedContinuationHandle(
    continuationSessionId: string,
  ): Promise<SubAgentHandle | undefined> {
    const memoryBackend = this.config.memoryBackend;
    if (!memoryBackend) return undefined;
    const persisted = coercePersistedSubAgentState(
      await memoryBackend.get(subAgentStateKey(continuationSessionId)),
    );
    if (!persisted) return undefined;
    const transcript = await loadTranscript(
      memoryBackend,
      subAgentTranscriptStreamId(continuationSessionId),
    );
    return {
      sessionId: persisted.sessionId,
      parentSessionId: persisted.parentSessionId,
      depth: persisted.depth,
      task: persisted.task,
      config: normalizeSubAgentConfig(
        persisted.config,
        this.config.promptEnvelope,
      ),
      history: [...recoverTranscriptHistory(transcript, {
        injectContinuationPrompt: true,
      })],
      startedAt: persisted.startedAt,
      status: persisted.status,
      result: persisted.result ? cloneJson(persisted.result) : null,
      abortController: new AbortController(),
      timeoutTimer: null,
      execution: Promise.resolve(),
      finishedAt: persisted.finishedAt,
    };
  }

  private async executeSubAgent(handle: SubAgentHandle): Promise<void> {
    const workspaceId =
      handle.config.workspace ?? this.config.defaultWorkspaceId ?? "default";
    const sessionIdentity: SubAgentSessionIdentity = {
      workspaceId,
      parentSessionId: handle.parentSessionId,
      subagentSessionId: handle.sessionId,
    };

    let context: IsolatedSessionContext | undefined;
    try {
      // Check abort before context creation
      if (handle.abortController.signal.aborted) return;

      const startupTimeoutMs = Math.max(
        1_000,
        Math.floor(
          this.config.contextStartupTimeoutMs ??
            DEFAULT_SUB_AGENT_CONTEXT_STARTUP_TIMEOUT_MS,
        ),
      );
      const contextOrAbort = await raceAbortOrTimeout(
        this.config.createContext(sessionIdentity),
        handle.abortController.signal,
        startupTimeoutMs,
      );
      if (contextOrAbort === ABORT_SENTINEL) return;
      if (contextOrAbort === TIMEOUT_SENTINEL) {
        if (handle.status === "running") {
          this.markTerminalState(handle, "timed_out", {
            sessionId: handle.sessionId,
            output:
              `Sub-agent context startup timed out after ${startupTimeoutMs}ms`,
            success: false,
            completionState: "blocked",
            durationMs: Date.now() - handle.startedAt,
            toolCalls: [],
            tokenUsage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            },
          });
          handle.abortController.abort();
          this.logger.warn(
            `Sub-agent ${handle.sessionId} context startup timed out after ${startupTimeoutMs}ms`,
          );
        }
        return;
      }
      context = contextOrAbort;

      // Check abort after context creation
      if (handle.abortController.signal.aborted) return;
      this.startExecutionTimeout(
        handle,
        handle.config.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS,
      );

      if (
        handle.history.length === 0 &&
        handle.config.forkContext?.enabled === true &&
        this.config.memoryBackend
      ) {
        const forkTranscript = await loadTranscript(
          this.config.memoryBackend,
          handle.config.forkContext.sourceSessionId,
        );
        const inheritedHistory = recoverTranscriptHistory(forkTranscript, {
          injectContinuationPrompt: false,
        });
        if (inheritedHistory.length > 0) {
          handle.history = [...inheritedHistory];
        }
      }

      const toolHandler = this.composeToolHandler(sessionIdentity, context, handle);
      const selectedProvider =
        this.config.selectLLMProvider?.({
          sessionIdentity,
          contextProvider: context.llmProvider,
          task: handle.task,
          tools: handle.config.tools,
          requiredCapabilities: handle.config.requiredCapabilities,
        }) ?? context.llmProvider;
      let resolvedExecutionBudget: ResolvedSubAgentExecutionBudget | undefined;
      try {
        resolvedExecutionBudget =
          await this.config.resolveExecutionBudget?.({
            sessionIdentity,
            contextProvider: context.llmProvider,
            selectedProvider,
            task: handle.task,
            tools: handle.config.tools,
            requiredCapabilities: handle.config.requiredCapabilities,
          });
      } catch (error) {
        this.logger.warn(
          `Failed to resolve execution budget for sub-agent ${handle.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (handle.abortController.signal.aborted) return;

      const resolvedPromptBudget =
        resolvedExecutionBudget?.promptBudget ?? this.config.promptBudget;
      const resolvedSessionTokenBudget =
        resolvedExecutionBudget?.sessionTokenBudget ??
        this.config.sessionTokenBudget;
      const resolvedSessionCompactionThreshold =
        resolvedExecutionBudget?.sessionCompactionThreshold ??
        this.config.sessionCompactionThreshold;
      const resolvedProviderProfile =
        resolvedExecutionBudget?.providerProfile;
      const defaultMaxToolRounds = this.config.resolveDefaultMaxToolRounds?.();
      const effectiveMaxToolRounds =
        typeof handle.config.maxToolRounds === "number" &&
          Number.isFinite(handle.config.maxToolRounds)
          ? normalizeRuntimeLimit(handle.config.maxToolRounds, 0)
          : typeof defaultMaxToolRounds === "number" &&
              Number.isFinite(defaultMaxToolRounds)
          ? resolveMaxToolRoundsForToolNames(
              Math.max(1, Math.floor(defaultMaxToolRounds)),
              handle.config.tools,
            )
          : undefined;
      const effectiveToolBudgetPerRequest =
        typeof handle.config.toolBudgetPerRequest === "number" &&
          Number.isFinite(handle.config.toolBudgetPerRequest)
          ? normalizeRuntimeLimit(
              handle.config.toolBudgetPerRequest,
              0,
            )
          : undefined;
      const economicsPolicy = buildRuntimeEconomicsPolicy({
        sessionTokenBudget: resolvedSessionTokenBudget,
        requestTimeoutMs: handle.config.timeoutMs,
        childTimeoutMs: handle.config.timeoutMs,
        childTokenBudget: resolvedSessionTokenBudget,
        maxFanoutPerTurn: 1,
        mode: this.config.economicsMode ?? "enforce",
      });
      const selectedProviderRoutingConfig: GatewayLLMConfig | undefined =
        selectedProvider.name === "grok" || selectedProvider.name === "ollama"
          ? {
            provider: selectedProvider.name,
            ...(resolvedProviderProfile?.model
              ? { model: resolvedProviderProfile.model }
              : {}),
          }
          : undefined;
      const executor = new ChatExecutor({
        providers: [selectedProvider],
        toolHandler,
        allowedTools: handle.config.tools
          ? [...handle.config.tools]
          : undefined,
        promptBudget: resolvedPromptBudget,
        sessionTokenBudget: resolvedSessionTokenBudget,
        sessionCompactionThreshold: resolvedSessionCompactionThreshold,
        onCompaction: this.config.onCompaction,
        delegationNestingDepth: handle.depth,
        defaultRunClass: "child",
        economicsPolicy,
        modelRoutingPolicy: buildModelRoutingPolicy({
          providers: [selectedProvider],
          economicsPolicy,
          ...(selectedProviderRoutingConfig
            ? { providerConfigs: [selectedProviderRoutingConfig] }
            : {}),
        }),
        resolveHostWorkspaceRoot: () =>
          resolveSubAgentWorkspaceRoot(handle.config) ?? null,
        ...(this.config.canUseTool ? { canUseTool: this.config.canUseTool } : {}),
        ...(typeof effectiveMaxToolRounds === "number"
          ? { maxToolRounds: effectiveMaxToolRounds }
          : {}),
      });

      const message = createGatewayMessage({
        channel: "sub-agent",
        senderId: handle.parentSessionId,
        senderName: "sub-agent",
        sessionId: handle.sessionId,
        content: handle.config.prompt ?? handle.task,
        scope: "dm",
      });

      const promptEnvelope = normalizePromptEnvelope({
        ...(handle.config.promptEnvelope ??
          createPromptEnvelope(DEFAULT_SUB_AGENT_SYSTEM_PROMPT)),
        baseSystemPrompt: appendShellProfilePromptSection({
          systemPrompt:
            handle.config.promptEnvelope?.baseSystemPrompt ??
            DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
          profile: handle.config.shellProfile ?? "general",
        }),
      });
      const baseSystemPrompt = promptEnvelope.baseSystemPrompt;
      const subAgentTraceId = `subagent:${handle.sessionId}:${Date.now()}`;
      const unsafeBenchmarkMode = handle.config.unsafeBenchmarkMode === true;
      const traceEnabled =
        this.config.traceExecution === true ||
        this.config.traceProviderPayloads === true;
      const traceStaticFields = {
        parentSessionId: handle.parentSessionId,
        depth: handle.depth,
      };
      const providerTrace =
        traceEnabled
          ? {
            ...(this.config.traceProviderPayloads === true
              ? {
                includeProviderPayloads: true as const,
                onProviderTraceEvent: createProviderTraceEventLogger({
                  logger: this.logger,
                  traceLabel: "sub_agent.provider",
                  traceId: subAgentTraceId,
                  sessionId: handle.sessionId,
                  staticFields: traceStaticFields,
                }),
              }
              : {}),
            onExecutionTraceEvent: createExecutionTraceEventLogger({
              logger: this.logger,
              traceLabel: "sub_agent.executor",
              traceId: subAgentTraceId,
              sessionId: handle.sessionId,
              staticFields: traceStaticFields,
            }),
          }
          : undefined;

      if (traceEnabled) {
        logStructuredTraceEvent({
          logger: this.logger,
          traceLabel: "sub_agent.executor",
          traceId: subAgentTraceId,
          sessionId: handle.sessionId,
          eventType: "execution_profile_resolved",
          staticFields: traceStaticFields,
          payload: {
            provider: resolvedProviderProfile?.provider ?? selectedProvider.name,
            model: resolvedProviderProfile?.model,
            contextWindowTokens: resolvedProviderProfile?.contextWindowTokens,
            contextWindowSource: resolvedProviderProfile?.contextWindowSource,
            maxOutputTokens: resolvedProviderProfile?.maxOutputTokens,
            toolBudgetPerRequest: effectiveToolBudgetPerRequest,
            unsafeBenchmarkMode,
            sessionTokenBudget: resolvedSessionTokenBudget,
            promptBudget: resolvedPromptBudget
              ? {
                contextWindowTokens: resolvedPromptBudget.contextWindowTokens,
                maxOutputTokens: resolvedPromptBudget.maxOutputTokens,
                hardMaxPromptChars: resolvedPromptBudget.hardMaxPromptChars,
                safetyMarginTokens: resolvedPromptBudget.safetyMarginTokens,
                charPerToken: resolvedPromptBudget.charPerToken,
                maxRuntimeHints: resolvedPromptBudget.maxRuntimeHints,
              }
              : undefined,
          },
        });
      }

      const inheritedRequiredToolEvidence = handle.config.delegationSpec
        ? {
            maxCorrectionAttempts: handle.config.requireToolCall ? 1 : 0,
            delegationSpec: handle.config.delegationSpec,
            unsafeBenchmarkMode,
          }
        : undefined;
      const explicitRequiredToolEvidence = handle.config.requiredToolEvidence;
      const requiredToolEvidence =
        inheritedRequiredToolEvidence || explicitRequiredToolEvidence
          ? {
              ...(inheritedRequiredToolEvidence ?? {}),
              ...(explicitRequiredToolEvidence ?? {}),
              maxCorrectionAttempts:
                explicitRequiredToolEvidence?.maxCorrectionAttempts ??
                inheritedRequiredToolEvidence?.maxCorrectionAttempts ??
                0,
            }
          : undefined;

      // When the spawn comes from the orchestrator pipeline (has an
      // execution context with explicit tool scope), pass the resolved
      // tools as routedToolNames so the sub-agent's ChatExecutor uses
      // the full scope instead of re-deriving a narrower set from
      // message content heuristics.  Direct spawns (no delegation spec)
      // continue to use the ChatExecutor's default routing.
      const spawnRoutedTools =
        handle.config.delegationSpec &&
        handle.config.tools &&
        handle.config.tools.length > 0
          ? [...handle.config.tools]
          : undefined;
      const runtimeWorkspaceRoot = resolveSubAgentWorkspaceRoot(handle.config);

      // Phase K: subagent spawn now routes through the generator
      // surface via runSubagentToLegacyResult. Same semantics as
      // the old direct executor.execute() call under the Phase C
      // adapter shape (the helper drains executeChat and returns
      // the legacy result), but the call site is now the stable
      // entry point that a follow-up can swap to a direct
      // helper-orchestration implementation without touching
      // this file.
      const spawnedResult = await raceAbort(
        runSubagentToLegacyResult(executor, {
          sessionId: handle.sessionId,
          parentSessionId: handle.parentSessionId,
          params: {
            message,
            history: handle.history,
            promptEnvelope: {
              ...promptEnvelope,
              baseSystemPrompt,
            },
            sessionId: handle.sessionId,
            ...(spawnRoutedTools
              ? { toolRouting: { routedToolNames: spawnRoutedTools } }
              : {}),
            ...(runtimeWorkspaceRoot
              ? {
                runtimeContext: {
                  workspaceRoot: runtimeWorkspaceRoot,
                },
              }
              : {}),
            ...(typeof effectiveToolBudgetPerRequest === "number"
              ? { toolBudgetPerRequest: effectiveToolBudgetPerRequest }
              : {}),
            ...(requiredToolEvidence
              ? { requiredToolEvidence }
              : {}),
            ...(handle.config.structuredOutput
              ? { structuredOutput: handle.config.structuredOutput }
              : {}),
            ...(providerTrace ? { trace: providerTrace } : {}),
          },
        }),
        handle.abortController.signal,
      );
      // runSubagentToLegacyResult guarantees legacyResult is set
      // on the happy path (Phase C adapter populates
      // Terminal.legacyResult from the underlying
      // ChatExecutorResult). If legacyResult is missing on a
      // non-aborted spawn, the adapter contract was violated —
      // surface as a hard error so the incident is visible.
      const resultOrAbort =
        spawnedResult === ABORT_SENTINEL
          ? ABORT_SENTINEL
          : (spawnedResult.legacyResult ??
            (() => {
              throw new Error(
                "sub-agent: runSubagentToLegacyResult returned without a legacyResult",
              );
            })());

      // Guard: don't overwrite if cancelled/timed_out during execution
      if (resultOrAbort === ABORT_SENTINEL || handle.status !== "running")
        return;

      const terminalStatus = mapChatCompletionToSubAgentStatus({
        completionState: resultOrAbort.completionState,
        stopReason: resultOrAbort.stopReason,
      });
      const success = resultOrAbort.completionState === "completed";
      const output =
        success || !resultOrAbort.stopReasonDetail
          ? resultOrAbort.content
          : resultOrAbort.stopReasonDetail;

      await this.appendConversationTurn(handle, {
        user: { role: "user", content: handle.config.prompt ?? handle.task },
        assistant: { role: "assistant", content: output },
      });

      this.markTerminalState(handle, terminalStatus, {
        sessionId: handle.sessionId,
        output,
        success,
        durationMs: Date.now() - handle.startedAt,
        toolCalls: resultOrAbort.toolCalls,
        providerEvidence: resultOrAbort.providerEvidence,
        structuredOutput: resultOrAbort.structuredOutput,
        tokenUsage: resultOrAbort.tokenUsage,
        providerName: selectedProvider.name,
        completionState: resultOrAbort.completionState,
        completionProgress: resultOrAbort.completionProgress,
        verifierSnapshot: resultOrAbort.verifierSnapshot,
        contractFingerprint: resultOrAbort.turnExecutionContract?.contractFingerprint,
        stopReason: resultOrAbort.stopReason,
        stopReasonDetail: resultOrAbort.stopReasonDetail,
        validationCode: resultOrAbort.validationCode,
      });

      if (success) {
        this.logger.info(`Sub-agent ${handle.sessionId} completed successfully`);
      } else {
        this.logger.warn(
          `Sub-agent ${handle.sessionId} stopped before completion (${resultOrAbort.stopReason})`,
          {
            stopReason: resultOrAbort.stopReason,
            stopReasonDetail: resultOrAbort.stopReasonDetail,
            completionState: resultOrAbort.completionState,
          },
        );
      }
    } catch (err) {
      // Guard: don't overwrite if cancelled/timed_out during execution
      if (handle.status !== "running") return;

      const failedOutput = err instanceof Error ? err.message : String(err);
      this.markTerminalState(handle, "failed", {
        sessionId: handle.sessionId,
        output: failedOutput,
        success: false,
        completionState: "blocked",
        durationMs: Date.now() - handle.startedAt,
        toolCalls: [],
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
        stopReason: "tool_error",
        stopReasonDetail: failedOutput,
      });
      await this.persistHandleState(handle);

      this.logger.error(
        `Sub-agent ${handle.sessionId} failed: ${failedOutput}`,
      );
    } finally {
      // Clear timeout timer
      if (handle.timeoutTimer !== null) {
        clearTimeout(handle.timeoutTimer);
        handle.timeoutTimer = null;
      }

      // Best-effort context cleanup
      if (context) {
        try {
          await this.config.destroyContext(sessionIdentity);
        } catch (cleanupErr) {
          this.logger.warn(
            `Failed to destroy context for sub-agent ${handle.sessionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
    }
  }

  private markTerminalState(
    handle: SubAgentHandle,
    status: Exclude<SubAgentStatus, "running">,
    result: SubAgentResult,
  ): void {
    handle.status = status;
    handle.result = result;
    handle.finishedAt = Date.now();
    void this.persistHandleState(handle).catch((error) => {
      this.logger.warn(
        `Failed to persist sub-agent state for ${handle.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.pruneTerminalHandles();
  }

  private pruneTerminalHandles(now = Date.now()): void {
    const terminal: SubAgentHandle[] = [];
    for (const handle of this.handles.values()) {
      if (handle.status === "running") continue;
      const finishedAt = handle.finishedAt ?? handle.startedAt;
      if (this.terminalHandleRetentionMs > 0) {
        const ageMs = now - finishedAt;
        if (ageMs > this.terminalHandleRetentionMs) {
          this.handles.delete(handle.sessionId);
          continue;
        }
      }
      terminal.push(handle);
    }

    const excess = terminal.length - this.maxRetainedTerminalHandles;
    if (excess <= 0) return;
    terminal.sort((a, b) => {
      const aFinishedAt = a.finishedAt ?? a.startedAt;
      const bFinishedAt = b.finishedAt ?? b.startedAt;
      return aFinishedAt - bFinishedAt;
    });
    for (const handle of terminal.slice(0, excess)) {
      this.handles.delete(handle.sessionId);
    }
  }

  private resolveSessionDepth(sessionId: string): number {
    const existing = this.handles.get(sessionId);
    if (existing) return existing.depth;
    return sessionId.startsWith(SUB_AGENT_SESSION_PREFIX) ? 1 : 0;
  }

  private async resolveContinuationHandle(
    config: SubAgentConfig,
  ): Promise<SubAgentHandle | undefined> {
    const continuationSessionId = config.continuationSessionId?.trim();
    if (!continuationSessionId) return undefined;

    const existing =
      this.handles.get(continuationSessionId) ??
      (await this.loadPersistedContinuationHandle(continuationSessionId));
    if (!existing) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" was not found`,
      );
    }
    if (existing.status === "running") {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" is still running`,
      );
    }
    if (existing.parentSessionId !== config.parentSessionId) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `continuationSessionId "${continuationSessionId}" belongs to a different parent session`,
      );
    }
    const compatibilityError = validateContinuationCompatibility({
      existing: existing.config,
      next: config,
    });
    if (compatibilityError) {
      throw new SubAgentSpawnError(
        config.parentSessionId,
        `${compatibilityError} (${continuationSessionId})`,
      );
    }
    return existing;
  }

  private composeToolHandler(
    sessionIdentity: SubAgentSessionIdentity,
    context: IsolatedSessionContext,
    handle: SubAgentHandle,
  ): ToolHandler {
    const baseToolHandler = context.toolRegistry.createToolHandler();
    if (!this.config.composeToolHandler) {
      return baseToolHandler;
    }
    return this.config.composeToolHandler({
      sessionIdentity,
      context,
      baseToolHandler,
      task: handle.task,
      allowedToolNames: handle.config.tools
        ? [...handle.config.tools]
        : undefined,
      workingDirectory: resolveSubAgentWorkingDirectory(handle.config),
      executionContext: handle.config.delegationSpec?.executionContext,
      desktopRoutingSessionId: this.resolveDesktopRoutingSessionId(
        handle.parentSessionId,
      ),
    });
  }

  private resolveDesktopRoutingSessionId(parentSessionId: string): string {
    const visited = new Set<string>();
    let current = parentSessionId;

    while (
      current.startsWith(SUB_AGENT_SESSION_PREFIX) &&
      !visited.has(current)
    ) {
      visited.add(current);
      const parentHandle = this.handles.get(current);
      if (!parentHandle) break;
      current = parentHandle.parentSessionId;
    }

    return current;
  }
}
