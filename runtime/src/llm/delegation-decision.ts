import type { WorkflowGraphEdge } from "../workflow/types.js";
import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import type { DelegationBudgetSnapshot } from "./run-budget.js";
import {
  assessDelegationAdmission,
} from "../gateway/delegation-admission.js";
import { normalizeRuntimeLimit } from "./runtime-limit-policy.js";
import { safeStepStringArray } from "./chat-executor-planner.js";

export type DelegationDecisionReason =
  | "delegation_disabled"
  | "no_subagent_steps"
  | "hard_blocked_task_class"
  | "trivial_request"
  | "single_hop_request"
  | "shared_context_review"
  | "shared_artifact_writer_inline"
  | "fanout_exceeded"
  | "depth_exceeded"
  | "handoff_confidence_below_threshold"
  | "safety_risk_high"
  | "score_below_threshold"
  | "missing_execution_envelope"
  | "parallel_gain_insufficient"
  | "dependency_coupling_high"
  | "tool_overlap_high"
  | "verifier_cost_high"
  | "retry_cost_high"
  | "negative_economics"
  | "no_safe_delegation_shape"
  | "approved";

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration";

export type DelegationHardBlockedMatchSource = "capability" | "text";

export interface DelegationDecisionConfig {
  readonly enabled?: boolean;
  readonly mode?: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxDepth?: number;
  readonly handoffMinPlannerConfidence?: number;
  readonly hardBlockedTaskClasses?: readonly DelegationHardBlockedTaskClass[];
}

export interface ResolvedDelegationDecisionConfig {
  readonly enabled: boolean;
  readonly mode: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold: number;
  readonly maxFanoutPerTurn: number;
  readonly maxDepth: number;
  readonly handoffMinPlannerConfidence: number;
  readonly hardBlockedTaskClasses: ReadonlySet<DelegationHardBlockedTaskClass>;
}

export interface DelegationSubagentStepProfile {
  readonly name: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly dependsOn?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly requiredToolCapabilities: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly executionContext?: DelegationExecutionContext;
  readonly maxBudgetHint: string;
  readonly canRunParallel: boolean;
}

export interface DelegationDecisionInput {
  readonly messageText: string;
  readonly explicitDelegationRequested?: boolean;
  readonly plannerConfidence?: number;
  readonly complexityScore: number;
  readonly totalSteps: number;
  readonly synthesisSteps: number;
  readonly edges: readonly WorkflowGraphEdge[];
  readonly subagentSteps: readonly DelegationSubagentStepProfile[];
  readonly config?: DelegationDecisionConfig;
  readonly budgetSnapshot?: DelegationBudgetSnapshot;
}

export interface DelegationDecision {
  readonly shouldDelegate: boolean;
  readonly reason: DelegationDecisionReason;
  readonly threshold: number;
  readonly utilityScore: number;
  readonly decompositionBenefit: number;
  readonly coordinationOverhead: number;
  readonly latencyCostRisk: number;
  readonly safetyRisk: number;
  readonly confidence: number;
  readonly hardBlockedTaskClass: DelegationHardBlockedTaskClass | null;
  readonly hardBlockedTaskClassSource: DelegationHardBlockedMatchSource | null;
  readonly hardBlockedTaskClassSignal: string | null;
  readonly diagnostics: Readonly<Record<string, number | boolean | string>>;
}

const DEFAULT_SCORE_THRESHOLD = 0.2;
const DEFAULT_MAX_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE = 0.82;
const DEFAULT_SUBAGENT_MODE = "manager_tools" as const;
const SAFETY_RISK_HARD_BLOCK_THRESHOLD = 0.9;

const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
];

const HIGH_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^wallet\./i,
  /^solana\./i,
  /^agenc\./i,
  /^desktop\./i,
  /^system\.(?:delete|execute|open|applescript|notification)$/i,
];

const MODERATE_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^system\.(?:bash|writeFile|appendFile)$/i,
  /^system\.http$/i,
  /^playwright\./i,
];

const WALLET_SIGNING_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:sign|approve|authorize)(?:\.|$)/i;
const WALLET_TRANSFER_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:transfer|send|withdraw|swap|pay)(?:\.|$)/i;
const STAKE_OR_REWARDS_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:stake|unstake|delegate|undelegate|reward|rewards|claim)(?:\.|$)/i;
const DESTRUCTIVE_HOST_MUTATION_CAPABILITY_RE =
  /^system\.(?:delete|writeFile|execute|open|applescript)(?:\.|$)/i;
const NETWORK_EGRESS_CAPABILITY_RE =
  /^(?:system\.http|system\.bash|desktop\.bash|playwright\.)/i;
const CREDENTIAL_MARKER_PATTERNS: readonly RegExp[] = [
  /\bsecret(?:s)?\b/i,
  /\bapi(?:[_-]?key|\s+key)\b/i,
  /\b(?:access|auth|bearer|refresh|session)\s+token\b/i,
  /\bpassword(?:s)?\b/i,
  /\bprivate[_\s-]?key\b/i,
  /\bseed\s+phrase\b/i,
  /\bmnemonic\b/i,
  /\bssh\s+key\b/i,
  /\bcredentials?\b/i,
  /\bclient\s+secret\b/i,
  /\bconsumer\s+secret\b/i,
  /\b\.env\b/i,
];
const CREDENTIAL_EXFIL_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:exfiltrat(?:e|ion)|leak|steal|dump|export|extract|copy|print|echo|reveal|expose|show|send|upload|post|curl|transmit|forward)\b[\s\S]{0,72}\b(?:secret|api(?:[_-]?key|\s+key)|token|password|private[_\s-]?key|seed\s+phrase|mnemonic|credentials?|\.env)\b/i,
  /\b(?:secret|api(?:[_-]?key|\s+key)|token|password|private[_\s-]?key|seed\s+phrase|mnemonic|credentials?|\.env)\b[\s\S]{0,72}\b(?:exfiltrat(?:e|ion)|leak|steal|dump|export|extract|copy|print|echo|reveal|expose|show|send|upload|post|curl|transmit|forward)\b/i,
];
const WALLET_SIGNING_TEXT_RE =
  /\b(sign|authorize|approve)\b[\s\S]{0,48}\b(wallet|transaction|tx)\b/i;
const WALLET_TRANSFER_TEXT_RE =
  /\b(transfer|send|withdraw|pay)\b[\s\S]{0,48}\b(sol|token|fund|wallet|usdc|usdt)\b/i;
const STAKE_OR_REWARDS_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(stake|unstake|undelegate)\b[\s\S]{0,48}\b(sol|token|tokens|validator|stake|staking|reward|rewards|yield|wallet)\b/i,
  /\b(delegate)\b[\s\S]{0,48}\b(stake|staking|validator|vote\s+account|sol|token|tokens|reward|rewards)\b/i,
  /\b(claim|reward|rewards)\b[\s\S]{0,48}\b(stake|staking|validator|sol|token|tokens|wallet|yield|epoch)\b/i,
  /\b(stake|staking|validator|yield|epoch)\b[\s\S]{0,48}\b(reward|rewards|claim|delegate|undelegate|unstake)\b/i,
];

interface HardBlockedTaskClassMatch {
  readonly taskClass: DelegationHardBlockedTaskClass;
  readonly source: DelegationHardBlockedMatchSource;
  readonly signal: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function resolveDelegationDecisionConfig(
  config?: DelegationDecisionConfig,
): ResolvedDelegationDecisionConfig {
  const mode = config?.mode === "handoff" || config?.mode === "hybrid"
    ? config.mode
    : DEFAULT_SUBAGENT_MODE;
  const hardBlockedTaskClasses = new Set<DelegationHardBlockedTaskClass>();
  const configuredHardBlocked = config?.hardBlockedTaskClasses;
  if (Array.isArray(configuredHardBlocked)) {
    for (const taskClass of configuredHardBlocked) {
      if (
        taskClass === "wallet_signing" ||
        taskClass === "wallet_transfer" ||
        taskClass === "stake_or_rewards" ||
        taskClass === "destructive_host_mutation" ||
        taskClass === "credential_exfiltration"
      ) {
        hardBlockedTaskClasses.add(taskClass);
      }
    }
  } else {
    for (const taskClass of DEFAULT_HARD_BLOCKED_TASK_CLASSES) {
      hardBlockedTaskClasses.add(taskClass);
    }
  }
  return {
    enabled: config?.enabled === true,
    mode,
    scoreThreshold: clamp01(config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD),
    maxFanoutPerTurn: normalizeRuntimeLimit(
      config?.maxFanoutPerTurn,
      DEFAULT_MAX_FANOUT_PER_TURN,
    ),
    maxDepth: Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    handoffMinPlannerConfidence: clamp01(
      config?.handoffMinPlannerConfidence ??
        DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE,
    ),
    hardBlockedTaskClasses,
  };
}

export function assessDelegationDecision(
  input: DelegationDecisionInput,
): DelegationDecision {
  const resolvedConfig = resolveDelegationDecisionConfig(input.config);
  const hardBlockedMatch = detectHardBlockedTaskClass(input, resolvedConfig);
  const hardBlockedTaskClass = hardBlockedMatch?.taskClass ?? null;

  const safetyRisk = computeSafetyRisk(input.subagentSteps);
  const plannerConfidence = clamp01(input.plannerConfidence ?? 0);

  if (!resolvedConfig.enabled) {
    return buildDecision({
      shouldDelegate: false,
      reason: "delegation_disabled",
      threshold: resolvedConfig.scoreThreshold,
      utilityScore: 0,
      decompositionBenefit: 0,
      coordinationOverhead: 0,
      latencyCostRisk: 0,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
      diagnostics: {
        threshold: resolvedConfig.scoreThreshold,
        enabled: false,
      },
    });
  }

  if (input.subagentSteps.length === 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "no_subagent_steps",
      threshold: resolvedConfig.scoreThreshold,
      utilityScore: 0,
      decompositionBenefit: 0,
      coordinationOverhead: 0,
      latencyCostRisk: 0,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
      diagnostics: {
        threshold: resolvedConfig.scoreThreshold,
        enabled: true,
      },
    });
  }

  if (hardBlockedTaskClass) {
    return buildDecision({
      shouldDelegate: false,
      reason: "hard_blocked_task_class",
      threshold: resolvedConfig.scoreThreshold,
      utilityScore: 0,
      decompositionBenefit: 0,
      coordinationOverhead: 0,
      latencyCostRisk: 0,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
      diagnostics: {
        threshold: resolvedConfig.scoreThreshold,
        hasHardBlockedTaskClass: true,
      },
    });
  }

  if (
    resolvedConfig.mode === "handoff" &&
    plannerConfidence < resolvedConfig.handoffMinPlannerConfidence
  ) {
    return buildDecision({
      shouldDelegate: false,
      reason: "handoff_confidence_below_threshold",
      threshold: resolvedConfig.scoreThreshold,
      utilityScore: 0,
      decompositionBenefit: 0,
      coordinationOverhead: 0,
      latencyCostRisk: 0,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
      diagnostics: {
        threshold: resolvedConfig.scoreThreshold,
        handoffMinPlannerConfidence: resolvedConfig.handoffMinPlannerConfidence,
      },
    });
  }

  if (safetyRisk >= SAFETY_RISK_HARD_BLOCK_THRESHOLD) {
    return buildDecision({
      shouldDelegate: false,
      reason: "safety_risk_high",
      threshold: resolvedConfig.scoreThreshold,
      utilityScore: 0,
      decompositionBenefit: 0,
      coordinationOverhead: 0,
      latencyCostRisk: 0,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
      diagnostics: {
        threshold: resolvedConfig.scoreThreshold,
        safetyRisk: Number(safetyRisk.toFixed(4)),
      },
    });
  }

  const admission = assessDelegationAdmission({
    messageText: input.messageText,
    explicitDelegationRequested: input.explicitDelegationRequested,
    totalSteps: input.totalSteps,
    synthesisSteps: input.synthesisSteps,
    steps: input.subagentSteps,
    edges: input.edges,
    threshold: resolvedConfig.scoreThreshold,
    maxFanoutPerTurn: resolvedConfig.maxFanoutPerTurn,
    maxDepth: resolvedConfig.maxDepth,
    budgetSnapshot: input.budgetSnapshot,
  });

  const reason = admission.reason as DelegationDecisionReason;
  const economics = admission.economics;
  const confidence = clamp01(
    0.25 +
      economics.explicitOwnershipCoverage * 0.35 +
      (admission.shape ? 0.2 : 0) +
      plannerConfidence * 0.2,
  );
  const latencyCostRisk = clamp01(
    economics.verifierCost * 0.45 +
      economics.retryCost * 0.45 +
      economics.contextFootprint * 0.1,
  );

  return buildDecision({
    shouldDelegate: admission.allowed,
    reason: admission.allowed ? "approved" : reason,
    threshold: resolvedConfig.scoreThreshold,
    utilityScore: economics.utilityScore,
    decompositionBenefit: economics.parallelGain,
    coordinationOverhead: economics.dependencyCoupling,
    latencyCostRisk,
    safetyRisk,
    confidence,
    hardBlockedMatch,
    diagnostics: {
      ...admission.diagnostics,
      plannerConfidence: Number(plannerConfidence.toFixed(4)),
      threshold: resolvedConfig.scoreThreshold,
      modeHandoff: resolvedConfig.mode === "handoff",
      maxFanoutPerTurn: resolvedConfig.maxFanoutPerTurn,
      maxDepth: resolvedConfig.maxDepth,
    },
  });
}

function buildDecision(input: {
  readonly shouldDelegate: boolean;
  readonly reason: DelegationDecisionReason;
  readonly threshold: number;
  readonly utilityScore: number;
  readonly decompositionBenefit: number;
  readonly coordinationOverhead: number;
  readonly latencyCostRisk: number;
  readonly safetyRisk: number;
  readonly confidence: number;
  readonly hardBlockedMatch: HardBlockedTaskClassMatch | null;
  readonly diagnostics: Readonly<Record<string, number | boolean | string>>;
}): DelegationDecision {
  const hardBlockedDiagnostics: Record<string, boolean> = {
    hasHardBlockedTaskClass: input.hardBlockedMatch !== null,
    hardBlockedTaskClassMatchedByText:
      input.hardBlockedMatch?.source === "text",
    hardBlockedTaskClassMatchedByCapability:
      input.hardBlockedMatch?.source === "capability",
  };
  return {
    shouldDelegate: input.shouldDelegate,
    reason: input.reason,
    threshold: input.threshold,
    utilityScore: input.utilityScore,
    decompositionBenefit: input.decompositionBenefit,
    coordinationOverhead: input.coordinationOverhead,
    latencyCostRisk: input.latencyCostRisk,
    safetyRisk: input.safetyRisk,
    confidence: input.confidence,
    hardBlockedTaskClass: input.hardBlockedMatch?.taskClass ?? null,
    hardBlockedTaskClassSource: input.hardBlockedMatch?.source ?? null,
    hardBlockedTaskClassSignal: input.hardBlockedMatch?.signal ?? null,
    diagnostics: {
      ...hardBlockedDiagnostics,
      ...input.diagnostics,
    },
  };
}

function computeSafetyRisk(
  steps: readonly DelegationSubagentStepProfile[],
): number {
  const normalizedCapabilities = new Set<string>();
  let parallelMutableSteps = 0;

  for (const step of steps) {
    if (
      step.canRunParallel &&
      step.executionContext &&
      step.executionContext.effectClass !== "read_only"
    ) {
      parallelMutableSteps += 1;
    }
    for (const capability of safeStepStringArray(step.requiredToolCapabilities)) {
      normalizedCapabilities.add(capability.trim().toLowerCase());
    }
  }

  let highRiskCount = 0;
  let moderateRiskCount = 0;
  for (const capability of normalizedCapabilities) {
    if (HIGH_RISK_CAPABILITY_PATTERNS.some((pattern) => pattern.test(capability))) {
      highRiskCount += 1;
      continue;
    }
    if (MODERATE_RISK_CAPABILITY_PATTERNS.some((pattern) => pattern.test(capability))) {
      moderateRiskCount += 1;
    }
  }

  const parallelExposure = clamp01(
    steps.length > 0 ? parallelMutableSteps / steps.length : 0,
  );
  return clamp01(
    0.05 +
      highRiskCount * 0.22 +
      moderateRiskCount * 0.08 +
      parallelExposure * 0.18,
  );
}

function detectHardBlockedTaskClass(
  input: DelegationDecisionInput,
  config: ResolvedDelegationDecisionConfig,
): HardBlockedTaskClassMatch | null {
  if (config.hardBlockedTaskClasses.size === 0) return null;

  const capabilities = input.subagentSteps.flatMap((step) =>
    safeStepStringArray(step.requiredToolCapabilities).map((capability) => capability.trim()),
  );
  const textBlob = [
    input.messageText,
    ...input.subagentSteps.map((step) => step.name),
    ...input.subagentSteps.map((step) => step.objective ?? ""),
    ...input.subagentSteps.map((step) => step.inputContract ?? ""),
    ...input.subagentSteps.flatMap((step) => safeStepStringArray(step.acceptanceCriteria)),
    ...input.subagentSteps.flatMap((step) => safeStepStringArray(step.contextRequirements)),
  ].join("\n");

  if (config.hardBlockedTaskClasses.has("wallet_signing")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      WALLET_SIGNING_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "wallet_signing",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, [WALLET_SIGNING_TEXT_RE]);
    if (textMatch) {
      return buildHardBlockedMatch("wallet_signing", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("wallet_transfer")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      WALLET_TRANSFER_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "wallet_transfer",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, [WALLET_TRANSFER_TEXT_RE]);
    if (textMatch) {
      return buildHardBlockedMatch("wallet_transfer", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("stake_or_rewards")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      STAKE_OR_REWARDS_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "stake_or_rewards",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, STAKE_OR_REWARDS_TEXT_PATTERNS);
    if (textMatch) {
      return buildHardBlockedMatch("stake_or_rewards", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("destructive_host_mutation")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      DESTRUCTIVE_HOST_MUTATION_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "destructive_host_mutation",
        "capability",
        capabilityMatch,
      );
    }
  }

  if (config.hardBlockedTaskClasses.has("credential_exfiltration")) {
    const credentialTextMatch = findTextMatch(
      textBlob,
      CREDENTIAL_MARKER_PATTERNS,
    );
    const exfilIntentTextMatch = findTextMatch(
      textBlob,
      CREDENTIAL_EXFIL_INTENT_PATTERNS,
    );
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      NETWORK_EGRESS_CAPABILITY_RE,
    );
    if (credentialTextMatch && exfilIntentTextMatch && capabilityMatch) {
      return buildHardBlockedMatch(
        "credential_exfiltration",
        "capability",
        capabilityMatch,
      );
    }
  }

  return null;
}

function buildHardBlockedMatch(
  taskClass: DelegationHardBlockedTaskClass,
  source: DelegationHardBlockedMatchSource,
  signal: string,
): HardBlockedTaskClassMatch {
  return {
    taskClass,
    source,
    signal: summarizeHardBlockedSignal(signal),
  };
}

function findCapabilityMatch(
  capabilities: readonly string[],
  pattern: RegExp,
): string | null {
  for (const capability of capabilities) {
    if (pattern.test(capability)) {
      return capability;
    }
  }
  return null;
}

function findTextMatch(
  textBlob: string,
  patterns: readonly RegExp[],
): string | null {
  for (const pattern of patterns) {
    const match = textBlob.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }
  return null;
}

function summarizeHardBlockedSignal(signal: string): string {
  const normalized = signal.replace(/\s+/g, " ").trim();
  if (normalized.length <= 96) {
    return normalized;
  }
  return `${normalized.slice(0, 93)}...`;
}
