import { createHash } from "node:crypto";

import type { LLMMessage } from "./types.js";
import { extractToolFailureTextFromResult } from "./chat-executor-tool-utils.js";
import {
  findToolTurnValidationIssue,
} from "./tool-turn-validator.js";
import { collectPreservedMessages } from "./compact/attachments.js";
import type {
  ArtifactCompactionState,
  ContextArtifactKind,
  ContextArtifactRecord,
  ContextArtifactRef,
} from "../memory/artifact-store.js";

const DEFAULT_KEEP_TAIL_COUNT = 5;
const DEFAULT_MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_SUMMARY_CHARS = 120;
const MAX_COMPILER_ARTIFACT_SUMMARY_CHARS = 360;
const MAX_OPEN_LOOP_CHARS = 120;
const FILE_PATH_RE =
  /(?:^|[\s`'"])((?:\/|\.\/|\.\.\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]{1,12})(?=$|[\s`'"),.;:])/g;
const COMPILER_DIAGNOSTIC_LINE_RE =
  /(?:^|\n)([^:\n]+\.(?:c|cc|cpp|cxx|h|hpp|hh|m|mm|rs|go|ts|tsx|js|jsx|py):\d+(?::\d+)?:\s*(?:fatal\s+)?(?:error|warning):[^\n]*)/i;
const COMPILER_INTERFACE_DRIFT_RE =
  /\b(?:did you mean|has no member named|unknown type name|incompatible types|undeclared\b|incomplete type|no member named)\b/i;
const OPEN_LOOP_RE =
  /\b(?:todo|next step|remaining|follow[- ]?up|blocked|fix|verify|investigate|unresolved|need to|stub(?:bed)?|not implemented|not started|needs[_ -]?verification|partial|incomplete|placeholder)\b/i;
const FALSE_CLOSURE_SUMMARY_RE =
  /\b(?:no unresolved work|nothing unresolved|no remaining work|all work complete|fully complete|fully implemented)\b/i;
const FALSE_NO_BLOCKER_SUMMARY_RE =
  /\b(?:no blockers?|no explicit blockers?|none identified|nothing blocking|blockers?\s*:\s*none(?: identified)?)\b/i;
const NEGATIVE_STATUS_SUMMARY_RE =
  /\b(?:blocked|blocker|failed|failure|error|invalid command format|file not found|stub(?:bed)?|requires full implementation|full implementation required)\b/i;
const TEST_SIGNAL_RE =
  /\b(?:test|vitest|jest|pytest|failing|passed|assert|coverage)\b/i;
const SUCCESSFUL_TEST_RESULT_RE =
  /\b(?:all tests passed|compilation test passed|tests passed|built target|build succeeded|success(?:fully)? built)\b/i;
const PLAN_SIGNAL_RE =
  /\b(?:plan|todo|roadmap|design|architecture|milestone|workstream)\b/i;
const REVIEW_SIGNAL_RE =
  /\b(?:review|finding|risk|security|regression|critique|audit)\b/i;
const DECISION_SIGNAL_RE =
  /\b(?:decision|decided|root cause|resolved|fix(ed)?|mitigation)\b/i;

interface ArtifactCompactionInput {
  readonly sessionId: string;
  readonly history: readonly LLMMessage[];
  readonly keepTailCount?: number;
  readonly maxArtifacts?: number;
  readonly existingState?: ArtifactCompactionState;
  readonly source: "session_compaction" | "executor_compaction";
  readonly narrativeSummary?: string;
}

interface ArtifactCompactionOutput {
  readonly boundaryMessage: LLMMessage;
  readonly compactedHistory: readonly LLMMessage[];
  readonly state: ArtifactCompactionState;
  readonly records: readonly ContextArtifactRecord[];
  readonly summaryText: string;
}

function cloneMessage(message: LLMMessage): LLMMessage {
  return JSON.parse(JSON.stringify(message)) as LLMMessage;
}

export function createCompactBoundaryMessage(params: {
  readonly boundaryId: string;
  readonly source: "session_compaction" | "executor_compaction";
  readonly sourceMessageCount: number;
  readonly retainedTailCount: number;
  readonly summaryText?: string;
}): LLMMessage {
  const content = [
    `[boundary] replay:${params.boundaryId}`,
    `source=${params.source}`,
    `messages=${params.sourceMessageCount}`,
    `retained=${params.retainedTailCount}`,
    ...(params.summaryText?.trim().length
      ? [`summary=${truncateText(params.summaryText, 240)}`]
      : []),
  ].join(" ");
  return {
    role: "system",
    content,
  };
}

/**
 * True when `message` is a compact boundary marker produced by a prior
 * compaction pass. Used to keep pre-existing boundaries verbatim across
 * subsequent compactions so the prefix (and xAI `prompt_cache_key`
 * match region) stays stable. Anchor-preserved: once a boundary is
 * placed, it is not re-summarized.
 */
export function isCompactBoundaryMessage(message: LLMMessage): boolean {
  if (message.role !== "system") return false;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("");
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("[boundary] replay:") ||
    trimmed.startsWith("[reactive-compact]")
  );
}

/**
 * Split a candidate-for-compaction slice into prior boundary messages
 * (which must be preserved verbatim in the output) and the remaining
 * messages that can be summarized/hashed. Preserving prior boundaries
 * keeps the cacheable prefix stable across successive compactions
 * instead of rehashing it every time.
 */
function partitionBoundariesFromCompactable(
  messages: readonly LLMMessage[],
): {
  readonly priorBoundaries: readonly LLMMessage[];
  readonly compactable: readonly LLMMessage[];
} {
  const priorBoundaries: LLMMessage[] = [];
  const compactable: LLMMessage[] = [];
  for (const message of messages) {
    if (isCompactBoundaryMessage(message)) {
      priorBoundaries.push(message);
      continue;
    }
    compactable.push(message);
  }
  return { priorBoundaries, compactable };
}

function extractText(message: LLMMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, Math.max(0, maxChars));
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function looksLikeCompilerDiagnostic(text: string): boolean {
  return COMPILER_DIAGNOSTIC_LINE_RE.test(text);
}

function extractCompilerDiagnosticExcerpt(
  content: string,
): string | undefined {
  const failureText = extractToolFailureTextFromResult(content).trim();
  if (!looksLikeCompilerDiagnostic(failureText)) {
    return undefined;
  }
  const lines = failureText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      (COMPILER_DIAGNOSTIC_LINE_RE.test(line) ||
        COMPILER_INTERFACE_DRIFT_RE.test(line))
    );
  if (lines.length === 0) {
    return truncateText(failureText, MAX_COMPILER_ARTIFACT_SUMMARY_CHARS);
  }
  return truncateText(
    [...new Set(lines)].slice(0, 4).join(" | "),
    MAX_COMPILER_ARTIFACT_SUMMARY_CHARS,
  );
}

function normalizeArtifactContent(message: LLMMessage): string {
  const raw = extractText(message).replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (message.role === "tool") {
    const compilerExcerpt = extractCompilerDiagnosticExcerpt(raw);
    if (compilerExcerpt) {
      return compilerExcerpt;
    }
  }
  return raw;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function inferKind(message: LLMMessage, content: string): ContextArtifactKind {
  const lowerToolName = message.toolName?.toLowerCase();
  if (lowerToolName?.includes("write") || lowerToolName?.includes("append")) {
    return "file_change";
  }
  if (lowerToolName?.includes("read") || lowerToolName?.includes("list")) {
    return "repo_snapshot";
  }
  if (message.role === "tool" && looksLikeCompilerDiagnostic(content)) {
    return "compiler_diagnostic";
  }
  if (lowerToolName?.includes("bash") && TEST_SIGNAL_RE.test(content)) {
    return "test_result";
  }
  if (message.role === "tool" && TEST_SIGNAL_RE.test(content)) {
    return "test_result";
  }
  if (PLAN_SIGNAL_RE.test(content)) {
    return "plan";
  }
  if (REVIEW_SIGNAL_RE.test(content)) {
    return "review";
  }
  if (DECISION_SIGNAL_RE.test(content)) {
    return "decision";
  }
  if (message.role === "user") {
    return "task_brief";
  }
  if (message.role === "tool") {
    return "tool_result";
  }
  return "conversation_chunk";
}

function extractTags(content: string, kind: ContextArtifactKind): readonly string[] {
  const tags = new Set<string>([kind]);
  let match: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while ((match = FILE_PATH_RE.exec(content)) !== null) {
    tags.add(match[1]!.replace(/^[./]+/, ""));
    if (tags.size >= 6) break;
  }
  if (kind === "compiler_diagnostic" || looksLikeCompilerDiagnostic(content)) {
    tags.add("compiler");
  }
  if (TEST_SIGNAL_RE.test(content)) tags.add("test");
  if (PLAN_SIGNAL_RE.test(content)) tags.add("plan");
  if (REVIEW_SIGNAL_RE.test(content)) tags.add("review");
  if (OPEN_LOOP_RE.test(content)) tags.add("open_loop");
  if (COMPILER_INTERFACE_DRIFT_RE.test(content)) tags.add("interface_drift");
  return [...tags];
}

function extractTitle(message: LLMMessage, content: string, kind: ContextArtifactKind): string {
  const pathMatch = content.match(FILE_PATH_RE);
  if (pathMatch && pathMatch[0]) {
    return pathMatch[0].trim().replace(/^[`'"\s]+|[`'"\s]+$/g, "");
  }
  switch (kind) {
    case "task_brief":
      return "Task brief";
    case "plan":
      return "Planning context";
    case "review":
      return "Review context";
    case "decision":
      return "Decision context";
    case "repo_snapshot":
      return "Workspace snapshot";
    case "compiler_diagnostic":
      return "Compiler diagnostic";
    case "test_result":
      return "Test result";
    case "file_change":
      return "File mutation";
    case "tool_result":
      return message.toolName ? `Tool: ${message.toolName}` : "Tool result";
    default:
      return message.role === "assistant"
        ? "Assistant context"
        : message.role === "user"
        ? "User context"
        : "Conversation context";
  }
}

function scoreArtifact(
  message: LLMMessage,
  content: string,
  kind: ContextArtifactKind,
  index: number,
): number {
  let score = 0;
  if (message.role === "tool") score += 4;
  if (message.role === "assistant") score += 2;
  if (message.role === "user") score += 3;
  if (kind === "file_change") score += 4;
  if (kind === "compiler_diagnostic") score += 6;
  if (kind === "test_result") score += 5;
  if (kind === "plan") score += 4;
  if (kind === "review") score += 4;
  if (kind === "decision") score += 3;
  if (FILE_PATH_RE.test(content)) score += 2;
  if (OPEN_LOOP_RE.test(content)) score += 2;
  score += Math.min(4, Math.floor(content.length / 400));
  score += index / 100;
  FILE_PATH_RE.lastIndex = 0;
  return score;
}

function buildArtifactRecord(params: {
  sessionId: string;
  message: LLMMessage;
  content: string;
  source: "session_compaction" | "executor_compaction";
  createdAt: number;
  index: number;
}): ContextArtifactRecord {
  const kind = inferKind(params.message, params.content);
  const normalizedContent = params.content.replace(/\s+/g, " ").trim();
  const digest = sha256Hex(`${params.message.role}:${params.message.toolName ?? ""}:${normalizedContent}`);
  const summaryLimit =
    kind === "compiler_diagnostic"
      ? MAX_COMPILER_ARTIFACT_SUMMARY_CHARS
      : MAX_ARTIFACT_SUMMARY_CHARS;
  return {
    id: `artifact:${digest.slice(0, 16)}`,
    sessionId: params.sessionId,
    kind,
    title: extractTitle(params.message, normalizedContent, kind),
    summary: truncateText(normalizedContent, summaryLimit),
    content: normalizedContent,
    createdAt: params.createdAt + params.index,
    digest,
    tags: extractTags(normalizedContent, kind),
    source: params.source,
  };
}

function dedupeRecords(
  existingState: ArtifactCompactionState | undefined,
  records: readonly ContextArtifactRecord[],
  maxArtifacts: number,
): readonly ContextArtifactRecord[] {
  const merged = new Map<string, ContextArtifactRecord>();
  for (const artifact of records) {
    merged.set(artifact.digest, artifact);
  }
  if (existingState) {
    for (const ref of existingState.artifactRefs) {
      const digest = ref.digest;
      if (!merged.has(digest)) {
        merged.set(digest, {
          id: ref.id,
          sessionId: existingState.sessionId,
          kind: ref.kind,
          title: ref.title,
          summary: ref.summary,
          content: ref.summary,
          createdAt: ref.createdAt,
          digest,
          tags: ref.tags,
          source: existingState.source,
        });
      }
    }
  }
  return [...merged.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, maxArtifacts);
}

function collectOpenLoops(messages: readonly LLMMessage[]): readonly string[] {
  const loops: string[] = [];
  for (const message of messages) {
    const content = extractText(message).replace(/\s+/g, " ").trim();
    if (!content || !OPEN_LOOP_RE.test(content)) continue;
    loops.push(truncateText(content, MAX_OPEN_LOOP_CHARS));
    if (loops.length >= 4) break;
  }
  return loops;
}

function renderSummaryText(state: ArtifactCompactionState): string {
  const lines: string[] = [
    `[Compacted context snapshot ${state.snapshotId}]`,
  ];
  if (state.narrativeSummary && state.narrativeSummary.trim().length > 0) {
    lines.push(`Summary: ${state.narrativeSummary.trim()}`);
  }
  if (state.sourceMessageCount > 0) {
    lines.push(
      `Compacted ${state.sourceMessageCount} earlier message(s); retained tail count ${state.retainedTailCount}.`,
    );
  }
  if (state.openLoops.length > 0) {
    lines.push("Open loops:");
    for (const openLoop of state.openLoops) {
      lines.push(`- ${openLoop}`);
    }
  }
  return lines.join("\n");
}

function renderArtifactRefsForPrompt(
  state: ArtifactCompactionState,
): readonly string[] {
  return state.artifactRefs
    .slice(0, 8)
    .map((artifact) =>
      `- ${artifact.kind}: ${artifact.title} :: ${artifact.summary}`
    );
}

export function renderArtifactContextPrompt(
  state: ArtifactCompactionState,
): string {
  const lines = [renderSummaryText(state)];
  const artifactLines = renderArtifactRefsForPrompt(state);
  if (artifactLines.length > 0) {
    lines.push("Artifact refs:");
    lines.push(...artifactLines);
  }
  return lines.join("\n");
}

export function buildCompactedHistoryFromState(params: {
  readonly state: ArtifactCompactionState;
  readonly retainedTail: readonly LLMMessage[];
}): readonly LLMMessage[] {
  const boundaryMessage = createCompactBoundaryMessage({
    boundaryId: params.state.snapshotId,
    source: params.state.source,
    sourceMessageCount: params.state.sourceMessageCount,
    retainedTailCount: params.retainedTail.length,
    summaryText: renderSummaryText(params.state),
  });
  return [
    boundaryMessage,
    ...params.retainedTail.map((message) => cloneMessage(message)),
  ];
}

function latestRecordTimestampMatching(
  records: readonly ContextArtifactRecord[],
  predicate: (record: ContextArtifactRecord) => boolean,
): number | undefined {
  let latest: number | undefined;
  for (const record of records) {
    if (!predicate(record)) continue;
    if (latest === undefined || record.createdAt > latest) {
      latest = record.createdAt;
    }
  }
  return latest;
}

function artifactContentLooksBlocking(record: ContextArtifactRecord): boolean {
  return NEGATIVE_STATUS_SUMMARY_RE.test(record.content) || NEGATIVE_STATUS_SUMMARY_RE.test(record.summary);
}

function artifactLooksLikeSuccessfulTest(record: ContextArtifactRecord): boolean {
  return (
    record.kind === "test_result" &&
    (SUCCESSFUL_TEST_RESULT_RE.test(record.content) || SUCCESSFUL_TEST_RESULT_RE.test(record.summary))
  );
}

function sanitizeNarrativeSummary(
  narrativeSummary: string | undefined,
  openLoops: readonly string[],
  selectedRecords: readonly ContextArtifactRecord[],
): string | undefined {
  const normalized = narrativeSummary?.trim();
  if (!normalized) return undefined;
  if (
    openLoops.length > 0 &&
    (FALSE_CLOSURE_SUMMARY_RE.test(normalized) ||
      FALSE_NO_BLOCKER_SUMMARY_RE.test(normalized))
  ) {
    return "Unresolved work remains; rely on the open loops and artifact refs below instead of treating the task as complete.";
  }
  if (NEGATIVE_STATUS_SUMMARY_RE.test(normalized)) {
    const latestSuccessfulTestAt = latestRecordTimestampMatching(
      selectedRecords,
      artifactLooksLikeSuccessfulTest,
    );
    const latestBlockingArtifactAt = latestRecordTimestampMatching(
      selectedRecords,
      artifactContentLooksBlocking,
    );
    const latestFileChangeAt = latestRecordTimestampMatching(
      selectedRecords,
      (record) => record.kind === "file_change",
    );
    const hasSupersedingGroundedEvidence =
      latestSuccessfulTestAt !== undefined &&
      latestFileChangeAt !== undefined &&
      (latestBlockingArtifactAt === undefined || latestSuccessfulTestAt > latestBlockingArtifactAt);
    if (hasSupersedingGroundedEvidence) {
      return "Grounded artifact refs below supersede earlier blockers; rely on the latest file changes, test results, and any open loops instead of stale narrative status.";
    }
  }
  return normalized;
}

function findSafeRetainedTailStartIndex(
  history: readonly LLMMessage[],
  preferredStartIndex: number,
): number {
  let startIndex = Math.min(
    Math.max(0, preferredStartIndex),
    history.length,
  );

  while (startIndex > 0) {
    const candidate = history.slice(startIndex).map((message) =>
      message.role === "tool" &&
      (!message.toolCallId || message.toolCallId.trim().length === 0)
        ? {
            role: "assistant" as const,
            content: extractText(message),
            ...(message.phase ? { phase: message.phase } : {}),
          }
        : message,
    );
    const issue = findToolTurnValidationIssue(candidate);
    if (!issue) {
      return startIndex;
    }
    startIndex -= 1;
  }

  return 0;
}

function resolveRetainedTailStartIndex(
  input: ArtifactCompactionInput,
  keepTailCount: number,
): number {
  const preferredTailStartIndex = Math.max(
    0,
    input.history.length - keepTailCount,
  );
  return findSafeRetainedTailStartIndex(
    input.history,
    preferredTailStartIndex,
  );
}

export function compactHistoryIntoArtifactContext(
  input: ArtifactCompactionInput,
): ArtifactCompactionOutput {
  const keepTailCount = Math.max(1, input.keepTailCount ?? DEFAULT_KEEP_TAIL_COUNT);
  const maxArtifacts = Math.max(1, input.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
  if (input.history.length <= keepTailCount) {
    const emptyState: ArtifactCompactionState = {
      version: 1,
      snapshotId: `snapshot:${sha256Hex(`${input.sessionId}:empty`).slice(0, 16)}`,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      source: input.source,
      historyDigest: sha256Hex(""),
      sourceMessageCount: input.history.length,
      retainedTailCount: input.history.length,
      narrativeSummary: input.narrativeSummary,
      openLoops: [],
      artifactRefs: [],
    };
    const boundaryMessage = createCompactBoundaryMessage({
      boundaryId: emptyState.snapshotId,
      source: input.source,
      sourceMessageCount: input.history.length,
      retainedTailCount: input.history.length,
      summaryText: renderSummaryText(emptyState),
    });
    return {
      boundaryMessage,
      compactedHistory: [boundaryMessage, ...input.history],
      state: emptyState,
      records: [],
      summaryText: renderSummaryText(emptyState),
    };
  }

  const retainedTailStartIndex = resolveRetainedTailStartIndex(
    input,
    keepTailCount,
  );
  const toCompact = input.history.slice(0, retainedTailStartIndex);
  const toKeep = input.history.slice(retainedTailStartIndex);
  // Separate pre-existing boundary messages from the messages that will
  // actually be hashed/summarized into the new boundary. Prior
  // boundaries are preserved verbatim in the output so the cacheable
  // prefix remains byte-identical across successive compactions.
  const { priorBoundaries, compactable: compactableToCompact } =
    partitionBoundariesFromCompactable(toCompact);
  const preservedMessages = collectPreservedMessages(compactableToCompact);
  const now = Date.now();
  const records = compactableToCompact
    .map((message, index) => {
      const normalizedContent = normalizeArtifactContent(message);
      return {
        record: buildArtifactRecord({
          sessionId: input.sessionId,
          message,
          content: normalizedContent,
          source: input.source,
          createdAt: now,
          index,
        }),
        score: scoreArtifact(
          message,
          normalizedContent,
          inferKind(message, normalizedContent),
          index,
        ),
      };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.record)
    .filter((record) => record.summary.length > 0)
    ;

  const selectedRecords = dedupeRecords(
    input.existingState,
    records,
    maxArtifacts,
  );
  const artifactRefs: ContextArtifactRef[] = selectedRecords.map((record) => ({
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
    digest: record.digest,
    tags: record.tags,
  }));
  const historyDigest = sha256Hex(
    compactableToCompact
      .map((message) => `${message.role}:${extractText(message)}`)
      .join("\n"),
  );
  const openLoops = collectOpenLoops(compactableToCompact);
  const narrativeSummary = sanitizeNarrativeSummary(
    input.narrativeSummary && input.narrativeSummary.trim().length > 0
      ? truncateText(input.narrativeSummary, 320)
      : undefined,
    openLoops,
    selectedRecords,
  );
  const state: ArtifactCompactionState = {
    version: 1,
    snapshotId: `snapshot:${historyDigest.slice(0, 16)}`,
    sessionId: input.sessionId,
    createdAt: now,
    source: input.source,
    historyDigest,
    sourceMessageCount: compactableToCompact.length,
    retainedTailCount: toKeep.length,
    ...(narrativeSummary ? { narrativeSummary } : {}),
    openLoops,
    artifactRefs,
  };
  const summaryText = renderSummaryText(state);
  const boundaryMessage = createCompactBoundaryMessage({
    boundaryId: state.snapshotId,
    source: input.source,
    sourceMessageCount: compactableToCompact.length,
    retainedTailCount: toKeep.length,
    summaryText,
  });
  return {
    compactedHistory: [
      ...priorBoundaries,
      boundaryMessage,
      ...preservedMessages,
      ...toKeep,
    ],
    boundaryMessage,
    state,
    records: selectedRecords,
    summaryText,
  };
}
