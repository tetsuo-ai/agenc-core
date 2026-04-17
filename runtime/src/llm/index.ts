/**
 * LLM Adapters for @tetsuo-ai/runtime
 *
 * Provides LLM provider adapters that bridge language models
 * to the AgenC task execution system (Phase 4).
 *
 * @module
 */

// Core types
export type {
  LLMProvider,
  LLMProviderConfig,
  LLMContentPart,
  LLMMessage,
  LLMChatOptions,
  LLMCompactionDiagnostics,
  LLMCompactionFallbackReason,
  LLMCompactionItemRef,
  LLMStatefulResponsesConfig,
  LLMStoredResponse,
  LLMStoredResponseDeleteResult,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  MessageRole,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
export { validateToolCall } from "./types.js";
export {
  buildUnsupportedCompactionDiagnostics,
} from "./provider-capabilities.js";
export type {
  ResolvedLLMCompactionConfig,
} from "./provider-capabilities.js";

// Error classes
export {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMResponseConversionError,
  LLMServerError,
  LLMToolCallError,
  LLMTimeoutError,
  classifyLLMFailure,
  mapLLMError,
} from "./errors.js";

// Policy taxonomy (Phase 1)
export {
  DEFAULT_LLM_RETRY_POLICY_MATRIX,
  toPipelineStopReason,
} from "./policy.js";
export type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyRule,
  LLMRetryPolicyMatrix,
} from "./policy.js";

// Tool-turn protocol validation (Phase 1)
export {
  findToolTurnValidationIssue,
  repairToolTurnSequence,
  validateToolTurnSequence,
} from "./tool-turn-validator.js";
export type {
  ToolTurnValidationCode,
  ToolTurnValidationIssue,
  ToolTurnValidationOptions,
} from "./tool-turn-validator.js";

// Prompt budgeting (Phase 2)
export {
  applyPromptBudget,
  derivePromptBudgetPlan,
} from "./prompt-budget.js";
export type {
  PromptBudgetConfig,
  PromptBudgetPlan,
  PromptBudgetCaps,
  PromptBudgetSection,
  PromptBudgetMessage,
  PromptBudgetDiagnostics,
  PromptBudgetSectionStats,
  PromptBudgetMemoryRole,
  PromptBudgetMemoryRoleContract,
  PromptBudgetMemoryRoleContracts,
} from "./prompt-budget.js";

// Response converter
export { responseToOutput } from "./response-converter.js";

export { FallbackLLMProvider, type FallbackChainConfig } from "./fallback.js";

// Chat Executor (Phase 1.11)
export { ChatExecutor, ChatBudgetExceededError } from "./chat-executor.js";
export type {
  ChatExecutorConfig,
  ChatExecuteParams,
  ChatExecutorResult,
  ChatPromptShape,
  ChatCallUsageRecord,
  PlannerDiagnostic,
  ToolCallRecord,
  SkillInjector,
  MemoryRetriever,
} from "./chat-executor.js";

// Delegation learning (trajectory recording for offline analysis)
export {
  DELEGATION_TRAJECTORY_SCHEMA_VERSION,
  InMemoryDelegationTrajectorySink,
  computeDelegationFinalReward,
  deriveDelegationComplexityBucket,
  deriveDelegationContextClusterId,
} from "./delegation-learning.js";
export type {
  DelegationTrajectoryTurnType,
  DelegationTrajectoryStateFeatures,
  DelegationTrajectoryAction,
  DelegationTrajectoryImmediateOutcome,
  DelegationTrajectoryFinalReward,
  DelegationTrajectoryRecord,
  DelegationTrajectorySink,
  InMemoryDelegationTrajectorySinkConfig,
  DelegationFinalRewardInput,
  DelegationComplexityBucket,
  DelegationContextClusterInput,
} from "./delegation-learning.js";

// Provider adapters
export { GrokProvider, type GrokProviderConfig } from "./grok/index.js";
export { OllamaProvider, type OllamaProviderConfig } from "./ollama/index.js";
