/**
 * Per-tool result budget + disk persistence (Cut 5.3).
 *
 * Today the runtime truncates large tool results in-memory via
 * `prepareToolResultForPrompt` (~12 KB cap). This module persists
 * oversized results to disk and replaces the wire payload with a
 * 2 KB preview + file path. The model can then use the file path to
 * read the full content if it needs to.
 *
 * This module:
 *   - declares the per-tool `maxResultSizeChars` field shape
 *   - holds a stable `ContentReplacementState` across turns
 *   - persists oversized results to a session-scoped tool-results
 *     directory, defaulting to `~/.agenc/workspace/tool-results/<sessionId>/`
 *
 * @module
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
const PREVIEW_CHARS = 2_000;

export interface ToolBudgetConfig {
  /**
   * Per-tool override of the result-size cap. Tools that already self-
   * bound (like `system.readFile`) should set `Infinity` to opt out.
   */
  readonly maxResultSizeCharsByTool?: Readonly<Record<string, number>>;
  /**
   * Default cap for any tool that does not have a specific override.
   */
  readonly defaultMaxResultSizeChars?: number;
  /**
   * Override for the on-disk root directory. Defaults to
   * `~/.agenc/workspace/tool-results`.
   */
  readonly toolResultsRoot?: string;
}

interface ContentReplacement {
  readonly toolUseId: string;
  readonly diskPath: string;
  readonly originalChars: number;
  readonly preview: string;
}

export interface ContentReplacementState {
  readonly seenIds: ReadonlySet<string>;
  readonly replacements: ReadonlyMap<string, ContentReplacement>;
}

interface ApplyBudgetInput {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly content: string;
  readonly state: ContentReplacementState;
  readonly config?: ToolBudgetConfig;
}

interface ApplyBudgetResult {
  readonly content: string;
  readonly state: ContentReplacementState;
  readonly persisted: boolean;
  readonly diskPath?: string;
}

/**
 * If `content` exceeds the per-tool cap, write it to disk and return
 * a placeholder string the runtime should send to the model in its
 * place. Otherwise return the content unchanged.
 */
export function applyToolResultBudget(input: ApplyBudgetInput): ApplyBudgetResult {
  const cap = resolveCap(input.toolName, input.config);
  if (input.content.length <= cap) {
    return {
      content: input.content,
      state: input.state,
      persisted: false,
    };
  }
  // Idempotent: if we've already persisted this tool_use_id, reuse it.
  const existing = input.state.replacements.get(input.toolUseId);
  if (existing) {
    return {
      content: buildPlaceholder(existing),
      state: input.state,
      persisted: true,
      diskPath: existing.diskPath,
    };
  }
  const root = resolveRoot(input.config);
  const sessionDir = path.join(root, input.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const safeId = input.toolUseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileExt = looksLikeJson(input.content) ? "json" : "txt";
  const diskPath = path.join(sessionDir, `${safeId}.${fileExt}`);
  writeFileSync(diskPath, input.content, "utf8");
  const replacement: ContentReplacement = {
    toolUseId: input.toolUseId,
    diskPath,
    originalChars: input.content.length,
    preview: input.content.slice(0, PREVIEW_CHARS),
  };
  const nextSeen = new Set(input.state.seenIds);
  nextSeen.add(input.toolUseId);
  const nextReplacements = new Map(input.state.replacements);
  nextReplacements.set(input.toolUseId, replacement);
  return {
    content: buildPlaceholder(replacement),
    state: { seenIds: nextSeen, replacements: nextReplacements },
    persisted: true,
    diskPath,
  };
}

function buildPlaceholder(replacement: ContentReplacement): string {
  return [
    "<persisted-output>",
    `Output too large (${replacement.originalChars} chars). Full output saved to: ${replacement.diskPath}`,
    "",
    `Preview (first ${PREVIEW_CHARS} chars):`,
    replacement.preview,
    "</persisted-output>",
  ].join("\n");
}

function resolveCap(toolName: string, config?: ToolBudgetConfig): number {
  const override = config?.maxResultSizeCharsByTool?.[toolName];
  if (typeof override === "number" && Number.isFinite(override)) return override;
  return config?.defaultMaxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
}

function resolveRoot(config?: ToolBudgetConfig): string {
  if (config?.toolResultsRoot) return config.toolResultsRoot;
  return path.join(os.homedir(), ".agenc", "workspace", "tool-results");
}

function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
