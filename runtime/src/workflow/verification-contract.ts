import type {
  DelegationContractSpec,
  DelegationValidationProviderEvidence,
  DelegationValidationToolCall,
} from "../utils/delegation-validation.js";
import {
  extractDelegationTokens,
  getAcceptanceVerificationCategories,
} from "../utils/delegation-validation.js";
import { isArtifactAccessAllowed } from "./artifact-contract.js";
import type { PlaceholderTaxonomy } from "./completion-contract.js";
import { isPathWithinRoot, normalizeEnvelopePath } from "./path-normalization.js";
import {
  collectWorkspaceInspectionPathCandidates,
  isMeaningfulWorkspaceInspectionToolCall,
} from "./workspace-inspection-evidence.js";
import {
  deriveVerificationObligations,
  hasDelegationRuntimeVerificationContext,
  type VerificationObligations,
  type WorkflowVerificationContract,
} from "./verification-obligations.js";
import {
  type RuntimeVerificationChannelDecision,
  type RuntimeVerificationDecision,
  resolveRuntimeVerificationDecision,
  verificationChannelFail,
  verificationChannelPass,
} from "./verification-results.js";

interface EncodedEffectTarget {
  readonly kind?: string;
  readonly path?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly label?: string;
}

interface EncodedEffectSnapshot {
  readonly path?: string;
  readonly exists?: boolean;
  readonly entryType?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

interface EncodedEffectResult {
  readonly observedMutationsUnknown?: boolean;
}

interface EncodedEffectMetadata {
  readonly id?: string;
  readonly idempotencyKey?: string;
  readonly kind?: string;
  readonly effectClass?: string;
  readonly status?: string;
  readonly targets?: readonly EncodedEffectTarget[];
  readonly preExecutionSnapshots?: readonly EncodedEffectSnapshot[];
  readonly postExecutionSnapshots?: readonly EncodedEffectSnapshot[];
  readonly result?: EncodedEffectResult;
}

interface EncodedVerificationMetadata {
  readonly category?: "build" | "behavior" | "review";
  readonly repoLocal?: boolean;
  readonly generatedHarness?: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly path?: string;
}

interface RuntimeArtifactEvidence {
  readonly readArtifacts: ReadonlySet<string>;
  readonly readArtifactContents: ReadonlyMap<string, readonly string[]>;
  readonly inspectedWorkspaceArtifacts: ReadonlySet<string>;
  readonly mutatedArtifacts: ReadonlySet<string>;
  readonly unauthorizedMutations: readonly string[];
  readonly successfulToolCalls: number;
  readonly authoredContent: readonly string[];
  readonly evidenceCorpus: readonly string[];
  readonly executableOutcomes: {
    readonly build: boolean;
    readonly behavior: boolean;
    readonly review: boolean;
  };
  readonly executableAttempts: {
    readonly build: boolean;
    readonly behavior: boolean;
    readonly review: boolean;
  };
  readonly repoLocalBehaviorHarness: boolean;
  readonly generatedBehaviorHarness: boolean;
}

const READ_FILE_TOOL_NAMES = new Set(["system.readFile"]);
const WORKSPACE_INSPECTION_TOOL_NAMES = new Set([
  "system.readFile",
  "system.listDir",
  "system.stat",
  "desktop.text_editor",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const DIRECT_MUTATION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.appendFile",
  "system.delete",
  "system.mkdir",
  "system.move",
  "system.writeFile",
]);
const SHELL_TOOL_NAMES = new Set(["system.bash", "desktop.bash"]);
const NOOP_COMPLETION_RE =
  /\b(?:already (?:satisf(?:ies|y)|exists?|present|up to date)|no\s+(?:changes?|mutations?|updates?|edits?)\b(?:[\s\S]{0,80}?)\b(?:needed|required|necessary)\b|nothing to change|nothing to update|no edits?\s+(?:were\s+)?needed)\b/i;
const IMPLEMENTATION_PLACEHOLDER_MARKER_RE =
  /\b(?:stub(?:bed)?|placeholder|todo|not implemented|unimplemented|pending implementation|coming soon|fixme)\b/i;
const DOCUMENTATION_PLACEHOLDER_MARKER_RE =
  /\b(?:placeholder|todo|fixme|tbd|coming soon)\b|\[(?:same\b|etc\.?\b|omitted\b|truncated\b|cop(?:y|ied)\b|unchanged\b|full content\b)[^\]]*\]/i;
const IMPLEMENTATION_RESOLVED_PLACEHOLDER_CUE_RE =
  /\b(?:resolve(?:d|s|ing)?|replace(?:d|s|ing)?|remove(?:d|s|ing)?|clear(?:ed|s|ing)?|fix(?:ed|es|ing)?|complete(?:d|s|ing)?)\b[^.\n]{0,64}\b(?:placeholder(?:s)?|stub(?:s|bed)?|todo|fixme|unimplemented)\b|\b(?:placeholder(?:s)?|stub(?:s|bed)?|todo|fixme|unimplemented)\b[^.\n]{0,64}\b(?:resolve(?:d|s|ing)?|replace(?:d|s|ing)?|remove(?:d|s|ing)?|clear(?:ed|s|ing)?|fix(?:ed|es|ing)?|complete(?:d|s|ing)?)\b/i;
const DOCUMENTATION_RESOLVED_PLACEHOLDER_CUE_RE =
  /\b(?:resolve(?:d|s|ing)?|replace(?:d|s|ing)?|remove(?:d|s|ing)?|clear(?:ed|s|ing)?|fix(?:ed|es|ing)?|complete(?:d|s|ing)?)\b[^.\n]{0,64}\b(?:placeholder(?:s)?|todo|fixme|tbd)\b|\b(?:placeholder(?:s)?|todo|fixme|tbd)\b[^.\n]{0,64}\b(?:resolve(?:d|s|ing)?|replace(?:d|s|ing)?|remove(?:d|s|ing)?|clear(?:ed|s|ing)?|fix(?:ed|es|ing)?|complete(?:d|s|ing)?)\b/i;
const BUILD_SIGNAL_RE =
  /\b(?:build|compile|compiled|compiles|compiling|typecheck|typechecked|lint|linted|install|installed|tsc)\b/i;
const TEST_SIGNAL_RE =
  /\b(?:test|tests|testing|vitest|jest|pytest|mocha|ava|spec|coverage)\b/i;
const BEHAVIOR_SIGNAL_RE =
  /\b(?:integration|e2e|end-to-end|scenario|smoke|playtest|behavior)\b/i;
const SUCCESS_SIGNAL_RE =
  /\b(?:pass(?:ed|es|ing)?|succeed(?:ed|s|ing)?|cleanly|without errors?|exit code:? 0|0 failures?)\b/i;
const RUBRIC_BOILERPLATE_TOKENS = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "state",
  "report",
  "return",
  "provide",
  "confirm",
  "describe",
  "document",
  "indicate",
  "show",
]);

export function validateRuntimeVerificationContract(params: {
  readonly spec?: DelegationContractSpec;
  readonly verificationContract?: WorkflowVerificationContract;
  readonly output: string;
  readonly parsedOutput?: Record<string, unknown>;
  readonly toolCalls?: readonly DelegationValidationToolCall[];
  readonly providerEvidence?: DelegationValidationProviderEvidence;
}): RuntimeVerificationDecision | undefined {
  const contractInput = params.verificationContract ?? params.spec;
  if (!contractInput) {
    return undefined;
  }
  if (
    !params.verificationContract &&
    !hasDelegationRuntimeVerificationContext(params.spec)
  ) {
    return undefined;
  }
  const obligations = deriveVerificationObligations(contractInput);
  if (!obligations || !Array.isArray(params.toolCalls)) {
    return undefined;
  }

  const evidence = collectRuntimeArtifactEvidence({
    toolCalls: params.toolCalls,
    obligations,
  });
  const channels: RuntimeVerificationChannelDecision[] = [];

  const hasGroundedNoop =
    obligations.allowsGroundedNoop &&
    hasGroundedNoopCompletion(params.output, params.parsedOutput);
  const targetArtifacts = obligations.artifactContract.targetArtifacts;
  const targetReadSatisfied =
    targetArtifacts.length === 0 ||
    targetArtifacts.every((artifact) =>
      runtimeEvidenceCoversTargetArtifact(
        artifact,
        evidence.readArtifacts,
        obligations,
      )
    );

  const missingMutationTargets =
    targetArtifacts.length === 0
      ? []
      : targetArtifacts.filter((artifact) =>
        !runtimeEvidenceCoversTargetArtifact(
          artifact,
          evidence.mutatedArtifacts,
          obligations,
        )
      );

  const artifactStateChannel = evaluateArtifactStateChannel({
    obligations,
    evidence,
    hasGroundedNoop,
    targetReadSatisfied,
    missingMutationTargets,
  });
  channels.push(artifactStateChannel);

  channels.push(
    evaluatePlaceholderStubChannel({
      obligations,
      evidence,
      output: params.output,
      parsedOutput: params.parsedOutput,
    }),
  );

  channels.push(
    evaluateExecutableOutcomeChannel({
      obligations,
      evidence,
      output: params.output,
      parsedOutput: params.parsedOutput,
    }),
  );

  channels.push(
    evaluateRubricChannel({
      obligations,
      evidence,
      output: params.output,
      parsedOutput: params.parsedOutput,
    }),
  );

  return resolveRuntimeVerificationDecision({
    channels,
  });
}

function evaluateArtifactStateChannel(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly hasGroundedNoop: boolean;
  readonly targetReadSatisfied: boolean;
  readonly missingMutationTargets: readonly string[];
}): RuntimeVerificationChannelDecision {
  if (
    params.obligations.requiresTargetAuthorization &&
    params.evidence.unauthorizedMutations.length > 0
  ) {
    return verificationChannelFail({
      channel: "artifact_state",
      code: "missing_file_artifact_evidence",
      message:
        "Execution mutated artifacts outside the verification contract: " +
        params.evidence.unauthorizedMutations.slice(0, 3).join(", "),
      evidence: params.evidence.unauthorizedMutations.slice(0, 3),
    });
  }

  if (params.obligations.requiresSourceArtifactReads) {
    const missingSourceArtifacts =
      params.obligations.artifactContract.requiredSourceArtifacts.filter((artifact) =>
        !params.evidence.readArtifacts.has(artifact)
      );
    if (
      missingSourceArtifacts.length > 0 &&
      !(params.hasGroundedNoop && params.targetReadSatisfied)
    ) {
      return verificationChannelFail({
        channel: "artifact_state",
        code: "missing_required_source_evidence",
        message:
          "Execution named source artifacts that were not inspected before completion: " +
          missingSourceArtifacts.slice(0, 3).join(", "),
        evidence: missingSourceArtifacts.slice(0, 3),
      });
    }
  }

  if (
    params.obligations.requiresWorkspaceInspectionEvidence &&
    params.evidence.inspectedWorkspaceArtifacts.size === 0
  ) {
    return verificationChannelFail({
      channel: "artifact_state",
      code: "missing_workspace_inspection_evidence",
      message:
        "Execution required grounded inspection of current workspace state before deriving the updated artifact, but no non-target workspace inspection evidence was observed.",
    });
  }

  if (!params.obligations.requiresMutationEvidence) {
    if (params.hasGroundedNoop && !params.targetReadSatisfied) {
      const unreadTargets = params.obligations.artifactContract.targetArtifacts
        .filter((artifact) => !params.evidence.readArtifacts.has(artifact))
        .slice(0, 3);
      return verificationChannelFail({
        channel: "artifact_state",
        code: "missing_file_mutation_evidence",
        message:
          "No-op completion claimed the target artifacts already satisfied the contract without grounded read evidence: " +
          unreadTargets.join(", "),
        evidence: unreadTargets,
      });
    }
    return verificationChannelPass({
      channel: "artifact_state",
      message: "Artifact grounding and authorization checks passed.",
      evidence: summarizeArtifactEvidence(params.evidence),
    });
  }

  if (
    params.missingMutationTargets.length > 0 &&
    !(params.hasGroundedNoop && params.targetReadSatisfied)
  ) {
    return verificationChannelFail({
      channel: "artifact_state",
      code: "missing_file_mutation_evidence",
      message:
        "Execution required mutation evidence for target artifacts, but runtime evidence did not cover: " +
        params.missingMutationTargets.slice(0, 3).join(", "),
      evidence: params.missingMutationTargets.slice(0, 3),
    });
  }

  return verificationChannelPass({
    channel: "artifact_state",
    message: "Artifact grounding and mutation evidence checks passed.",
    evidence: summarizeArtifactEvidence(params.evidence),
  });
}

function evaluatePlaceholderStubChannel(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly output: string;
  readonly parsedOutput?: Record<string, unknown>;
}): RuntimeVerificationChannelDecision {
  if (params.obligations.placeholderTaxonomy === "scaffold") {
    return verificationChannelPass({
      channel: "placeholder_stub",
      message: "Scaffold placeholders are allowed by the completion contract.",
    });
  }

  const placeholderHits = collectPlaceholderEvidence(params);
  if (params.obligations.placeholderTaxonomy === "repair") {
    const repairDecision = evaluateRepairPlaceholderChannel({
      obligations: params.obligations,
      evidence: params.evidence,
      placeholderHits,
    });
    if (repairDecision) {
      return repairDecision;
    }
  }

  if (placeholderHits.length > 0) {
    const placeholderConfig = getPlaceholderTaxonomyConfig(
      params.obligations.placeholderTaxonomy,
    );
    return verificationChannelFail({
      channel: "placeholder_stub",
      code: "contradictory_completion_claim",
      message:
        `${placeholderConfig.completionLabel} completion was claimed while ${placeholderConfig.unresolvedLabel} remained in authored evidence: ` +
        placeholderHits.slice(0, 3).join("; "),
      evidence: placeholderHits.slice(0, 3),
    });
  }

  return verificationChannelPass({
    channel: "placeholder_stub",
    message: getPlaceholderTaxonomyConfig(params.obligations.placeholderTaxonomy)
      .passMessage,
  });
}

function evaluateRepairPlaceholderChannel(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly placeholderHits: readonly string[];
}): RuntimeVerificationChannelDecision | undefined {
  const placeholderConfig = getPlaceholderTaxonomyConfig(
    params.obligations.placeholderTaxonomy,
  );
  const targetArtifacts = params.obligations.artifactContract.targetArtifacts;
  const baselineTargetReads = targetArtifacts.flatMap((artifact) =>
    params.evidence.readArtifactContents.get(artifact) ?? []
  );
  const baselineContainsPlaceholders =
    baselineTargetReads.some((value) => placeholderConfig.markerRe.test(value));

  if (!baselineContainsPlaceholders) {
    if (params.placeholderHits.length > 0) {
      return verificationChannelFail({
        channel: "placeholder_stub",
        code: "contradictory_completion_claim",
        message:
          `Repair work introduced new ${placeholderConfig.unresolvedLabel} into artifacts that were previously concrete: ` +
          params.placeholderHits.slice(0, 3).join("; "),
        evidence: params.placeholderHits.slice(0, 3),
      });
    }
    return verificationChannelPass({
      channel: "placeholder_stub",
      message:
        "Repair work did not introduce new placeholders into previously concrete artifacts.",
    });
  }

  if (params.placeholderHits.length > 0) {
    return verificationChannelFail({
      channel: "placeholder_stub",
      code: "contradictory_completion_claim",
      message:
        `Repair work preserved unresolved ${placeholderConfig.unresolvedLabel} from the baseline artifacts: ` +
        params.placeholderHits.slice(0, 3).join("; "),
      evidence: params.placeholderHits.slice(0, 3),
    });
  }

  return verificationChannelPass({
    channel: "placeholder_stub",
    message:
      "Repair work resolved previously existing placeholder or stub markers.",
  });
}

function evaluateExecutableOutcomeChannel(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly output: string;
  readonly parsedOutput?: Record<string, unknown>;
}): RuntimeVerificationChannelDecision {
  if (
    !params.obligations.requiresBuildVerification &&
    !params.obligations.requiresBehaviorVerification &&
    !params.obligations.requiresReviewVerification
  ) {
    return verificationChannelPass({
      channel: "executable_outcome",
      message: "No executable outcome checks were required by the completion contract.",
    });
  }

  if (
    params.obligations.requiresBehaviorVerification &&
    !params.evidence.executableAttempts.behavior
  ) {
    return verificationChannelFail({
      channel: "executable_outcome",
      code: "missing_behavior_harness",
      message:
        "Behavior verification was required, but no runnable behavior harness was executed. Prefer existing repo-local tests or scenario commands before claiming completion.",
      evidence: params.evidence.evidenceCorpus.slice(0, 3),
    });
  }

  if (
    params.obligations.requiresBehaviorVerification &&
    !params.evidence.executableOutcomes.behavior
  ) {
    return verificationChannelFail({
      channel: "executable_outcome",
      code: "acceptance_probe_failed",
      message:
        "Behavior verification was required, but no successful behavior-focused executable evidence was recorded.",
      evidence: params.evidence.evidenceCorpus.slice(0, 3),
    });
  }

  if (
    params.obligations.requiresBuildVerification &&
    !params.evidence.executableOutcomes.build &&
    !params.evidence.executableOutcomes.behavior
  ) {
    return verificationChannelFail({
      channel: "executable_outcome",
      code: "acceptance_probe_failed",
      message:
        "Build verification was required, but no successful executable build/test evidence was recorded.",
      evidence: params.evidence.evidenceCorpus.slice(0, 3),
    });
  }

  if (
    params.obligations.requiresReviewVerification &&
    !(
      params.evidence.executableOutcomes.review ||
      params.evidence.readArtifacts.size > 0
    )
  ) {
    return verificationChannelFail({
      channel: "executable_outcome",
      code: "acceptance_evidence_missing",
      message:
        "Review verification was required, but the runtime evidence did not show grounded review-style inspection outcomes.",
      evidence: params.evidence.evidenceCorpus.slice(0, 3),
    });
  }

  return verificationChannelPass({
    channel: "executable_outcome",
    message: "Executable outcome evidence satisfied the completion contract.",
    evidence: params.evidence.evidenceCorpus.slice(0, 3),
  });
}

function evaluateRubricChannel(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly output: string;
  readonly parsedOutput?: Record<string, unknown>;
}): RuntimeVerificationChannelDecision {
  const criteria = params.obligations.acceptanceCriteria;
  if (criteria.length === 0) {
    return verificationChannelPass({
      channel: "rubric",
      message: "No explicit rubric criteria were attached to the verification contract.",
    });
  }

  const evidenceText = [
    params.output,
    ...collectStringValues(params.parsedOutput),
    ...params.evidence.authoredContent,
    ...(params.evidence.authoredContent.length === 0
      ? params.evidence.evidenceCorpus
      : []),
  ]
    .join(" ")
    .toLowerCase();

  const missingCriteria = criteria.filter((criterion) =>
    !rubricCriterionSatisfied(
      criterion,
      evidenceText,
      params.evidence.executableOutcomes,
    )
  );

  if (missingCriteria.length > 0) {
    return verificationChannelFail({
      channel: "rubric",
      code: "acceptance_evidence_missing",
      message:
        "The implementation evidence did not satisfy all grounded rubric criteria: " +
        missingCriteria.slice(0, 3).join(" | "),
      evidence: missingCriteria.slice(0, 3),
    });
  }

  return verificationChannelPass({
    channel: "rubric",
    message: "Grounded rubric criteria were satisfied by the recorded evidence.",
    evidence: criteria.slice(0, 3),
  });
}

function runtimeEvidenceCoversTargetArtifact(
  artifact: string,
  observedArtifacts: ReadonlySet<string>,
  obligations: VerificationObligations,
): boolean {
  if (observedArtifacts.has(artifact)) {
    return true;
  }
  if (
    obligations.artifactContract.targetDirectoryScopes.includes(artifact) &&
    [...observedArtifacts].some((path) => isPathWithinRoot(path, artifact))
  ) {
    return true;
  }
  return false;
}

function collectRuntimeArtifactEvidence(params: {
  readonly toolCalls: readonly DelegationValidationToolCall[];
  readonly obligations: VerificationObligations;
}): RuntimeArtifactEvidence {
  const readArtifacts = new Set<string>();
  const readArtifactContents = new Map<string, string[]>();
  const inspectedWorkspaceArtifacts = new Set<string>();
  const mutatedArtifacts = new Set<string>();
  const unauthorizedMutations = new Set<string>();
  const authoredContent: string[] = [];
  const evidenceCorpus: string[] = [];
  let successfulBuild = false;
  let successfulBehavior = false;
  let successfulReview = false;
  let attemptedBuild = false;
  let attemptedBehavior = false;
  let attemptedReview = false;
  let repoLocalBehaviorHarness = false;
  let generatedBehaviorHarness = false;
  let successfulToolCalls = 0;

  for (const toolCall of params.toolCalls) {
    const verificationMetadata = parseEncodedVerificationMetadata(toolCall.result);
    const executableAttempt = classifyExecutableAttempt(
      toolCall,
      verificationMetadata,
    );
    attemptedBuild ||= executableAttempt.build;
    attemptedBehavior ||= executableAttempt.behavior;
    attemptedReview ||= executableAttempt.review;
    repoLocalBehaviorHarness ||=
      executableAttempt.behavior && verificationMetadata?.repoLocal === true;
    generatedBehaviorHarness ||= verificationMetadata?.generatedHarness === true;

    if (!isSuccessfulToolCall(toolCall)) {
      continue;
    }
    successfulToolCalls += 1;
    evidenceCorpus.push(...collectToolCallEvidenceStrings(toolCall));
    const directPaths = collectDirectArtifactPaths(toolCall, params.obligations.workspaceRoot);
    if (
      isMeaningfulWorkspaceInspectionToolCall({
        toolCall,
        workspaceRoot: params.obligations.workspaceRoot,
        targetArtifacts: params.obligations.artifactContract.targetArtifacts,
        requiredSourceArtifacts:
          params.obligations.artifactContract.requiredSourceArtifacts,
      })
    ) {
      for (const path of collectInspectionArtifactPaths(
        toolCall,
        params.obligations.workspaceRoot,
      )) {
        inspectedWorkspaceArtifacts.add(path);
      }
    }
    if (READ_FILE_TOOL_NAMES.has(toolCall.name?.trim() ?? "")) {
      for (const path of directPaths) {
        readArtifacts.add(path);
        const contents = extractReadArtifactContents(toolCall);
        if (contents.length > 0) {
          const existing = readArtifactContents.get(path) ?? [];
          readArtifactContents.set(path, [...existing, ...contents]);
        }
      }
    }

    if (DIRECT_MUTATION_TOOL_NAMES.has(toolCall.name?.trim() ?? "")) {
      for (const path of directPaths) {
        mutatedArtifacts.add(path);
        if (isLikelyGeneratedBehaviorHarnessPath(path)) {
          generatedBehaviorHarness = true;
        }
        if (
          params.obligations.requiresTargetAuthorization &&
          !isArtifactAccessAllowed({
            contract: params.obligations.artifactContract,
            path,
            mode: "write",
          })
        ) {
          unauthorizedMutations.add(path);
        }
      }
      authoredContent.push(...collectAuthoredContent(toolCall));
    }

    const executableSignals = classifyExecutableOutcome(toolCall);
    successfulBuild ||= executableSignals.build;
    successfulBehavior ||= executableSignals.behavior;
    successfulReview ||= executableSignals.review;

    if (!SHELL_TOOL_NAMES.has(toolCall.name?.trim() ?? "")) {
      continue;
    }

    const effectMetadata = parseEncodedEffectMetadata(toolCall.result);
    if (!effectMetadata || effectMetadata.status !== "succeeded") {
      continue;
    }
    for (const path of collectShellMutationPaths(effectMetadata)) {
      mutatedArtifacts.add(path);
      if (
        params.obligations.requiresTargetAuthorization &&
        !isArtifactAccessAllowed({
          contract: params.obligations.artifactContract,
          path,
          mode: "write",
        })
      ) {
        unauthorizedMutations.add(path);
      }
    }
    authoredContent.push(...collectAuthoredContent(toolCall));
  }

  return {
    readArtifacts,
    readArtifactContents,
    inspectedWorkspaceArtifacts,
    mutatedArtifacts,
    unauthorizedMutations: [...unauthorizedMutations],
    successfulToolCalls,
    authoredContent,
    evidenceCorpus,
    executableOutcomes: {
      build: successfulBuild,
      behavior: successfulBehavior,
      review: successfulReview,
    },
    executableAttempts: {
      build: attemptedBuild,
      behavior: attemptedBehavior,
      review: attemptedReview,
    },
    repoLocalBehaviorHarness,
    generatedBehaviorHarness,
  };
}

function extractReadArtifactContents(
  toolCall: DelegationValidationToolCall,
): readonly string[] {
  const parsed = parseResultObject(toolCall.result);
  const contents: string[] = [];
  const directContent = parsed?.content;
  if (typeof directContent === "string" && directContent.trim().length > 0) {
    contents.push(directContent);
  }
  return contents;
}

function collectDirectArtifactPaths(
  toolCall: DelegationValidationToolCall,
  workspaceRoot?: string,
): readonly string[] {
  const toolName = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  const args =
    toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
      ? (toolCall.args as Record<string, unknown>)
      : {};
  const parsedResult = parseResultObject(toolCall.result);
  const candidates: string[] = [];

  if (toolName === "system.move") {
    pushPathCandidate(candidates, args.source, workspaceRoot);
    pushPathCandidate(candidates, args.destination, workspaceRoot);
  } else {
    pushPathCandidate(candidates, args.path, workspaceRoot);
    pushPathCandidate(candidates, parsedResult?.path, workspaceRoot);
  }

  return [...new Set(candidates)];
}

function collectInspectionArtifactPaths(
  toolCall: DelegationValidationToolCall,
  workspaceRoot?: string,
): readonly string[] {
  const toolName = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  if (
    !WORKSPACE_INSPECTION_TOOL_NAMES.has(toolName) &&
    !SHELL_TOOL_NAMES.has(toolName)
  ) {
    return [];
  }
  return collectWorkspaceInspectionPathCandidates({
    toolCall,
    workspaceRoot,
  });
}

function collectAuthoredContent(
  toolCall: DelegationValidationToolCall,
): readonly string[] {
  const args =
    toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
      ? (toolCall.args as Record<string, unknown>)
      : {};
  const raw: string[] = [];
  for (const key of ["content", "text", "patch", "diff"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      raw.push(value);
    }
  }
  if (typeof args.command === "string" && args.command.trim().length > 0) {
    raw.push(args.command);
  }
  if (Array.isArray(args.args)) {
    for (const entry of args.args) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        raw.push(entry);
      }
    }
  }
  return raw;
}

function collectToolCallEvidenceStrings(
  toolCall: DelegationValidationToolCall,
): readonly string[] {
  const values: string[] = [];
  values.push(...collectAuthoredContent(toolCall));
  values.push(...collectStringValues(toolCall.result));
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function classifyExecutableOutcome(
  toolCall: DelegationValidationToolCall,
): {
  readonly build: boolean;
  readonly behavior: boolean;
  readonly review: boolean;
} {
  const combined = collectToolCallEvidenceStrings(toolCall).join(" ");
  const parsedResult = parseResultObject(toolCall.result);
  if (combined.trim().length === 0 && !parsedResult) {
    return { build: false, behavior: false, review: false };
  }
  const lower = combined.toLowerCase();
  const succeeded =
    SUCCESS_SIGNAL_RE.test(lower) ||
    parsedResult?.ok === true ||
    parsedResult?.success === true ||
    (
      typeof parsedResult?.exitCode === "number" &&
      parsedResult.exitCode === 0
    );
  const build = BUILD_SIGNAL_RE.test(lower) && succeeded;
  const behavior =
    (BEHAVIOR_SIGNAL_RE.test(lower) || TEST_SIGNAL_RE.test(lower)) &&
    succeeded;
  const review =
    /(review|audit|inspect|analy[sz]e|assess|evaluate|finding|risk)/i.test(lower);
  return { build, behavior, review };
}

function classifyExecutableAttempt(
  toolCall: DelegationValidationToolCall,
  verificationMetadata?: EncodedVerificationMetadata,
): {
  readonly build: boolean;
  readonly behavior: boolean;
  readonly review: boolean;
} {
  const category = verificationMetadata?.category;
  if (category) {
    return {
      build: category === "build",
      behavior: category === "behavior",
      review: category === "review",
    };
  }
  const combined = collectToolCallEvidenceStrings(toolCall).join(" ");
  if (combined.trim().length === 0) {
    return { build: false, behavior: false, review: false };
  }
  const lower = combined.toLowerCase();
  return {
    build: BUILD_SIGNAL_RE.test(lower),
    behavior: BEHAVIOR_SIGNAL_RE.test(lower) || TEST_SIGNAL_RE.test(lower),
    review:
      /(review|audit|inspect|analy[sz]e|assess|evaluate|finding|risk)/i.test(
        lower,
      ),
  };
}

function collectPlaceholderEvidence(params: {
  readonly obligations: VerificationObligations;
  readonly evidence: RuntimeArtifactEvidence;
  readonly output: string;
  readonly parsedOutput?: Record<string, unknown>;
}): readonly string[] {
  const placeholderConfig = getPlaceholderTaxonomyConfig(
    params.obligations.placeholderTaxonomy,
  );
  const rawValues = [
    ...(params.obligations.placeholderTaxonomy === "documentation"
      ? []
      : [params.output]),
    ...collectStringValues(params.parsedOutput).filter((value) =>
      !(
        params.obligations.placeholderTaxonomy === "documentation" &&
        isLikelyFilesystemPathValue(value)
      )
    ),
    ...params.evidence.authoredContent,
  ];
  const matches: string[] = [];
  for (const value of rawValues) {
    const trimmed = value.trim();
    if (!trimmed || !placeholderConfig.markerRe.test(trimmed)) {
      continue;
    }
    if (
      /placeholder(?:s)? (?:allowed|accepted|permitted)|scaffold(?:ing)? placeholder/i
        .test(trimmed)
    ) {
      continue;
    }
    if (placeholderConfig.resolvedCueRe.test(trimmed)) {
      continue;
    }
    matches.push(trimmed.slice(0, 160));
  }
  return [...new Set(matches)];
}

function isLikelyFilesystemPathValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return false;
  }
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    /^(?:[^\\/]+[\\/])+[^\\/]+$/.test(trimmed) ||
    /^[^\\/]+\.[a-z0-9]+$/i.test(trimmed)
  );
}

function getPlaceholderTaxonomyConfig(
  taxonomy: PlaceholderTaxonomy,
): {
  readonly markerRe: RegExp;
  readonly resolvedCueRe: RegExp;
  readonly completionLabel: string;
  readonly unresolvedLabel: string;
  readonly passMessage: string;
} {
  if (taxonomy === "documentation") {
    return {
      markerRe: DOCUMENTATION_PLACEHOLDER_MARKER_RE,
      resolvedCueRe: DOCUMENTATION_RESOLVED_PLACEHOLDER_CUE_RE,
      completionLabel: "Documentation",
      unresolvedLabel: "shorthand placeholders or TODO markers",
      passMessage:
        "No unresolved shorthand placeholders or TODO markers were found in authored documentation evidence.",
    };
  }
  return {
    markerRe: IMPLEMENTATION_PLACEHOLDER_MARKER_RE,
    resolvedCueRe: IMPLEMENTATION_RESOLVED_PLACEHOLDER_CUE_RE,
    completionLabel: "Implementation",
    unresolvedLabel: "placeholder or stub markers",
    passMessage:
      "No unresolved placeholder or stub markers were found in authored evidence.",
  };
}

function rubricCriterionSatisfied(
  criterion: string,
  evidenceText: string,
  executableOutcomes: RuntimeArtifactEvidence["executableOutcomes"],
): boolean {
  const categories = getAcceptanceVerificationCategories(criterion);
  if (categories.includes("build") && !executableOutcomes.build) {
    return false;
  }
  if (categories.includes("test") && !executableOutcomes.behavior) {
    return false;
  }

  const tokens = extractDelegationTokens(criterion).filter((token) =>
    token !== "implementation" &&
    token !== "artifacts" &&
    token !== "artifact" &&
    !RUBRIC_BOILERPLATE_TOKENS.has(token)
  );
  if (tokens.length === 0) {
    return true;
  }
  const matched = tokens.filter((token) => evidenceText.includes(token));
  const minimumMatches =
    tokens.length >= 4 ? 2 : 1;
  return matched.length >= minimumMatches;
}

function summarizeArtifactEvidence(
  evidence: RuntimeArtifactEvidence,
): readonly string[] {
  return [
    ...[...evidence.readArtifacts].slice(0, 2),
    ...[...evidence.inspectedWorkspaceArtifacts].slice(0, 2),
    ...[...evidence.mutatedArtifacts].slice(0, 2),
  ];
}

function collectShellMutationPaths(
  effectMetadata: EncodedEffectMetadata,
): readonly string[] {
  const changedPaths = new Set<string>();
  const preSnapshots = new Map<string, EncodedEffectSnapshot>();

  for (const snapshot of effectMetadata.preExecutionSnapshots ?? []) {
    if (typeof snapshot.path === "string" && snapshot.path.trim().length > 0) {
      preSnapshots.set(snapshot.path, snapshot);
    }
  }

  for (const snapshot of effectMetadata.postExecutionSnapshots ?? []) {
    const path = typeof snapshot.path === "string" ? snapshot.path.trim() : "";
    if (path.length === 0) {
      continue;
    }
    const before = preSnapshots.get(path);
    if (didSnapshotChange(before, snapshot)) {
      changedPaths.add(path);
    }
  }

  if (changedPaths.size > 0) {
    return [...changedPaths];
  }

  for (const target of effectMetadata.targets ?? []) {
    const path = typeof target.path === "string" ? target.path.trim() : "";
    if (path.length > 0) {
      changedPaths.add(path);
    }
  }
  return [...changedPaths];
}

function didSnapshotChange(
  before: EncodedEffectSnapshot | undefined,
  after: EncodedEffectSnapshot,
): boolean {
  if (!before) {
    return after.exists === true || typeof after.sha256 === "string";
  }
  return (
    before.exists !== after.exists ||
    before.entryType !== after.entryType ||
    before.sha256 !== after.sha256 ||
    before.sizeBytes !== after.sizeBytes
  );
}

function isSuccessfulToolCall(toolCall: DelegationValidationToolCall): boolean {
  if (toolCall.isError === true) {
    return false;
  }
  const parsedResult = parseResultObject(toolCall.result);
  if (!parsedResult) {
    return true;
  }
  if (parsedResult.error) {
    return false;
  }
  if (parsedResult.exitCode && typeof parsedResult.exitCode === "number") {
    return parsedResult.exitCode === 0;
  }
  if (parsedResult.timedOut === true) {
    return false;
  }
  return true;
}

function hasGroundedNoopCompletion(
  output: string,
  parsedOutput?: Record<string, unknown>,
): boolean {
  const values = [
    output,
    ...collectStringValues(parsedOutput),
  ].map((value) => value.trim()).filter((value) => value.length > 0);
  return values.some((value) => NOOP_COMPLETION_RE.test(value));
}

function collectStringValues(
  value: unknown,
  sink: string[] = [],
): readonly string[] {
  if (typeof value === "string") {
    sink.push(value);
    return sink;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, sink);
    }
    return sink;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringValues(entry, sink);
    }
  }
  return sink;
}

function parseEncodedEffectMetadata(
  result: string | undefined,
): EncodedEffectMetadata | undefined {
  const parsed = parseResultObject(result);
  const raw = parsed?.__agencEffect;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as EncodedEffectMetadata;
}

function parseEncodedVerificationMetadata(
  result: string | undefined,
): EncodedVerificationMetadata | undefined {
  const parsed = parseResultObject(result);
  const raw = parsed?.__agencVerification;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as EncodedVerificationMetadata;
}

function parseResultObject(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pushPathCandidate(
  sink: string[],
  rawPath: unknown,
  workspaceRoot?: string,
): void {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return;
  }
  sink.push(normalizeEnvelopePath(rawPath, workspaceRoot));
}

function isLikelyGeneratedBehaviorHarnessPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
    .test(path);
}
