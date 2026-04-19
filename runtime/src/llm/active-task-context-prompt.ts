/**
 * Injects the current `ActiveTaskContext` into the model's prompt as a
 * compact system-reminder user message.
 *
 * Sibling of `task-reminder.ts`. Unlike the task reminder (which throttles
 * on turn-count), this block is a "current state" signal: it surfaces
 * the workspace and artifact fields that back workflow ownership so the
 * model can reason about which files the current task is supposed to
 * read or write.
 *
 * Dedup strategy: each block carries a fingerprint derived from the
 * context's `contractFingerprint`. `shouldInjectActiveTaskContext`
 * scans the most recent matching header in history and skips injection
 * when the fingerprint matches the current context. This means:
 *   - first turn with a context: inject.
 *   - follow-up turns with the same context: no duplicate.
 *   - when the context changes: a new block is injected with the new
 *     fingerprint, so the model always sees the freshest state.
 *
 * Only the fields the model can act on are surfaced: `workspaceRoot`,
 * `displayArtifact`, `sourceArtifacts`, `targetArtifacts`. `turnClass`
 * and `ownerMode` stay internal to the runtime contract because they
 * are validator-facing, not model-facing.
 *
 * @module
 */

import type { ActiveTaskContext } from "./turn-execution-contract-types.js";
import type { LLMMessage } from "./types.js";

export const ACTIVE_TASK_CONTEXT_HEADER_PREFIX =
  "The current task context is:";

const FINGERPRINT_TAG_PREFIX = "context-fingerprint:";
const ARTIFACT_LIST_LIMIT = 8;

function stringContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function extractMostRecentFingerprint(
  history: readonly LLMMessage[],
): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "user") continue;
    const content = stringContent(message);
    if (!content.includes(ACTIVE_TASK_CONTEXT_HEADER_PREFIX)) continue;
    const marker = content.indexOf(FINGERPRINT_TAG_PREFIX);
    if (marker === -1) return "";
    const tail = content.slice(marker + FINGERPRINT_TAG_PREFIX.length);
    const end = tail.search(/[\s>]/);
    return end === -1 ? tail : tail.slice(0, end);
  }
  return undefined;
}

export interface ShouldInjectActiveTaskContextParams {
  readonly history: readonly LLMMessage[];
  readonly activeTaskContext: ActiveTaskContext | undefined;
}

export function shouldInjectActiveTaskContext(
  params: ShouldInjectActiveTaskContextParams,
): boolean {
  if (!params.activeTaskContext) return false;
  const fingerprint = params.activeTaskContext.contractFingerprint;
  if (!fingerprint) return true;
  const previous = extractMostRecentFingerprint(params.history);
  if (previous === undefined) return true;
  return previous !== fingerprint;
}

function truncatedArtifactList(
  artifacts: readonly string[],
  max: number,
): string {
  if (artifacts.length === 0) return "(none)";
  if (artifacts.length <= max) return artifacts.join(", ");
  const visible = artifacts.slice(0, max).join(", ");
  const extra = artifacts.length - max;
  return `${visible}, ... (+${extra} more)`;
}

export function buildActiveTaskContextMessage(
  context: ActiveTaskContext,
): LLMMessage {
  const lines: string[] = [ACTIVE_TASK_CONTEXT_HEADER_PREFIX];
  if (context.workspaceRoot) {
    lines.push(`- workspaceRoot: ${context.workspaceRoot}`);
  }
  if (context.displayArtifact) {
    lines.push(`- displayArtifact: ${context.displayArtifact}`);
  }
  lines.push(
    `- sourceArtifacts: ${truncatedArtifactList(
      context.sourceArtifacts,
      ARTIFACT_LIST_LIMIT,
    )}`,
  );
  lines.push(
    `- targetArtifacts: ${truncatedArtifactList(
      context.targetArtifacts,
      ARTIFACT_LIST_LIMIT,
    )}`,
  );
  const body = lines.join("\n");
  const fingerprint = context.contractFingerprint ?? "";
  const content =
    `<system-reminder>\n${body}\n` +
    `<${FINGERPRINT_TAG_PREFIX}${fingerprint}>\n</system-reminder>`;
  return {
    role: "user",
    content,
    runtimeOnly: { mergeBoundary: "user_context", anchorPreserve: true },
  };
}
