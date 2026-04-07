/**
 * Planner-era request-analysis utilities surviving the planner subsystem
 * rip-out. Phase 2e of the claude_code-alignment refactor reduced this file
 * from 7,051 lines to ~250 lines containing only the 13 helpers gateway and
 * executor code still imports. Cut 1.2 (TODO.MD) will rename this to
 * `request-analysis.ts`; the file is kept under its old name for now to
 * minimize the import-cascade footprint of this commit.
 *
 * @module
 */

import { basename as pathBasename } from "node:path";

import type { LLMMessage } from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type { PlannerDecision } from "./chat-executor-types.js";
import { RECOVERY_HINT_PREFIX } from "./chat-executor-constants.js";
import {
  hasConcordiaGenerateAgentsContract,
  hasConcordiaSimulationTurnContract,
  looksLikeConcordiaGenerateAgentsPrompt,
} from "./chat-executor-turn-contracts.js";
import {
  buildImperativeToolReferenceRegex,
  extractExplicitImperativeToolNames,
} from "./chat-executor-explicit-tools.js";
import {
  extractRequiredSubagentOrchestrationRequirements,
  type RequiredSubagentOrchestrationRequirements as ExplicitSubagentOrchestrationRequirements,
} from "../workflow/subagent-orchestration-requirements.js";

// ============================================================================
// Safe array accessor — LLM-parsed step fields may violate their declared type
// at runtime.  This utility is intentionally used at every spread / iteration
// site so that each consumer is independently safe regardless of the entry
// path a step arrived through.
// ============================================================================

export function safeStepStringArray(
  value: unknown,
): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return [];
}

// ============================================================================
// Planner decision
// ============================================================================

interface PlannerRequestSignals {
  readonly normalized: string;
  readonly hasMultiStepCue: boolean;
  readonly hasToolDiversityCue: boolean;
  readonly hasDelegationCue: boolean;
  readonly hasImplementationScopeCue: boolean;
  readonly hasVerificationCue: boolean;
  readonly hasDocumentationCue: boolean;
  readonly longTask: boolean;
  readonly structuredBulletCount: number;
  readonly priorToolMessages: number;
  readonly hasPriorNoProgressSignal: boolean;
}

const EXPLICIT_DELEGATION_REQUEST_RE =
  /\b(?:spawn|use|run|launch|start|delegate(?:\s+to)?|hand\s+off\s+to)\b[\s\S]{0,64}\b(?:sub[\s-]?agents?|child\s+agents?|another\s+agent|execute_with_agent|deeper\s+research|research|investigation|investigate|inspection|inspect|triage|analy[sz]e|analysis)\b/i;






function countStructuredBulletLines(messageText: string): number {
  return messageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[\).:])\s+/.test(line))
    .length;
}

export function collectPlannerRequestSignals(
  messageText: string,
  history: readonly LLMMessage[],
): PlannerRequestSignals {
  const normalized = messageText.toLowerCase();
  const historyTail = history.slice(-10);
  return {
    normalized,
    hasMultiStepCue:
      /\b(first|second|third|then|after that|next|finally|step\b|in order|checklist|pipeline)\b/i.test(
        messageText,
      ) ||
      /\b1[\).:]\s+.+\b2[\).:]/s.test(messageText),
    hasToolDiversityCue:
      /\b(browser|http|curl|bash|command|container|playwright|open|navigate|teardown|verify)\b/i.test(
        messageText,
      ),
    hasDelegationCue:
      /\b(sub[\s-]?agent|child agent|execute_with_agent|delegate|delegation|parallel(?:ize|ism)?|fanout)\b/i.test(
        messageText,
      ),
    hasImplementationScopeCue:
      /\b(build(?:ing)?|implement|create|scaffold|generate|refactor|migrate|api|endpoint|service|integration|unit tests?|e2e|makefile|project|shell|cli|daemon|crawler|parser|compiler|database|library|program)\b/i.test(
        messageText,
      ) ||
      /\b(add|write|create|run)\s+(?:unit\s+)?tests?\b/i.test(messageText),
    hasVerificationCue:
      /\b(verify|verification|validate|validation|typecheck|lint|build|compile|vitest|jest|mocha|passing commands?)\b/i.test(
        messageText,
      ) ||
      /\b(add|write|create|run|include)\s+(?:unit\s+)?tests?\b/i.test(
        messageText,
      ),
    hasDocumentationCue:
      /\b(readme|docs?|documentation|architecture summary|how to play|known limitations|report)\b/i.test(
        messageText,
      ),
    longTask:
      messageText.length >= 320 || messageText.split(/\n/).length >= 4,
    structuredBulletCount: countStructuredBulletLines(messageText),
    priorToolMessages: historyTail.filter((entry) => entry.role === "tool")
      .length,
    hasPriorNoProgressSignal: historyTail.some(
      (entry) =>
        typeof entry.content === "string" &&
        entry.content.includes(RECOVERY_HINT_PREFIX),
    ),
  };
}

export function assessPlannerDecision(
  plannerEnabled: boolean,
  messageText: string,
  history: readonly LLMMessage[],
  metadata?: Readonly<Record<string, unknown>>,
): PlannerDecision {
  if (!plannerEnabled) {
    return {
      score: 0,
      shouldPlan: false,
      reason: "planner_disabled",
    };
  }

  const signals = collectPlannerRequestSignals(messageText, history);
  let score = 0;
  const reasons: string[] = [];

  if (hasConcordiaSimulationTurnContract(metadata)) {
    return {
      score,
      shouldPlan: false,
      reason: "concordia_simulation_turn",
    };
  }

  if (
    hasConcordiaGenerateAgentsContract(metadata) ||
    looksLikeConcordiaGenerateAgentsPrompt(messageText)
  ) {
    return {
      score,
      shouldPlan: false,
      reason: "concordia_generate_agents_turn",
    };
  }

  if (signals.hasMultiStepCue) {
    score += 3;
    reasons.push("multi_step_cues");
  }

  if (signals.hasToolDiversityCue) {
    score += 1;
    reasons.push("multi_tool_candidates");
  }

  if (signals.hasDelegationCue) {
    score += 4;
    reasons.push("delegation_cue");
  }

  if (signals.hasImplementationScopeCue) {
    score += 3;
    reasons.push("implementation_scope");
  }

  if (signals.longTask) {
    score += 1;
    reasons.push("long_or_structured_request");
  }

  if (signals.priorToolMessages >= 4) {
    score += 2;
    reasons.push("prior_tool_loop_activity");
  }
  if (signals.hasPriorNoProgressSignal) {
    score += 2;
    reasons.push("prior_no_progress_signal");
  }

  const isExactResponseTurn = isDialogueOnlyExactResponseTurn(messageText);
  if (isExactResponseTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "exact_response_turn",
    };
  }

  const isDialogueMemoryTurn = isDialogueOnlyMemoryTurn(messageText);
  if (isDialogueMemoryTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "dialogue_memory_turn",
    };
  }

  const isDialogueRecallTurn = isDialogueOnlyRecallTurn(messageText);
  if (isDialogueRecallTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "dialogue_recall_turn",
    };
  }

  // Review/analysis questions about files should go through the direct
  // tool loop (readFile + conversational response), not the planner.
  // "read through PLAN.md, are there any gaps?" is a review task.
  if (
    /\b(?:read\s+through|review|analyze|check|look\s+at|go\s+through|evaluate|assess)\b/i.test(messageText) &&
    /\b(?:gaps?|missing|enough|sufficient|complete|cover|edge\s+cases?)\b/i.test(messageText) &&
    /\?/.test(messageText)
  ) {
    return {
      score,
      shouldPlan: false,
      reason: "review_analysis_question",
    };
  }

  // Pre-planner routing only needs to know "does this turn reference a
  // planning artifact", NOT what the user wants done with it. The actual
  // EDIT vs IMPLEMENT vs GENERATE decision is made by the model later and
  // surfaced as `plan_intent` in the planner JSON output. Force planning
  // whenever an artifact path is mentioned so the model gets the rubric.
  const referencedArtifacts = extractPlannerArtifactTargets(messageText);
  if (referencedArtifacts.length > 0) {
    return {
      score: Math.max(score, 4),
      shouldPlan: true,
      reason:
        reasons.length > 0
          ? `${reasons.join("+")}+plan_artifact_reference`
          : "plan_artifact_reference",
    };
  }

  const directFastPath =
    score < 3 ||
    signals.normalized.trim().length < 20 ||
    /\b(hi|hello|thanks|thank you)\b/.test(signals.normalized);

  return {
    score,
    shouldPlan: !directFastPath,
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
  };
}

export function isDialogueOnlyDirectTurnMessage(messageText: string): boolean {
  return (
    isDialogueOnlyExactResponseTurn(messageText) ||
    isDialogueOnlyMemoryTurn(messageText) ||
    isDialogueOnlyRecallTurn(messageText)
  );
}

export function requestRequiresToolGroundedExecution(
  messageText: string,
): boolean {
  if (isDialogueOnlyDirectTurnMessage(messageText)) {
    return false;
  }

  const explicitEnvironmentAction = EXPLICIT_ENV_ACTION_CUE_RE.test(messageText);
  if (
    EXPLANATION_ONLY_REQUEST_RE.test(messageText) &&
    !explicitEnvironmentAction
  ) {
    return false;
  }

  const signals = collectPlannerRequestSignals(messageText, []);
  if (explicitEnvironmentAction) {
    return true;
  }

  if (signals.hasImplementationScopeCue && signals.hasVerificationCue) {
    return true;
  }

  if (
    signals.hasImplementationScopeCue &&
    EXECUTION_ARTIFACT_OR_PATH_CUE_RE.test(messageText)
  ) {
    return true;
  }

  if (
    signals.hasImplementationScopeCue &&
    EXECUTION_SCOPE_BOUNDARY_CUE_RE.test(messageText)
  ) {
    return true;
  }

  return (
    signals.hasVerificationCue &&
    (EXECUTION_ARTIFACT_OR_PATH_CUE_RE.test(messageText) ||
      EXECUTION_SCOPE_BOUNDARY_CUE_RE.test(messageText))
  );
}

export function requestExplicitlyRequestsDelegation(
  messageText: string,
): boolean {
  return EXPLICIT_DELEGATION_REQUEST_RE.test(messageText);
}


const EXACT_RESPONSE_CUE_RE =
  /\b(?:return|reply|respond|output)(?:\s+with)?\s+exactly\b/i;
const DIALOGUE_MEMORY_CUE_RE =
  /\b(?:memorize|remember|keep in mind|later recall|for later recall|recall later)\b/i;
const DIALOGUE_RECALL_CUE_RE =
  /\b(?:recall|remember|repeat|return|what(?:'s| is| were| did))\b/i;
const DIALOGUE_RECALL_REFERENCE_CUE_RE =
  /\b(?:from (?:test|earlier|before|above|prior|previous)|(?:you|i) (?:stored|memorized|remembered|told)|those facts|these facts|the facts|last turn|prior turn|previous turn|continuity test)\b/i;
const EXPLICIT_ENV_ACTION_CUE_RE =
  /\b(?:use|call|invoke|run|start|stop|create|write|edit|save|open|navigate|click|search|browse|inspect|read|check|verify|delegate|spawn|launch|post|publish|deploy|install|build|implement|refactor|migrate|continue)\b[\s\S]{0,96}\b(?:tool|tools|desktop|system|mcp|browser|bash|command|terminal|file|files|server|process|service|sub[\s-]?agent|execute_with_agent|child\s+session|continuation\s+session|session\s+id|task|api|endpoint|project|tests?|[a-z][\w-]*\.[a-z][\w.-]*)\b/i;
const EXECUTION_ARTIFACT_OR_PATH_CUE_RE =
  /\b(?:[a-z0-9_-]+\.(?:c|cc|cpp|h|hpp|rs|go|py|rb|php|java|kt|js|mjs|cjs|ts|tsx|jsx|json|md|toml|yaml|yml)|makefile|dockerfile|package\.json|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|src\/|tests?\/|workspace|directory|folder|repo(?:sitory)?|project)\b/i;
const EXECUTION_SCOPE_BOUNDARY_CUE_RE =
  /\b(?:in|under|inside|within|at)\s+[`'"]?(?:\/|\.\/|\.\.\/)|\b(?:do not read|do not modify|keep everything|only in|only under|only inside)\b/i;
const EXPLANATION_ONLY_REQUEST_RE =
  /\b(?:explain|describe|outline|summarize|brainstorm|compare|review|analy(?:s|z)e|what would|how would|plan(?:\s+out)?|walk me through)\b/i;



function isDialogueOnlyExactResponseTurn(messageText: string): boolean {
  return (
    EXACT_RESPONSE_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}

function isDialogueOnlyMemoryTurn(messageText: string): boolean {
  return (
    DIALOGUE_MEMORY_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}

function isDialogueOnlyRecallTurn(messageText: string): boolean {
  return (
    DIALOGUE_RECALL_CUE_RE.test(messageText) &&
    DIALOGUE_RECALL_REFERENCE_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}




// ============================================================================
// Planner message building
// ============================================================================






// PLANNER_EXPLICIT_ARTIFACT_* are parsing regexes used by
// `extractPlannerArtifactTargets` to find @-mentioned and quoted file paths in
// the user message. They do NOT classify intent — they only locate references.
// The four classifier-cue regexes (PLANNER_PLAN_ARTIFACT_REQUEST_RE,
// PLANNER_PLAN_ARTIFACT_PHASE_CUE_RE, PLANNER_PLAN_ARTIFACT_EDIT_CUE_RE,
// PLANNER_PLAN_ARTIFACT_IMPLEMENTATION_CUE_RE) were removed alongside
// `classifyPlannerPlanArtifactIntent` on 2026-04-06.
const PLANNER_EXPLICIT_ARTIFACT_AT_REF_RE =
  /(?:^|[\s(])@((?:\.{0,2}\/|\/)?[A-Za-z0-9._\/-]+(?:\.[A-Za-z0-9._-]+)?)/g;
const PLANNER_EXPLICIT_ARTIFACT_QUOTED_RE =
  /[`'"]((?:\/{1}|\.\/?|\.\.\/)?[A-Za-z0-9._\/-]+(?:\.[A-Za-z0-9._-]+)?|(?:Makefile|Dockerfile|CMakeLists\.txt|README(?:\.[A-Za-z0-9._-]+)?|CHANGELOG(?:\.[A-Za-z0-9._-]+)?|CONTRIBUTING(?:\.[A-Za-z0-9._-]+)?|LICENSE(?:\.[A-Za-z0-9._-]+)?|COPYING(?:\.[A-Za-z0-9._-]+)?|AGENTS\.md|CLAUDE\.md|TODO(?:\.[A-Za-z0-9._-]+)?))[`'"]/gi;
const PLANNER_EXPLICIT_ARTIFACT_BARE_RE =
  /\b((?:\/{1}|\.\/?|\.\.\/)?[A-Za-z0-9._\/-]+\.[A-Za-z0-9._-]+|(?:Makefile|Dockerfile|CMakeLists\.txt|README(?:\.[A-Za-z0-9._-]+)?|CHANGELOG(?:\.[A-Za-z0-9._-]+)?|CONTRIBUTING(?:\.[A-Za-z0-9._-]+)?|LICENSE(?:\.[A-Za-z0-9._-]+)?|COPYING(?:\.[A-Za-z0-9._-]+)?|AGENTS\.md|CLAUDE\.md|TODO(?:\.[A-Za-z0-9._-]+)?))\b/gi;
const PLANNER_EXPLICIT_ARTIFACT_SPECIAL_BASENAME_RE =
  /^(?:Makefile|Dockerfile|CMakeLists\.txt|README(?:\.[A-Za-z0-9._-]+)?|CHANGELOG(?:\.[A-Za-z0-9._-]+)?|CONTRIBUTING(?:\.[A-Za-z0-9._-]+)?|LICENSE(?:\.[A-Za-z0-9._-]+)?|COPYING(?:\.[A-Za-z0-9._-]+)?|AGENTS\.md|CLAUDE\.md|TODO(?:\.[A-Za-z0-9._-]+)?)$/i;
const PLANNER_ARTIFACT_FILE_EXTENSION_RE =
  /^(?:c|cc|cpp|cxx|h|hpp|m|mm|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash|md|txt|rst|adoc|html|css|scss|less|sql|csv|tsv|ini|cfg|conf|env|lock)$/i;

// PlannerPlanArtifactIntent is now defined in chat-executor-types.ts and
// re-exported below so external callers (chat-executor-artifact-task) can keep
// importing it from this module without churn.
export type { PlannerPlanArtifactIntent } from "./chat-executor-types.js";


export function extractExplicitSubagentOrchestrationRequirements(
  messageText: string,
): ExplicitSubagentOrchestrationRequirements | undefined {
  return extractRequiredSubagentOrchestrationRequirements(messageText);
}













interface ExplicitDeterministicToolRequirements {
  readonly orderedToolNames: readonly string[];
  readonly minimumToolCallsByName: Readonly<Record<string, number>>;
  readonly forcePlanner: boolean;
  readonly exactResponseLiteral?: string;
}

export function extractExplicitDeterministicToolRequirements(
  messageText: string,
  allowedToolNames: readonly string[],
  metadata?: Readonly<Record<string, unknown>>,
): ExplicitDeterministicToolRequirements | undefined {
  const orderedToolNames = extractExplicitImperativeToolNames(
    messageText,
    allowedToolNames,
  );
  if (orderedToolNames.length === 0) return undefined;
  const minimumToolCallsByName = Object.fromEntries(
    orderedToolNames.map((toolName) => [
      toolName,
      extractExplicitToolInvocationCount(
        messageText,
        toolName,
        orderedToolNames,
      ),
    ]),
  );
  return {
    orderedToolNames,
    minimumToolCallsByName,
    forcePlanner: Object.values(minimumToolCallsByName).some(
      (count) => count > 1,
    ),
    exactResponseLiteral: extractExactResponseLiteral(messageText, metadata),
  };
}

const EXACT_RESPONSE_LITERAL_DIRECTIVE_RE =
  /\b(?:return|reply|respond|output|answer)(?:\s+with)?\s+exactly(?:\s+as)?\s+/i;
const GENERIC_EXACT_LITERAL_RE =
  /^(?:the\s+)?(?:child\s+answer|answer|result|memorized\s+token|memorised\s+token|token)$/i;
const TOOL_INVOCATION_WORD_COUNTS = new Map<string, number>([
  ["once", 1],
  ["twice", 2],
  ["thrice", 3],
]);

function extractExplicitToolInvocationCount(
  messageText: string,
  toolName: string,
  orderedToolNames: readonly string[],
): number {
  const segment = extractExplicitToolDirectiveSegment(
    messageText,
    toolName,
    orderedToolNames,
  );
  const numericMatch =
    /\bexactly\s+(\d+)\s+times?\b/i.exec(segment) ??
    /\b(\d+)\s+times?\b/i.exec(segment);
  if (numericMatch) {
    return Math.max(1, Number(numericMatch[1] ?? "1"));
  }

  const wordMatch = /\b(once|twice|thrice)\b/i.exec(segment);
  if (wordMatch) {
    return TOOL_INVOCATION_WORD_COUNTS.get(
      (wordMatch[1] ?? "").toLowerCase(),
    ) ?? 1;
  }

  const bulletCount = countStructuredDirectiveBullets(segment);
  return Math.max(1, bulletCount);
}

function extractExplicitToolDirectiveSegment(
  messageText: string,
  toolName: string,
  orderedToolNames: readonly string[],
): string {
  const invocationRe = buildImperativeToolReferenceRegex(toolName, "i");
  const invocationMatch = invocationRe.exec(messageText);
  if (!invocationMatch) {
    return messageText;
  }

  const start = invocationMatch.index;
  let end = messageText.length;

  const relativeAfterToolCallsMatch = /\bafter the tool calls\b/i.exec(
    messageText.slice(start),
  );
  if (relativeAfterToolCallsMatch) {
    end = Math.min(end, start + relativeAfterToolCallsMatch.index);
  }

  for (const otherToolName of orderedToolNames) {
    if (otherToolName === toolName) continue;
    const otherInvocationRe = buildImperativeToolReferenceRegex(
      otherToolName,
      "ig",
    );
    let otherMatch: RegExpExecArray | null;
    while ((otherMatch = otherInvocationRe.exec(messageText)) !== null) {
      if (otherMatch.index > start) {
        end = Math.min(end, otherMatch.index);
        break;
      }
    }
  }

  return messageText.slice(start, end);
}

function countStructuredDirectiveBullets(segment: string): number {
  const lines = segment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
  return bulletLines.length >= 2 ? bulletLines.length : 0;
}

function extractExactResponseLiteral(
  messageText: string,
  metadata?: Readonly<Record<string, unknown>>,
): string | undefined {
  if (
    hasConcordiaGenerateAgentsContract(metadata) ||
    looksLikeConcordiaGenerateAgentsPrompt(messageText)
  ) {
    return undefined;
  }

  const directiveMatch = EXACT_RESPONSE_LITERAL_DIRECTIVE_RE.exec(messageText);
  if (!directiveMatch) {
    return extractExactAliasLiteral(messageText);
  }

  const remainder = messageText
    .slice(directiveMatch.index + directiveMatch[0].length)
    .trim();
  if (!remainder) {
    return extractExactAliasLiteral(messageText);
  }

  const normalized = normalizeExactLiteralCandidate(remainder);
  if (normalized && !GENERIC_EXACT_LITERAL_RE.test(normalized)) {
    return normalized;
  }

  return extractExactAliasLiteral(messageText);
}

function extractExactAliasLiteral(messageText: string): string | undefined {
  const aliasMatch =
    /\b(?:return|reply|respond|output|answer)\b[\s\S]{0,160}?\bas\s+("[^"]+"|'[^']+'|`[^`]+`|[^\n]+?)(?:[.!?](?:\s|$)|$)/i.exec(
      messageText,
    );
  if (!aliasMatch) {
    return undefined;
  }
  return normalizeExactLiteralCandidate(aliasMatch[1] ?? "");
}

function normalizeExactLiteralCandidate(candidate: string): string | undefined {
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate.length === 0) {
    return undefined;
  }

  const openingQuote = trimmedCandidate[0];
  const quotePairs = new Map<string, string>([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
  ]);
  const closingQuote = quotePairs.get(openingQuote);
  if (closingQuote) {
    const closingIndex = trimmedCandidate.indexOf(closingQuote, 1);
    if (closingIndex > 1) {
      const quoted = trimmedCandidate.slice(1, closingIndex).trim();
      if (quoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(quoted)) {
        return quoted;
      }
    }
    return undefined;
  }

  const unquoted = trimmedCandidate
    .replace(/\s+/g, " ")
    .replace(
      /\s+(?:and|with)\s+(?:nothing\s+else|no\s+extra\s+(?:text|words)|no\s+other\s+text)\b[\s\S]*$/i,
      "",
    )
    .replace(/[.!?]+$/, "")
    .trim();
  if (unquoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(unquoted)) {
    return unquoted;
  }

  return undefined;
}

// ============================================================================
// Planner execution context
// ============================================================================


// ============================================================================
// Planner plan parsing
// ============================================================================





















// ============================================================================
// Planner graph validation
// ============================================================================

































function isExplicitPlannerArtifactCandidate(target: string): boolean {
  const normalized = normalizePlannerArtifactTarget(target);
  if (normalized.length === 0) {
    return false;
  }
  const basename = pathBasename(normalized);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.includes("/")
  ) {
    return true;
  }
  if (PLANNER_EXPLICIT_ARTIFACT_SPECIAL_BASENAME_RE.test(basename)) {
    return true;
  }
  const extension = basename.includes(".")
    ? basename.slice(basename.lastIndexOf(".") + 1)
    : "";
  return extension.length > 0 && PLANNER_ARTIFACT_FILE_EXTENSION_RE.test(extension);
}

export function extractPlannerArtifactTargets(
  messageText: string,
): readonly string[] {
  const sourceText = messageText.trim();
  if (sourceText.length === 0) {
    return [];
  }

  const targets = new Set<string>();
  const addTarget = (value: string | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    const sanitized = sanitizePlannerArtifactTarget(value);
    if (!isExplicitPlannerArtifactCandidate(sanitized)) {
      return;
    }
    targets.add(sanitized);
  };

  PLANNER_EXPLICIT_ARTIFACT_AT_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLANNER_EXPLICIT_ARTIFACT_AT_REF_RE.exec(sourceText)) !== null) {
    addTarget(match[1]);
  }

  PLANNER_EXPLICIT_ARTIFACT_QUOTED_RE.lastIndex = 0;
  while ((match = PLANNER_EXPLICIT_ARTIFACT_QUOTED_RE.exec(sourceText)) !== null) {
    addTarget(match[1]);
  }

  PLANNER_EXPLICIT_ARTIFACT_BARE_RE.lastIndex = 0;
  while ((match = PLANNER_EXPLICIT_ARTIFACT_BARE_RE.exec(sourceText)) !== null) {
    addTarget(match[1]);
  }

  return [...targets];
}

function escapePlannerArtifactRegexLiteral(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}
function plannerArtifactMentionHasSourceCue(
  messageText: string,
  target: string,
): boolean {
  const escapedTarget = escapePlannerArtifactRegexLiteral(target);
  const wrappedTarget = `(?:@|[\`'"])?${escapedTarget}(?:[\`'"])?`;
  const sourceCueBeforeTarget = new RegExp(
    String.raw`\b(?:read|review|inspect|use|follow|based on|source of truth|go through|from)\b[\s\S]{0,80}?${wrappedTarget}`,
    "i",
  );
  const sourceCueAfterTarget = new RegExp(
    String.raw`${wrappedTarget}[\s\S]{0,80}?\b(?:source of truth|for guidance|as guidance|as the spec|as the source)\b`,
    "i",
  );
  const implementationCueBeforeTarget = new RegExp(
    String.raw`\b(?:implement|execute|complete|finish|carry\s+out|apply|fix|repair|refactor|ship)\b[\s\S]{0,80}?\b(?:in|from|using|following|per|according to)\b[\s\S]{0,32}?${wrappedTarget}`,
    "i",
  );
  const directImplementationCueTarget = new RegExp(
    String.raw`\b(?:implement|execute|complete|finish|carry\s+out|apply|fix|repair|refactor|ship)\b[\s\S]{0,24}?${wrappedTarget}\b`,
    "i",
  );
  return (
    sourceCueBeforeTarget.test(messageText) ||
    sourceCueAfterTarget.test(messageText) ||
    implementationCueBeforeTarget.test(messageText) ||
    directImplementationCueTarget.test(messageText)
  );
}
export function extractPlannerSourceArtifactTargets(
  messageText: string,
): readonly string[] {
  const explicitTargets = extractPlannerArtifactTargets(messageText);
  if (explicitTargets.length === 0) {
    return [];
  }
  return explicitTargets.filter((target) =>
    plannerArtifactMentionHasSourceCue(messageText, target)
  );
}

// ============================================================================
// REMOVED 2026-04-06 — regex-based plan-artifact intent classifier
// ============================================================================
//
// This file used to contain `classifyPlannerPlanArtifactIntent(messageText)`
// and four wrapper functions (`plannerRequestNeedsGroundedPlanArtifact`,
// `plannerRequestNeedsPlanArtifactExecution`,
// `plannerRequestNeedsWorkspaceGroundedArtifactUpdate`,
// `plannerRequestImplementsFromArtifact`) plus four `PLANNER_PLAN_ARTIFACT_*`
// regex constants. They tried to label the user message as `edit_artifact |
// implement_from_artifact | grounded_plan_generation | none` BEFORE the model
// saw the request, then injected a different system prompt per label.
//
// That layer was harmful: a single surface-keyword regex (e.g. "fill any
// gaps", "find missing sections") forced the planner into the EDIT branch,
// which sent the model a system message saying "Do NOT create source code
// files" and "Keep the plan as a single deterministic read → write sequence".
// Once that prompt landed, the model could not pick the right action even
// when context made the right action obvious.
//
// The new contract: the model decides intent and emits it as a top-level
// `plan_intent` field in its JSON response. Pre-call code only EXTRACTS
// artifact target paths (parsing, not classification). Post-call validators
// read `plannerPlan.planIntent` from the parsed plan instead of re-running a
// regex against the user message.
//
// External call sites kept compatible by reading `plannerPlan.planIntent`:
//   - chat-executor-planner.ts validators (validatePlannerArtifactAuthority,
//     validatePlannerPlan, validatePlannerPlanArtifactSteps)
//   - chat-executor-contract-flow.ts contract gating
//   - turn-execution-contract.ts contract assembly
//
// See also: CLAUDE.md learned rule "Artifact Routing: Never make runtime
// behavior depend on a filename like `PLAN.md`" (2026-04-04).
// ============================================================================

function sanitizePlannerArtifactTarget(target: string): string {
  return target
    .trim()
    .replace(/^@+/, "")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/\\/g, "/");
}

function normalizePlannerArtifactTarget(target: string): string {
  return sanitizePlannerArtifactTarget(target).toLowerCase();
}
















































// ============================================================================
// Planner utility functions
// ============================================================================























export function sanitizePlannerStepName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return normalized.length > 0 ? normalized : "step";
}


export function isPipelineStopReasonHint(
  value: unknown,
): value is Exclude<LLMPipelineStopReason, "completed" | "tool_calls"> {
  return (
    value === "validation_error" ||
    value === "provider_error" ||
    value === "authentication_error" ||
    value === "rate_limited" ||
    value === "timeout" ||
    value === "tool_error" ||
    value === "budget_exceeded" ||
    value === "no_progress" ||
    value === "cancelled"
  );
}

// ============================================================================
// Planner synthesis messages
// ============================================================================





// ============================================================================
// Extracted from executePlannerPath — delegation bandit arm resolution
// ============================================================================



// ============================================================================
// Extracted from executePlannerPath — delegation decision assessment
// ============================================================================



// ============================================================================
// Extracted from executePlannerPath — pipeline step mapping
// ============================================================================


