/**
 * Workflow DAG Orchestrator module.
 *
 * Provides multi-step task workflow submission and monitoring on the AgenC
 * protocol. Workflows are tree-structured (single parent per task) to match
 * the on-chain `depends_on: Option<Pubkey>` constraint.
 *
 * @module
 */

// Types
export {
  OnChainDependencyType,
  WorkflowNodeStatus,
  WorkflowStatus,
  type TaskTemplate,
  type WorkflowGraphEdge,
  type WorkflowEdge,
  type WorkflowDefinition,
  type WorkflowConfig,
  type WorkflowNode,
  type WorkflowState,
  type WorkflowStats,
  type WorkflowCallbacks,
  type DAGOrchestratorConfig,
} from "./types.js";

// Errors
export {
  WorkflowValidationError,
  WorkflowSubmissionError,
  WorkflowMonitoringError,
  WorkflowStateError,
} from "./errors.js";

// Validation
export { validateWorkflow, topologicalSort } from "./validation.js";

// Goal compiler
export {
  GoalCompiler,
  estimateWorkflow,
  type GoalPlannerInput,
  type PlannerTaskDraft,
  type PlannerWorkflowDraft,
  type GoalPlanner,
  type GoalCompileRequest,
  type GoalCompileWarning,
  type WorkflowDryRunEstimate,
  type GoalCompileResult,
  type GoalCompilerDefaults,
  type GoalCompilerConfig,
} from "./compiler.js";

// Optimizer contracts
export {
  WORKFLOW_FEATURE_SCHEMA_VERSION,
  WORKFLOW_OBJECTIVE_SCHEMA_VERSION,
  createDefaultWorkflowObjectiveSpec,
  validateWorkflowObjectiveSpec,
  scoreWorkflowObjective,
  workflowObjectiveOutcomeFromFeature,
  parseWorkflowFeatureVector,
  type WorkflowRunOutcome,
  type WorkflowTopologyFeatures,
  type WorkflowCompositionFeatures,
  type WorkflowNodeFeature,
  type WorkflowOutcomeLabels,
  type WorkflowFeatureVector,
  type LegacyWorkflowFeatureVectorV0,
  type WorkflowObjectiveMetric,
  type WorkflowObjectiveWeight,
  type WorkflowObjectiveSpec,
  type WorkflowObjectiveOutcome,
} from "./optimizer-types.js";

// Optimizer feature extraction
export {
  WORKFLOW_TELEMETRY_KEYS,
  extractWorkflowFeatureVector,
  extractWorkflowFeatureVectorFromCollector,
  type WorkflowFeatureExtractionOptions,
} from "./feature-extractor.js";

// Optimizer mutations
export {
  generateWorkflowMutationCandidates,
  type WorkflowMutationOperator,
  type WorkflowMutationRecord,
  type WorkflowMutationCandidate,
  type WorkflowMutationConfig,
} from "./mutations.js";

// Optimizer selection engine
export {
  WorkflowOptimizer,
  type WorkflowOptimizerRuntimeConfig,
  type WorkflowOptimizerConfig,
  type WorkflowOptimizationInput,
  type WorkflowCandidateScore,
  type WorkflowOptimizationAuditEntry,
  type WorkflowOptimizationResult,
} from "./optimizer.js";

// Canary rollout controller
export {
  WorkflowCanaryRollout,
  type WorkflowRolloutStopLossThresholds,
  type WorkflowRolloutConfig,
  type WorkflowRolloutSample,
  type WorkflowRolloutVariantStats,
  type WorkflowRolloutDeltas,
  type WorkflowRolloutAction,
  type WorkflowRolloutReason,
  type WorkflowRolloutDecision,
} from "./rollout.js";

// Submitter
export { DAGSubmitter } from "./submitter.js";

// Monitor
export { DAGMonitor } from "./monitor.js";

// Orchestrator
export { DAGOrchestrator } from "./orchestrator.js";

// Pipeline executor (resumable workflows)
export {
  PipelineExecutor,
  type PipelineStepErrorPolicy,
  type PipelineStep,
  type PipelinePlannerStepType,
  type PipelinePlannerDeterministicStep,
  type PipelinePlannerSubagentStep,
  type PipelinePlannerSynthesisStep,
  type PipelinePlannerStep,
  type PipelinePlannerContextHistoryRole,
  type PipelinePlannerContextHistoryEntry,
  type PipelinePlannerContextMemorySource,
  type PipelinePlannerContextMemoryEntry,
  type PipelinePlannerContextToolOutputEntry,
  type PipelinePlannerContext,
  type PipelineContext,
  type Pipeline,
  type PipelineStatus,
  type PipelineStopReasonHint,
  type PipelineResult,
  type PipelineCheckpoint,
  type PipelineExecutorConfig,
} from "./pipeline.js";

export {
  CanonicalExecutionKernel,
  type ExecutionKernelConfig,
} from "./execution-kernel.js";

export type {
  ExecutionKernel,
  ExecutionKernelPlannerDelegate,
  ExecutionKernelStepState,
  ExecutionKernelStepStateChange,
  ExecutionKernelNodeOutcome,
  ExecutionKernelFallbackResolution,
  ExecutionKernelDependencyState,
} from "./execution-kernel-types.js";

export type {
  ExecutionEnvelope,
  ExecutionEnvelopeVersion,
  ExecutionEffectClass,
  ExecutionVerificationMode,
  ExecutionStepKind,
  ExecutionFallbackPolicy,
  ExecutionResumePolicy,
  ExecutionApprovalProfile,
} from "./execution-envelope.js";

export { createExecutionEnvelope } from "./execution-envelope.js";
export type {
  ImplementationCompletionTaskClass,
  ImplementationCompletionContract,
} from "./completion-contract.js";
export type { ArtifactContract, ArtifactAccessMode } from "./artifact-contract.js";
export { buildArtifactContract, isArtifactAccessAllowed } from "./artifact-contract.js";
export type { WorkflowVerificationContract } from "./verification-obligations.js";
export type {
  EffectLedgerVersion,
  EffectStatus,
  EffectKind,
  EffectScope,
  EffectTarget,
  EffectApprovalRef,
  EffectFilesystemSnapshot,
  EffectCompensationAction,
  EffectCompensationState,
  EffectAttemptRecord,
  EffectResultSummary,
  EffectRecord,
} from "./effects.js";
export {
  inferEffectClass,
  inferEffectKind,
  isMutatingTool,
  buildEffectIntentSummary,
} from "./effects.js";
export { EffectLedger } from "./effect-ledger.js";
export { MemoryBackendEffectStorage } from "./effect-storage.js";
export {
  runWithEffectExecutionContext,
  getCurrentEffectExecutionContext,
  deriveEffectIdempotencyKey,
  buildPipelineEffectIdempotencyKey,
  type EffectExecutionContext,
} from "./idempotency.js";
export {
  captureFilesystemSnapshot,
  capturePreExecutionSnapshots,
  capturePostExecutionSnapshots,
  buildCompensationState,
  executeCompensation,
} from "./compensation.js";
