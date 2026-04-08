/**
 * Shared delegation result-contract and file-evidence validation helpers.
 *
 * Used by direct delegation, planner orchestration, verifier checks, and
 * final-response reconciliation to keep enforcement logic aligned.
 *
 * @module
 */

import type { DelegationExecutionContext } from "./delegation-execution-context.js";
import {
  PROVIDER_NATIVE_FILE_SEARCH_TOOL,
  PROVIDER_NATIVE_RESEARCH_TOOL_NAMES,
  PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  PROVIDER_NATIVE_X_SEARCH_TOOL,
  isProviderNativeToolName,
  isResearchLikeText,
} from "../llm/provider-native-search.js";
import {
  DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES,
  DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES,
  LOW_SIGNAL_BROWSER_TOOL_NAMES,
  PREFERRED_RESEARCH_BROWSER_TOOL_NAMES,
  PREFERRED_VALIDATION_BROWSER_TOOL_NAMES,
} from "./browser-tool-taxonomy.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import { textRequiresWorkspaceGroundedArtifactUpdate } from "../workflow/workspace-inspection-evidence.js";

export interface DelegationContractSpec {
  readonly task?: string;
  readonly objective?: string;
  readonly parentRequest?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  /**
   * Explicit tool requirements that are part of the delegated contract itself.
   *
   * Do not stuff policy-scoped allowlists into this field. Ambient child tool
   * availability is execution context, not contract semantics, and conflating
   * the two causes false validation requirements.
   */
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
  readonly contextRequirements?: readonly string[];
  readonly executionContext?: DelegationExecutionContext;
  readonly delegationShape?: string;
  readonly isolationReason?: string;
  readonly ownedArtifacts?: readonly string[];
  readonly verifierObligations?: readonly string[];
  readonly inheritedEvidence?: {
    readonly workspaceInspectionSatisfied?: boolean;
    readonly sourceSteps?: readonly string[];
  };
  readonly lastValidationCode?: DelegationOutputValidationCode;
  readonly toolContract?: DelegatedToolContractResolution;
}

export const DELEGATION_OUTPUT_VALIDATION_CODES = [
  "empty_output",
  "empty_structured_payload",
  "expected_json_object",
  "acceptance_count_mismatch",
  "acceptance_evidence_missing",
  "acceptance_probe_failed",
  "missing_behavior_harness",
  "forbidden_phase_action",
  "blocked_phase_output",
  "contradictory_completion_claim",
  "missing_successful_tool_evidence",
  "low_signal_browser_evidence",
  "missing_workspace_inspection_evidence",
  "missing_file_mutation_evidence",
  "missing_required_source_evidence",
  "missing_file_artifact_evidence",
] as const;

export type DelegationOutputValidationCode =
  typeof DELEGATION_OUTPUT_VALIDATION_CODES[number];

interface DelegatedChildToolAllowlistRefinement {
  readonly allowedTools: readonly string[];
  readonly removedLowSignalBrowserTools: readonly string[];
  readonly blockedReason?: string;
}

type DelegatedToolContractState = "exact" | "enriched" | "degraded";

interface DelegatedToolContractResolution {
  readonly state: DelegatedToolContractState;
  readonly requestedSource: readonly string[];
  readonly requestedConcreteTools: readonly string[];
  readonly requestedSemanticCapabilities: readonly string[];
  readonly resolvedTools: readonly string[];
  readonly missingRequestedTools: readonly string[];
  readonly optionalEnrichment: readonly string[];
  readonly requiredSubstitution: readonly string[];
}

interface ResolvedDelegatedChildToolScope
  extends DelegatedChildToolAllowlistRefinement {
  readonly semanticFallback: readonly string[];
  readonly removedByPolicy: readonly string[];
  readonly removedAsDelegationTools: readonly string[];
  readonly removedAsUnknownTools: readonly string[];
  readonly allowsToollessExecution: boolean;
  readonly toolContract: DelegatedToolContractResolution;
}

const DELEGATION_FILE_ACTION_RE =
  /\b(create|write|edit|save|scaffold|implement(?:ation)?|generate|modify|patch|update|add|build)\b/i;
const DELEGATION_FILE_TARGET_RE =
  /\b(?:file|files|readme(?:\.md)?|docs?|documentation|markdown|index\.html|package\.json|tsconfig(?:\.json)?|vite\.config(?:\.[a-z]+)?|src\/|dist\/|docs\/|demos?\/|tests?\/|__tests__\/|specs?\/|[a-z0-9_.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|rs|go))(?=$|[\s,.;:!?)]|`|'|")/i;
const DELEGATION_CODE_TARGET_RE =
  /\b(?:game loop|rendering|movement|collision|scoring|score|hud|player|enemy|powerup|pathfinding|save\/load|settings|input|audio|map mutation|system|feature|module|component|class|function|logic|scene|entity|entities)\b/i;
const EXPLICIT_FILE_ARTIFACT_GLOBAL_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]*?\.[a-z0-9]{1,10}|\.{1,2}\/[^\s`'"]*?\.[a-z0-9]{1,10}|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.[a-z0-9]{1,10}|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/gi;
const LOCAL_FILE_REFERENCE_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|\.{1,2}\/[^\s`'"]+|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+|(?:ag(?:ent)?s|readme)\.md|[a-z0-9_.-]+\.(?:md|txt|json|js|jsx|ts|tsx|py|rs|go|toml|ya?ml|html?|css))(?=$|[\s`'"])/i;
const EXPLICIT_BROWSER_ENVIRONMENT_CUE_RE =
  /\b(?:localhost|127\.0\.0\.1|about:blank|browser(?:-grounded)?|playwright|mcp\.browser|chromium|playtest|url|website|web\s+site|webpage|web\s+page)\b/i;
const BROWSER_ACTION_CUE_RE =
  /\b(?:navigate(?:\s+(?:to|the\s+(?:browser|page|site)|page|site|url))|click(?:\s+(?:the\s+)?(?:page|button|link|tab|selector|element))|hover(?:\s+(?:over|on)\s+(?:the\s+)?(?:page|button|link|selector|element))|scroll(?:\s+(?:the\s+)?(?:page|browser|viewport))|fill(?:\s+(?:the\s+)?(?:form|input|field))|select(?:\s+(?:the\s+)?(?:option|dropdown))|console\s+errors?|network\s+requests?)\b/i;
const BROWSER_SNAPSHOT_CUE_RE =
  /\b(?:(?:browser|page|website|web\s+site|webpage|web\s+page|ui|visual)\s+snapshot|snapshot\s+(?:of|for)\s+(?:the\s+)?(?:browser|page|website|web\s+site|webpage|web\s+page|ui|visual)|mcp\.browser\.browser_snapshot|playwright\.browser_snapshot)\b/i;
const NEGATED_BROWSER_REQUIREMENT_RE =
  /\b(?:no|non|without|avoid(?:ing)?|exclude(?:d|ing)?)\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const DO_NOT_USE_BROWSER_RE =
  /\bdo\s+not\s+use\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const ONLY_NON_BROWSER_TOOLS_RE = /\bonly\s+non-browser\s+tools?\b/gi;
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i;
const TOOL_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|mcp\.browser|playwright|verify|validated?|devlog|gameplay|localhost|console errors?|research|compare|reference|references|citation|framework|document(?:ation)?s?)\b/i;
const BROWSER_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|browser-grounded|mcp\.browser|playwright|chromium|localhost|website|web\s+site|webpage|web\s+page|url|navigate|research|compare|citation|framework|document(?:ation)?s?|validate|validation|playtest|qa|end-to-end|e2e)\b/i;
const NON_BLANK_BROWSER_TARGET_RE =
  /\b(?:https?:\/\/|file:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)\S*/i;
const DOCUMENTATION_TASK_RE =
  /\b(?:readme|documentation|how[-\s]?to[-\s]?play|architecture summary|architecture docs?|playbook|writeup|guide)\b/i;
const REVIEW_FINDINGS_TASK_RE =
  /\b(?:review|critique|audit|inspect|analy[sz]e|assess|evaluate)\b/i;
const REVIEW_FINDINGS_OUTPUT_RE =
  /\b(?:gap|gaps|missing|issue|issues|risk|risks|problem|problems|weakness|weaknesses|addition|additions|improvement|improvements|feedback|findings?)\b/i;
const IMPLEMENTATION_TASK_RE =
  /\b(?:implement|implementation|build|scaffold|create|edit|code|render|rendering|collision|score|hud|player|enemy|powerup|pathfinding|save\/load|settings|input|polish|ux|audio|movement|dash|map mutation)\b/i;
const VALIDATION_STRONG_TASK_RE =
  /\b(?:validate|validation|verify|verified|playtest|qa|end-to-end|e2e|test|tests|smoke test|acceptance test|build checks?)\b/i;
const VALIDATION_WEAK_TASK_RE = /\b(?:browser|chromium|localhost)\b/i;
  /\b(?:no|without|do not|don't|never|must not|should not)\b/i;
const SETUP_TASK_RE =
  /\b(?:scaffold|bootstrap|setup|initialize|initialise|npm\s+(?:create|init|install)|pnpm\s+(?:create|init|install|add)|yarn\s+(?:create|install|add)|bun\s+create|cargo\s+(?:new|init)|git\s+clone|npx\s+[a-z0-9_.@/-]*create[a-z0-9_.@/-]*)\b/i;
const TEST_ARTIFACT_TARGET_RE =
  /\b(?:vitest|jest|mocha|ava|tap|tests?\/|__tests__\/|spec(?:s)?\/|[a-z0-9_.-]+\.test\.[a-z0-9]+|[a-z0-9_.-]+\.spec\.[a-z0-9]+)(?=$|[\s,.;:!?)]|`|'|")/i;
const EXPLICIT_FILE_MUTATION_TOOL_NAMES = new Set([
  "system.writeFile",
  "system.appendFile",
  "system.mkdir",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const LOCAL_FILE_INSPECTION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.readFile",
  "system.listDir",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PROVIDER_NATIVE_RESEARCH_TOOL_NAMES,
]);
const PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.writeFile",
  "system.appendFile",
]);
const FALLBACK_IMPLEMENTATION_EDITOR_TOOL_NAMES = new Set([
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES = new Set([
  "desktop.bash",
  "system.bash",
]);
const VERIFICATION_EXECUTION_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
  "system.processStart",
  "system.processStatus",
  "system.sandboxJobStart",
  "system.sandboxJobResume",
  "system.sandboxJobLogs",
]);
const CONTEXT_ONLY_CAPABILITY_RE =
  /\b(?:context|history|memory|conversation|recall|retrieve|retrieval|prior|previous)\b/i;
const FILE_READ_CAPABILITY_RE =
  /\b(?:file\s*read|read\s*file|file\s*inspect(?:ion)?|inspect(?:ion)?|list\s*(?:dir|directory)|directory\s*listing)\b/i;
const FILE_WRITE_CAPABILITY_RE =
  /\b(?:file\s*system\s*write|file\s*write|write\s*file|file\s*mutation|code\s*generation|edit\s*file|create\s*file)\b/i;
const SHELL_EXECUTION_CAPABILITY_RE =
  /\b(?:bash|shell|command\s*execution|run\s*command|workspace|process)\b/i;

function normalizeToolNames(toolNames: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (toolNames ?? [])
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  ];
}

function normalizeCapabilityName(value: string): string {
  return value.trim().replace(/[_-]+/g, " ").toLowerCase();
}

function isGenericFilesystemCapabilityName(capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  return normalized === "filesystem" || normalized === "file system";
}

function looksLikeExplicitDelegatedToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (/\s/.test(normalized)) return false;
  return normalized === "execute_with_agent" ||
    isProviderNativeToolName(normalized) ||
    normalized.includes(".") ||
    normalized.startsWith("browser") ||
    normalized.startsWith("playwright") ||
    normalized.startsWith("desktop") ||
    normalized.startsWith("system") ||
    normalized.startsWith("mcp");
}

function isContextOnlyCapabilityName(capability: string): boolean {
  if (looksLikeExplicitDelegatedToolName(capability)) return false;
  const normalized = capability.trim().replace(/[_-]+/g, " ");
  return CONTEXT_ONLY_CAPABILITY_RE.test(normalized);
}

function extractExplicitDelegatedToolNames(
  toolNames: readonly string[] | undefined,
): string[] {
  return normalizeToolNames(toolNames).filter(looksLikeExplicitDelegatedToolName);
}

function getDelegatedCapabilityProfile(spec: DelegationContractSpec): {
  readonly hasConstraints: boolean;
  readonly hasFileWrite: boolean;
  readonly hasShellExecution: boolean;
  readonly hasBrowserInteraction: boolean;
  readonly hasRecognizedConstraint: boolean;
  readonly isReadOnlyContract: boolean;
} {
  const requestedSource = normalizeToolNames([
    ...(spec.requiredToolCapabilities ?? []),
    ...(spec.tools ?? []),
  ]);
  const explicitTools = extractExplicitDelegatedToolNames(requestedSource);
  const semanticCapabilities = requestedSource
    .filter((toolName) => !looksLikeExplicitDelegatedToolName(toolName))
    .map((capability) => normalizeCapabilityName(capability));
  const hasFileWrite = explicitTools.some((toolName) =>
    EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName)
  ) ||
    semanticCapabilities.some((capability) =>
      FILE_WRITE_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    );
  const hasShellExecution = explicitTools.some((toolName) =>
    PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName) ||
    VERIFICATION_EXECUTION_TOOL_NAMES.has(toolName)
  ) ||
    semanticCapabilities.some((capability) =>
      SHELL_EXECUTION_CAPABILITY_RE.test(capability)
    );
  const hasBrowserInteraction = explicitTools.some((toolName) =>
    isBrowserToolName(toolName)
  );
  const hasRecognizedSemanticConstraint = semanticCapabilities.some((capability) =>
    isContextOnlyCapabilityName(capability) ||
    FILE_READ_CAPABILITY_RE.test(capability) ||
    FILE_WRITE_CAPABILITY_RE.test(capability) ||
    SHELL_EXECUTION_CAPABILITY_RE.test(capability) ||
    isGenericFilesystemCapabilityName(capability)
  );
  const hasRecognizedConstraint =
    explicitTools.length > 0 ||
    hasRecognizedSemanticConstraint;

  return {
    hasConstraints: requestedSource.length > 0,
    hasFileWrite,
    hasShellExecution,
    hasBrowserInteraction,
    hasRecognizedConstraint,
    isReadOnlyContract:
      requestedSource.length > 0 &&
      hasRecognizedConstraint &&
      !hasFileWrite &&
      !hasShellExecution &&
      !hasBrowserInteraction,
  };
}

function collectDelegationStepText(
  spec: DelegationContractSpec,
  options: {
    readonly includeParentRequest?: boolean;
  } = {},
): string {
  return [
    ...(options.includeParentRequest ? [spec.parentRequest] : []),
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
    ...(spec.requiredToolCapabilities ?? []),
    ...(spec.tools ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function collectDelegationContextText(spec: DelegationContractSpec): string {
  return [spec.parentRequest]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function collectDelegationPrimaryText(spec: DelegationContractSpec): string {
  return [spec.task, spec.objective]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function hasReviewFindingsIntent(spec: DelegationContractSpec): boolean {
  const text = normalizeDelegationClassifierText(collectDelegationStepText(spec));
  if (text.length === 0) {
    return false;
  }
  return REVIEW_FINDINGS_TASK_RE.test(text) && REVIEW_FINDINGS_OUTPUT_RE.test(text);
}

function normalizeDelegationClassifierText(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function countPatternMatches(value: string, pattern: RegExp): number {
  if (value.length === 0) return 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return value.match(matcher)?.length ?? 0;
}

function stripNegativeBrowserLanguage(value: string): string {
  return value
    .replace(NEGATED_BROWSER_REQUIREMENT_RE, " ")
    .replace(DO_NOT_USE_BROWSER_RE, " ")
    .replace(ONLY_NON_BROWSER_TOOLS_RE, " ");
}

function hasPositiveBrowserGroundingCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  const normalized = stripNegativeBrowserLanguage(value);
  return BROWSER_GROUNDED_TASK_RE.test(normalized) ||
    BROWSER_SNAPSHOT_CUE_RE.test(normalized);
}

function hasExplicitBrowserInteractionCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  const normalized = stripNegativeBrowserLanguage(value);
  return EXPLICIT_BROWSER_ENVIRONMENT_CUE_RE.test(normalized) ||
    BROWSER_ACTION_CUE_RE.test(normalized) ||
    BROWSER_SNAPSHOT_CUE_RE.test(normalized);
}

function classifyDelegatedTaskIntent(
  spec: DelegationContractSpec,
): "research" | "implementation" | "validation" | "documentation" | "other" {
  const primary = normalizeDelegationClassifierText(
    collectDelegationPrimaryText(spec),
  );
  const combined = primary.length > 0
    ? primary
    : normalizeDelegationClassifierText(collectDelegationStepText(spec));
  const fullStepText = normalizeDelegationClassifierText(
    collectDelegationStepText(spec),
  );
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const hasFileAction = DELEGATION_FILE_ACTION_RE.test(fullStepText);
  const hasExplicitFileTarget = DELEGATION_FILE_TARGET_RE.test(fullStepText);
  const hasCodeTarget = DELEGATION_CODE_TARGET_RE.test(primary);
  const hasStrongImplementationCue =
    !capabilityProfile.isReadOnlyContract &&
    (
      IMPLEMENTATION_TASK_RE.test(combined) ||
      (hasFileAction &&
        (hasExplicitFileTarget || hasCodeTarget || primary.trim().length > 0)) ||
      isSetupHeavyDelegatedTask(spec)
    );
  const hasFileWriteCapability =
    capabilityProfile.hasFileWrite;
  const hasStrongValidationCue = VALIDATION_STRONG_TASK_RE.test(combined);
  const hasWeakValidationCue = VALIDATION_WEAK_TASK_RE.test(combined);
  const hasDocumentationCue = DOCUMENTATION_TASK_RE.test(combined);
  const scores = {
    research: isResearchLikeText(combined) ? 4 : 0,
    implementation: 0,
    validation: 0,
    documentation: hasDocumentationCue ? 8 : 0,
  };

  scores.implementation += countPatternMatches(combined, IMPLEMENTATION_TASK_RE) * 2;
  if (hasStrongImplementationCue) {
    scores.implementation += 3;
  }
  if (hasFileWriteCapability) {
    scores.implementation += 4;
  }
  if (hasStrongValidationCue) {
    scores.validation += countPatternMatches(combined, VALIDATION_STRONG_TASK_RE) * 2 + 2;
  }
  if (
    hasWeakValidationCue &&
    !hasFileWriteCapability &&
    !hasStrongImplementationCue &&
    !hasDocumentationCue
  ) {
    scores.validation += countPatternMatches(combined, VALIDATION_WEAK_TASK_RE);
  }

  if (scores.research > 0 && (hasFileWriteCapability || hasStrongImplementationCue)) {
    scores.research = Math.max(0, scores.research - 4);
  }
  if (scores.validation > 0 && (hasFileWriteCapability || hasStrongImplementationCue)) {
    scores.validation = Math.max(0, scores.validation - 3);
  }

  const ordered: Array<{
    intent: "research" | "implementation" | "validation" | "documentation";
    score: number;
  }> = [
    { intent: "implementation", score: scores.implementation },
    { intent: "validation", score: scores.validation },
    { intent: "documentation", score: scores.documentation },
    { intent: "research", score: scores.research },
  ];
  const winner = ordered.reduce((best, current) =>
    current.score > best.score ? current : best
  );
  if (winner.score > 0) {
    return winner.intent;
  }
  if (hasStrongValidationCue || hasWeakValidationCue) return "validation";
  if (hasDocumentationCue) return "documentation";
  if (hasStrongImplementationCue) return "implementation";
  if (isResearchLikeText(combined)) return "research";
  return "other";
}

function isSetupHeavyDelegatedTask(spec: DelegationContractSpec): boolean {
  return SETUP_TASK_RE.test(
    normalizeDelegationClassifierText(collectDelegationStepText(spec)),
  );
}

function isBrowserToolName(toolName: string): boolean {
  return toolName.startsWith("mcp.browser.") ||
    toolName.startsWith("playwright.");
}

function isHostBrowserToolName(toolName: string): boolean {
  return toolName === "system.browse" ||
    toolName === "system.browserAction" ||
    toolName.startsWith("system.browserSession");
}

function specTargetsLocalFiles(spec: DelegationContractSpec): boolean {
  if (
    (spec.executionContext?.requiredSourceArtifacts?.length ?? 0) > 0 ||
    (spec.executionContext?.inputArtifacts?.length ?? 0) > 0 ||
    (spec.executionContext?.targetArtifacts?.length ?? 0) > 0
  ) {
    return true;
  }
  const combined = collectDelegationStepText(spec);
  if (!LOCAL_FILE_REFERENCE_RE.test(combined)) return false;
  return !NON_BLANK_BROWSER_TARGET_RE.test(combined);
}

function pruneDelegatedToolsByIntent(
  spec: DelegationContractSpec,
  tools: readonly string[],
): string[] {
  const normalized = normalizeToolNames(tools);
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(spec);
  const requireFileMutation = specRequiresFileMutationEvidence(spec);
  const localFileInspectionTask = specTargetsLocalFiles(spec);
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  const preferInspectionOnlyTools =
    localFileInspectionTask &&
    !requireBrowser &&
    !requireFileMutation &&
    !setupHeavy;
  const hasPreferredImplementationEditor = normalized.some((toolName) =>
    PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)
  );
  const localFileInspectionTools = normalized.filter((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );

  const filtered = normalized.filter((toolName) => {
    if (
      preferInspectionOnlyTools &&
      localFileInspectionTools.length > 0
    ) {
      return LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "research") {
      if (PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.has(toolName)) {
        return true;
      }
      if (normalized.some((candidate) =>
        PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.has(candidate)
      )) {
        return false;
      }
      return PREFERRED_RESEARCH_BROWSER_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "validation" && !requireFileMutation) {
      return PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName) ||
        PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "implementation" || requireFileMutation) {
      if (PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)) return true;
      if (PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)) return true;
      if (
        requireBrowser &&
        PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName)
      ) {
        return true;
      }
      if (!hasPreferredImplementationEditor) {
        return FALLBACK_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName);
      }
      return false;
    }

    if (requireBrowser && isBrowserToolName(toolName)) {
      return PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName) ||
        PREFERRED_RESEARCH_BROWSER_TOOL_NAMES.has(toolName);
    }

    return true;
  });

  return filtered.length > 0 ? filtered : normalized;
}

function isDelegationToolNameLike(toolName: string): boolean {
  return toolName === "execute_with_agent" ||
    toolName.startsWith("subagent.") ||
    toolName.startsWith("agenc.subagent.");
}

function specRequiresFileMutationEvidence(
  spec: DelegationContractSpec,
): boolean {
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  if (capabilityProfile.isReadOnlyContract) {
    return false;
  }
  const hasExplicitFileMutationTool =
    [...(spec.requiredToolCapabilities ?? []), ...(spec.tools ?? [])].some((toolName) =>
      EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName.trim())
    );
  if (hasExplicitFileMutationTool) {
    return true;
  }
  if (hasReviewFindingsIntent(spec) && !capabilityProfile.hasFileWrite) {
    return false;
  }

  const primary = collectDelegationPrimaryText(spec);
  const combined = collectDelegationStepText(spec);
  const hasFileAction = DELEGATION_FILE_ACTION_RE.test(combined);
  const hasExplicitFileTarget = DELEGATION_FILE_TARGET_RE.test(combined);
  const hasCodeTarget = DELEGATION_CODE_TARGET_RE.test(primary);
  const hasTestArtifactTarget = TEST_ARTIFACT_TARGET_RE.test(combined);

  if (taskIntent === "research") {
    return false;
  }

  if (taskIntent === "validation") {
    return hasFileAction &&
      (hasExplicitFileTarget || hasCodeTarget || hasTestArtifactTarget);
  }

  if (taskIntent === "implementation") {
    return hasCodeTarget || hasExplicitFileTarget || capabilityProfile.hasFileWrite ||
      (hasFileAction && hasTestArtifactTarget);
  }

  if (taskIntent === "documentation") {
    return hasFileAction && hasExplicitFileTarget;
  }

  if (setupHeavy) {
    return true;
  }

  return hasFileAction && (hasExplicitFileTarget || hasCodeTarget);
}

function normalizeExplicitArtifactPath(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/\\/g, "/");
}

function collectExplicitSpecFileArtifacts(
  spec: DelegationContractSpec,
): readonly string[] {
  if ((spec.executionContext?.targetArtifacts?.length ?? 0) > 0) {
    return spec.executionContext?.targetArtifacts ?? [];
  }
  return collectExplicitFileArtifactsFromSegments([
    spec.task,
    spec.objective,
    ...(spec.acceptanceCriteria ?? []),
  ]);
}

function collectExplicitFileArtifactsFromSegments(
  segments: readonly (string | undefined)[],
): readonly string[] {
  const matches = new Set<string>();
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.trim().length === 0) {
      continue;
    }
    for (const match of segment.matchAll(EXPLICIT_FILE_ARTIFACT_GLOBAL_RE)) {
      const candidate = normalizeExplicitArtifactPath(match[0] ?? "");
      if (candidate.length > 0) {
        matches.add(candidate);
      }
    }
  }
  return [...matches];
}

function hasExplicitToolRequirement(spec: DelegationContractSpec): boolean {
  if ((spec.tools?.length ?? 0) > 0) return true;
  return (spec.requiredToolCapabilities ?? []).some(looksLikeExplicitDelegatedToolName);
}

export function specRequiresSuccessfulToolEvidence(
  spec: DelegationContractSpec,
): boolean {
  if (hasExplicitToolRequirement(spec)) return true;
  if (specRequiresMeaningfulWorkspaceEvidence(spec)) return true;
  const stepText = collectDelegationStepText(spec);
  if (TOOL_GROUNDED_TASK_RE.test(stepText)) return true;
  const taskIntent = classifyDelegatedTaskIntent(spec);
  return (
    (taskIntent === "research" || taskIntent === "validation") &&
    TOOL_GROUNDED_TASK_RE.test(collectDelegationContextText(spec))
  );
}

function specRequiresMeaningfulWorkspaceEvidence(
  spec: DelegationContractSpec,
): boolean {
  if (spec.inheritedEvidence?.workspaceInspectionSatisfied === true) {
    return false;
  }
  const targetArtifacts = collectExplicitSpecFileArtifacts(spec);
  if (!areDocumentationOnlyArtifacts(targetArtifacts)) {
    return false;
  }
  if (!specTargetsLocalFiles(spec)) {
    return false;
  }
  const text = collectDelegationStepText(spec, { includeParentRequest: true });
  if (!textRequiresWorkspaceGroundedArtifactUpdate(text)) {
    return false;
  }
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  return capabilityProfile.hasFileWrite || targetArtifacts.length > 0;
}

export function specRequiresMeaningfulBrowserEvidence(
  spec: DelegationContractSpec,
): boolean {
  const stepText = collectDelegationStepText(spec);
  const explicitBrowserInteraction = hasExplicitBrowserInteractionCue(stepText);
  const explicitTools = normalizeToolNames([
    ...(spec.tools ?? []),
    ...(spec.requiredToolCapabilities ?? []),
  ]);
  const hasExplicitBrowserTool = explicitTools.some((capability) => {
    const canonical = capability.trim();
    const normalized = canonical.toLowerCase();
    return DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES.has(canonical) ||
      normalized.startsWith("mcp.browser.") ||
      normalized.startsWith("playwright.");
  });
  if (hasExplicitBrowserTool) {
    return true;
  }
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const localWorkspaceContract =
    capabilityProfile.hasFileWrite ||
    capabilityProfile.hasShellExecution ||
    specTargetsLocalFiles(spec);
  if (taskIntent !== "research" && localWorkspaceContract && !explicitBrowserInteraction) {
    return false;
  }
  const hasExplicitLocalFileInspectionTool = explicitTools.some((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );
  if (
    specTargetsLocalFiles(spec) &&
    !explicitBrowserInteraction &&
    (hasExplicitLocalFileInspectionTool || !hasExplicitBrowserTool)
  ) {
    return false;
  }
  if (hasPositiveBrowserGroundingCue(stepText)) return true;
  if (localWorkspaceContract && !explicitBrowserInteraction) {
    return false;
  }
  return taskIntent === "research" &&
    hasPositiveBrowserGroundingCue(collectDelegationContextText(spec));
}

function isMeaningfulBrowserToolName(name: string): boolean {
  return DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES.has(name) &&
    !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(name);
}

function refineDelegatedChildToolAllowlist(params: {
  spec: DelegationContractSpec;
  tools: readonly string[];
}): DelegatedChildToolAllowlistRefinement {
  const normalizedTools = normalizeToolNames(params.tools);
  if (!specRequiresMeaningfulBrowserEvidence(params.spec)) {
    return {
      allowedTools: normalizedTools,
      removedLowSignalBrowserTools: [],
    };
  }

  const meaningfulBrowserTools = normalizedTools.filter((toolName) =>
    isMeaningfulBrowserToolName(toolName)
  );
  const removedLowSignalBrowserTools = normalizedTools.filter((toolName) =>
    LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
  );
  const taskIntent = classifyDelegatedTaskIntent(params.spec);
  const meaningfulResearchTools = normalizedTools.filter((toolName) =>
    DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES.has(toolName)
  );
  const hasProviderNativeResearchTool = taskIntent === "research" &&
    normalizedTools.some((toolName) => isProviderNativeToolName(toolName));
  const hasShellBasedValidationGrounding = taskIntent !== "research" &&
    normalizedTools.some((toolName) =>
      VERIFICATION_EXECUTION_TOOL_NAMES.has(toolName)
    );

  const hasSufficientGroundingTools = taskIntent === "research"
    ? meaningfulResearchTools.length > 0 || hasProviderNativeResearchTool
    : meaningfulBrowserTools.length > 0 || hasShellBasedValidationGrounding;

  if (!hasSufficientGroundingTools) {
    return {
      allowedTools: normalizedTools.filter((toolName) =>
        !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
      ),
      removedLowSignalBrowserTools,
      blockedReason:
        removedLowSignalBrowserTools.length > 0
          ? "Delegated task requires browser-grounded evidence but policy-scoped tools only allow low-signal browser state checks"
          : "Delegated task requires browser-grounded evidence but no meaningful browser interaction tools remain after policy scoping",
    };
  }

  return {
    allowedTools: normalizedTools.filter((toolName) =>
      !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
    ),
    removedLowSignalBrowserTools,
  };
}

export function resolveDelegatedChildToolScope(params: {
  spec: DelegationContractSpec;
  requestedTools?: readonly string[];
  parentAllowedTools?: readonly string[];
  availableTools?: readonly string[];
  forbiddenTools?: readonly string[];
  enforceParentIntersection?: boolean;
  strictExplicitToolAllowlist?: boolean;
  unsafeBenchmarkMode?: boolean;
}): ResolvedDelegatedChildToolScope {
  const requestedSource = normalizeToolNames(
    params.requestedTools ??
      params.spec.executionContext?.allowedTools ??
      params.spec.requiredToolCapabilities,
  );
  const requested = extractExplicitDelegatedToolNames(requestedSource);
  const semanticCapabilities = requestedSource
    .filter((toolName) => !looksLikeExplicitDelegatedToolName(toolName))
    .map((capability) => normalizeCapabilityName(capability));
  const parentAllowedSet = new Set(normalizeToolNames(params.parentAllowedTools));
  const availableSet = new Set(normalizeToolNames(params.availableTools));
  const forbiddenSet = new Set(normalizeToolNames(params.forbiddenTools));

  const unsafeBenchmarkMode = params.unsafeBenchmarkMode === true;

  const removedByPolicy: string[] = [];
  const removedAsDelegationTools: string[] = [];
  const removedAsUnknownTools: string[] = [];
  const allowedTools: string[] = [];
  const explicitRequestedTools: string[] = [];
  const semanticFallback: string[] = [];
  const requiredSubstitutionCandidates: string[] = [];
  const optionalEnrichmentCandidates: string[] = [];
  const capabilityProfile = getDelegatedCapabilityProfile(params.spec);
  const taskIntent = classifyDelegatedTaskIntent(params.spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(params.spec);
  const requireFileMutation = specRequiresFileMutationEvidence(params.spec);
  const localFileInspectionTask = specTargetsLocalFiles(params.spec);
  const setupHeavy = isSetupHeavyDelegatedTask(params.spec);
  const contextOnlyCapabilityRequest =
    semanticCapabilities.length > 0 &&
    semanticCapabilities.every(isContextOnlyCapabilityName);
  const strictExplicitToolAllowlist =
    params.strictExplicitToolAllowlist === true &&
    requested.length > 0 &&
    semanticCapabilities.length === 0;
  const explicitBrowserToolRequested = requested.some((toolName) =>
    isBrowserToolName(toolName) || isHostBrowserToolName(toolName)
  );
  const allowImplicitBrowserFallback =
    requested.length === 0 || explicitBrowserToolRequested;

  const addCandidate = (
    toolName: string,
    options: {
      readonly removalBucket?: string[];
      readonly preserveExplicitRequest?: boolean;
    } = {},
  ): void => {
    const normalized = toolName.trim();
    if (normalized.length === 0) return;
    if (
      !unsafeBenchmarkMode &&
      params.enforceParentIntersection !== false &&
      parentAllowedSet.size > 0 &&
      !parentAllowedSet.has(normalized)
    ) {
      options.removalBucket?.push(normalized);
      return;
    }
    if (!unsafeBenchmarkMode && forbiddenSet.has(normalized)) {
      options.removalBucket?.push(normalized);
      return;
    }
    if (!unsafeBenchmarkMode && isDelegationToolNameLike(normalized)) {
      removedAsDelegationTools.push(normalized);
      return;
    }
    if (
      availableSet.size > 0 &&
      !availableSet.has(normalized) &&
      !isProviderNativeToolName(normalized)
    ) {
      removedAsUnknownTools.push(normalized);
      return;
    }
    if (
      options.preserveExplicitRequest &&
      looksLikeExplicitDelegatedToolName(normalized) &&
      !explicitRequestedTools.includes(normalized)
    ) {
      explicitRequestedTools.push(normalized);
    }
    if (!allowedTools.includes(normalized)) {
      allowedTools.push(normalized);
    }
  };

  for (const toolName of requested) {
    addCandidate(toolName, {
      removalBucket: removedByPolicy,
      preserveExplicitRequest: true,
    });
  }

  const addRequestedSemanticTool = (toolName: string): void => {
    addCandidate(toolName, {
      removalBucket: removedByPolicy,
      preserveExplicitRequest: true,
    });
    if (!requiredSubstitutionCandidates.includes(toolName)) {
      requiredSubstitutionCandidates.push(toolName);
    }
  };

  if (
    semanticCapabilities.some((capability) =>
      FILE_READ_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    )
  ) {
    addRequestedSemanticTool("system.readFile");
    addRequestedSemanticTool("system.listDir");
  }
  if (
    semanticCapabilities.some((capability) =>
      FILE_WRITE_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    )
  ) {
    addRequestedSemanticTool("system.writeFile");
    addRequestedSemanticTool("system.appendFile");
    addRequestedSemanticTool("system.mkdir");
  }
  if (semanticCapabilities.some((capability) => SHELL_EXECUTION_CAPABILITY_RE.test(capability))) {
    addRequestedSemanticTool("desktop.bash");
    addRequestedSemanticTool("system.bash");
  }

  const addSemanticFallback = (
    toolName: string,
    classification: "optional_enrichment" | "required_substitution" =
      "optional_enrichment",
  ): void => {
    if (!semanticFallback.includes(toolName)) {
      semanticFallback.push(toolName);
    }
    const bucket = classification === "required_substitution"
      ? requiredSubstitutionCandidates
      : optionalEnrichmentCandidates;
    if (!bucket.includes(toolName)) {
      bucket.push(toolName);
    }
    addCandidate(toolName);
  };

  const addShellSemanticFallback = (
    classification: "optional_enrichment" | "required_substitution" =
      "optional_enrichment",
  ): void => {
    addSemanticFallback("desktop.bash", classification);
    addSemanticFallback("system.bash", classification);
  };

  if (
    !strictExplicitToolAllowlist &&
    !capabilityProfile.isReadOnlyContract &&
    localFileInspectionTask &&
    !requireBrowser &&
    !requireFileMutation
  ) {
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("system.readFile");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if (
    !strictExplicitToolAllowlist &&
    !capabilityProfile.isReadOnlyContract &&
    allowImplicitBrowserFallback &&
    (requireBrowser || (taskIntent === "research" && !localFileInspectionTask))
  ) {
    addSemanticFallback(PROVIDER_NATIVE_WEB_SEARCH_TOOL);
    addSemanticFallback(PROVIDER_NATIVE_X_SEARCH_TOOL);
    addSemanticFallback(PROVIDER_NATIVE_FILE_SEARCH_TOOL);
    addSemanticFallback("system.browse");
    addSemanticFallback("system.browserSessionStart");
    addSemanticFallback("system.browserAction");
    addSemanticFallback("system.browserSessionResume");
    addSemanticFallback("system.browserSessionStatus");
    addSemanticFallback("system.browserSessionArtifacts");
    addSemanticFallback("mcp.browser.browser_navigate");
    addSemanticFallback("mcp.browser.browser_snapshot");
    addSemanticFallback("mcp.browser.browser_run_code");
  }

  if (
    !strictExplicitToolAllowlist &&
    !capabilityProfile.isReadOnlyContract &&
    (requireFileMutation || taskIntent === "implementation" || setupHeavy)
  ) {
    addShellSemanticFallback();
    addSemanticFallback("system.mkdir");
    addSemanticFallback("system.writeFile");
    addSemanticFallback("system.appendFile");
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if (
    !strictExplicitToolAllowlist &&
    !capabilityProfile.isReadOnlyContract &&
    taskIntent === "validation"
  ) {
    addShellSemanticFallback();
    if (allowImplicitBrowserFallback) {
      addSemanticFallback("system.browserSessionStart");
      addSemanticFallback("system.browserAction");
      addSemanticFallback("system.browserSessionResume");
      addSemanticFallback("system.browserSessionStatus");
      addSemanticFallback("system.browserSessionArtifacts");
      addSemanticFallback("mcp.browser.browser_navigate");
      addSemanticFallback("mcp.browser.browser_snapshot");
      addSemanticFallback("mcp.browser.browser_run_code");
    }
  }

  if (
    !strictExplicitToolAllowlist &&
    allowedTools.length === 0 &&
    !contextOnlyCapabilityRequest &&
    !capabilityProfile.isReadOnlyContract
  ) {
    addShellSemanticFallback();
  }

  if (unsafeBenchmarkMode) {
    addCandidate("execute_with_agent");
  }

  const refined = refineDelegatedChildToolAllowlist({
    spec: params.spec,
    tools: allowedTools,
  });
  const refinedExplicitRequestedTools = explicitRequestedTools.filter((toolName) =>
    refined.allowedTools.includes(toolName)
  );
  const profiledFallbackTools = pruneDelegatedToolsByIntent(
    params.spec,
    refined.allowedTools.filter((toolName) =>
      !refinedExplicitRequestedTools.includes(toolName)
    ),
  );
  const profiledAllowedTools = normalizeToolNames([
    ...refinedExplicitRequestedTools,
    ...profiledFallbackTools,
  ]);
  const profiledSemanticFallback = semanticFallback.filter((toolName) =>
    profiledAllowedTools.includes(toolName)
  );
  const missingRequestedTools = requested.filter((toolName) =>
    !profiledAllowedTools.includes(toolName)
  );
  const filteredRequiredSubstitution = requiredSubstitutionCandidates.filter(
    (toolName) => profiledAllowedTools.includes(toolName),
  );
  const nonRequestedAllowedTools = profiledAllowedTools.filter((toolName) =>
    !refinedExplicitRequestedTools.includes(toolName),
  );
  const inferredRequiredSubstitution = missingRequestedTools.length > 0
    ? nonRequestedAllowedTools
    : [];
  const requiredSubstitution = normalizeToolNames([
    ...filteredRequiredSubstitution,
    ...inferredRequiredSubstitution,
  ]);
  const optionalEnrichment = optionalEnrichmentCandidates.filter((toolName) =>
    profiledAllowedTools.includes(toolName) &&
    !requiredSubstitution.includes(toolName)
  );
  const toolContractState: DelegatedToolContractState =
    requiredSubstitution.length > 0 || missingRequestedTools.length > 0
      ? "degraded"
      : optionalEnrichment.length > 0
      ? "enriched"
      : "exact";
  const explicitAllowlistUnsatisfied =
    strictExplicitToolAllowlist &&
    (
      missingRequestedTools.length > 0 ||
      profiledAllowedTools.some((toolName) =>
        !refinedExplicitRequestedTools.includes(toolName)
      )
    );
  const allowsToollessExecution =
    !explicitAllowlistUnsatisfied &&
    profiledAllowedTools.length === 0 &&
    (requestedSource.length === 0 || contextOnlyCapabilityRequest) &&
    requested.length === 0 &&
    !specRequiresSuccessfulToolEvidence(params.spec) &&
    !refined.blockedReason;

  return {
    allowedTools: profiledAllowedTools,
    removedLowSignalBrowserTools: refined.removedLowSignalBrowserTools,
    blockedReason:
      refined.blockedReason ??
      (!allowsToollessExecution && profiledAllowedTools.length === 0
        ? "No permitted child tools remain after policy scoping"
        : undefined),
    semanticFallback: profiledSemanticFallback,
    removedByPolicy,
    removedAsDelegationTools,
    removedAsUnknownTools,
    allowsToollessExecution,
    toolContract: {
      state: toolContractState,
      requestedSource,
      requestedConcreteTools: requested,
      requestedSemanticCapabilities: semanticCapabilities,
      resolvedTools: profiledAllowedTools,
      missingRequestedTools,
      optionalEnrichment,
      requiredSubstitution,
    },
  };
}






