/**
 * Ports upstream runtime `core/src/realtime_context.rs` startup-context
 * assembly onto AgenC conversation history and workspace primitives.
 *
 * Shape difference from upstream:
 *   - The builder is dependency-injected so daemon methods can supply
 *     session history, thread-store rows, and workspace readers without
 *     coupling this pure formatter to app-server services.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ResponseItem } from "../../session/rollout-item.js";
import { isContextualUserMessageContent } from "../../session/rollout-reconstruction.js";

export const REALTIME_STARTUP_CONTEXT_TOKEN_BUDGET = 5_300;
export const REALTIME_TURN_TOKEN_BUDGET = 300;

const STARTUP_CONTEXT_HEADER =
  "Startup context from AgenC.\n" +
  "This is background context about recent work and machine/workspace layout. " +
  "It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.";
const STARTUP_CONTEXT_OPEN_TAG = "<startup_context>";
const STARTUP_CONTEXT_CLOSE_TAG = "</startup_context>";
const CURRENT_THREAD_SECTION_TOKEN_BUDGET = 1_200;
const RECENT_WORK_SECTION_TOKEN_BUDGET = 2_200;
const WORKSPACE_SECTION_TOKEN_BUDGET = 1_600;
const NOTES_SECTION_TOKEN_BUDGET = 300;
const MAX_RECENT_THREADS = 40;
const MAX_RECENT_WORK_GROUPS = 8;
const MAX_CURRENT_CWD_ASKS = 8;
const MAX_OTHER_CWD_ASKS = 5;
const MAX_ASK_CHARS = 240;
const TREE_MAX_DEPTH = 2;
const DIR_ENTRY_LIMIT = 20;
const APPROX_BYTES_PER_TOKEN = 4;

const NOISY_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface RealtimeRecentThread {
  readonly cwd: string;
  readonly updatedAt: Date | string | number;
  readonly firstUserMessage?: string | null;
  readonly gitBranch?: string | null;
}

export interface RealtimeWorkspaceEntry {
  readonly name: string;
  readonly type: "directory" | "file" | "symlink";
  readonly readable?: boolean;
}

export interface RealtimeStartupContextOptions {
  readonly conversationId?: string;
  readonly history: ReadonlyArray<ResponseItem>;
  readonly cwd: string;
  readonly recentThreads?: ReadonlyArray<RealtimeRecentThread>;
  readonly userRoot?: string | null;
  readonly budgetTokens?: number;
  readonly resolveWorkspaceRoot?: (
    cwd: string,
  ) => string | null | Promise<string | null>;
  readonly readDirectory?: (
    path: string,
  ) => ReadonlyArray<RealtimeWorkspaceEntry> | null | Promise<ReadonlyArray<RealtimeWorkspaceEntry> | null>;
}

export interface RealtimeStartupContextSessionLike {
  readonly conversationId?: string;
  readonly cwd?: string;
  readonly config?: { readonly cwd?: string };
  readonly sessionConfiguration?: { readonly cwd?: string };
  readonly snapshotHistoryMessages?: () => ReadonlyArray<ResponseItem>;
  readonly state?: {
    readonly unsafePeek?: () => {
      readonly history?: ReadonlyArray<ResponseItem>;
      readonly sessionConfiguration?: { readonly cwd?: string };
    };
  };
}

export async function buildRealtimeStartupContext(
  options: RealtimeStartupContextOptions,
): Promise<string | null> {
  const budgetTokens = positiveInteger(
    options.budgetTokens,
    REALTIME_STARTUP_CONTEXT_TOKEN_BUDGET,
  );
  const currentThreadSection = buildCurrentThreadSection(options.history);
  const recentThreads = [...(options.recentThreads ?? [])]
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left))
    .slice(0, MAX_RECENT_THREADS);
  const recentWorkSection = await buildRecentWorkSection({
    cwd: options.cwd,
    recentThreads,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
  });
  const workspaceSection = await buildWorkspaceSection({
    cwd: options.cwd,
    userRoot: options.userRoot ?? homedir(),
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    readDirectory: options.readDirectory,
  });

  if (
    currentThreadSection === null &&
    recentWorkSection === null &&
    workspaceSection === null
  ) {
    return null;
  }

  const parts = [STARTUP_CONTEXT_HEADER];
  const current = formatSection(
    "Current Thread",
    currentThreadSection,
    CURRENT_THREAD_SECTION_TOKEN_BUDGET,
  );
  if (current !== null) parts.push(current);
  const recent = formatSection(
    "Recent Work",
    recentWorkSection,
    RECENT_WORK_SECTION_TOKEN_BUDGET,
  );
  if (recent !== null) parts.push(recent);
  const workspace = formatSection(
    "Machine / Workspace Map",
    workspaceSection,
    WORKSPACE_SECTION_TOKEN_BUDGET,
  );
  if (workspace !== null) parts.push(workspace);
  const notes = formatSection(
    "Notes",
    "Built at realtime startup from the current thread history, local thread metadata, and a bounded local workspace scan. This excludes repo memory instructions and memory summaries.",
    NOTES_SECTION_TOKEN_BUDGET,
  );
  if (notes !== null) parts.push(notes);

  return formatBudgetedStartupContextBlob(parts.join("\n\n"), budgetTokens);
}

export async function buildRealtimeStartupContextFromSession(
  session: RealtimeStartupContextSessionLike,
  options: Omit<RealtimeStartupContextOptions, "history" | "cwd" | "conversationId"> = {},
): Promise<string | null> {
  const state = session.state?.unsafePeek?.();
  const history =
    session.snapshotHistoryMessages?.() ??
    state?.history ??
    [];
  const cwd =
    session.cwd ??
    session.config?.cwd ??
    session.sessionConfiguration?.cwd ??
    state?.sessionConfiguration?.cwd;
  if (cwd === undefined || cwd.length === 0) {
    throw new Error("realtime startup context requires a session cwd");
  }
  return buildRealtimeStartupContext({
    ...options,
    conversationId: session.conversationId,
    cwd,
    history,
  });
}

export function buildCurrentThreadSection(
  history: ReadonlyArray<ResponseItem>,
): string | null {
  const turns: Array<{ user: string[]; assistant: string[] }> = [];
  let currentUser: string[] = [];
  let currentAssistant: string[] = [];

  for (const item of history) {
    if (item.role === "user") {
      if (isContextualUserMessageContent(item.content)) continue;
      const text = contentToText(item.content)?.trim();
      if (!text) continue;
      if (currentUser.length > 0 || currentAssistant.length > 0) {
        turns.push({ user: currentUser, assistant: currentAssistant });
        currentUser = [];
        currentAssistant = [];
      }
      currentUser.push(text);
      continue;
    }
    if (item.role === "assistant") {
      const text = contentToText(item.content)?.trim();
      if (!text) continue;
      if (currentUser.length === 0 && currentAssistant.length === 0) continue;
      currentAssistant.push(text);
    }
  }

  if (currentUser.length > 0 || currentAssistant.length > 0) {
    turns.push({ user: currentUser, assistant: currentAssistant });
  }
  if (turns.length === 0) return null;

  const lines = [
    "Most recent user/assistant turns from this exact thread. Use them for continuity when responding.",
  ];
  let remainingBudget = CURRENT_THREAD_SECTION_TOKEN_BUDGET - approxTokenCount(lines.join("\n"));
  let retainedTurnCount = 0;

  for (const [index, turn] of turns.slice().reverse().entries()) {
    if (remainingBudget <= 0) break;
    const turnLines = [index === 0 ? "### Latest turn" : `### Previous turn ${index}`];
    if (turn.user.length > 0) {
      turnLines.push("User:");
      turnLines.push(turn.user.join("\n\n"));
    }
    if (turn.assistant.length > 0) {
      turnLines.push("");
      turnLines.push("Assistant:");
      turnLines.push(turn.assistant.join("\n\n"));
    }

    const turnText = truncateRealtimeTextToTokenBudget(
      turnLines.join("\n"),
      Math.min(REALTIME_TURN_TOKEN_BUDGET, remainingBudget),
    );
    const turnTokens = approxTokenCount(turnText);
    if (turnTokens === 0) continue;
    lines.push("");
    lines.push(turnText);
    remainingBudget -= turnTokens;
    retainedTurnCount += 1;
  }

  return retainedTurnCount > 0 ? lines.join("\n") : null;
}

export function truncateRealtimeTextToTokenBudget(
  text: string,
  budgetTokens: number,
): string {
  const budget = Math.max(0, Math.floor(budgetTokens));
  if (budget === 0) return "";
  if (approxTokenCount(text) <= budget) return text;
  const maxChars = budget * APPROX_BYTES_PER_TOKEN;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

async function buildRecentWorkSection(opts: {
  readonly cwd: string;
  readonly recentThreads: ReadonlyArray<RealtimeRecentThread>;
  readonly resolveWorkspaceRoot?: RealtimeStartupContextOptions["resolveWorkspaceRoot"];
}): Promise<string | null> {
  if (opts.recentThreads.length === 0) return null;
  const currentGroup = await groupRootFor(opts.cwd, opts.resolveWorkspaceRoot);
  const groups = new Map<string, RealtimeRecentThread[]>();
  for (const entry of opts.recentThreads) {
    const group = await groupRootFor(entry.cwd, opts.resolveWorkspaceRoot);
    const groupEntries = groups.get(group) ?? [];
    groupEntries.push(entry);
    groups.set(group, groupEntries);
  }

  const sortedGroups = [...groups.entries()].sort((left, right) => {
    const [leftGroup, leftEntries] = left;
    const [rightGroup, rightEntries] = right;
    const leftCurrent = leftGroup === currentGroup ? 0 : 1;
    const rightCurrent = rightGroup === currentGroup ? 0 : 1;
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
    const latestDiff = latestUpdatedAt(rightEntries) - latestUpdatedAt(leftEntries);
    if (latestDiff !== 0) return latestDiff;
    return leftGroup.localeCompare(rightGroup);
  });

  const sections: string[] = [];
  for (const [group, entries] of sortedGroups.slice(0, MAX_RECENT_WORK_GROUPS)) {
    const section = formatThreadGroup(currentGroup, group, entries);
    if (section !== null) sections.push(section);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

async function buildWorkspaceSection(opts: {
  readonly cwd: string;
  readonly userRoot: string | null;
  readonly resolveWorkspaceRoot?: RealtimeStartupContextOptions["resolveWorkspaceRoot"];
  readonly readDirectory?: RealtimeStartupContextOptions["readDirectory"];
}): Promise<string | null> {
  const gitRoot = await groupRootFor(opts.cwd, opts.resolveWorkspaceRoot);
  const cwdTree = await renderTree(opts.cwd, opts.readDirectory);
  const gitRootTree =
    gitRoot !== opts.cwd ? await renderTree(gitRoot, opts.readDirectory) : null;
  const userRootTree =
    opts.userRoot !== null && opts.userRoot !== opts.cwd && opts.userRoot !== gitRoot
      ? await renderTree(opts.userRoot, opts.readDirectory)
      : null;

  if (cwdTree === null && gitRoot === opts.cwd && userRootTree === null) {
    return null;
  }

  const lines = [
    `Current working directory: ${opts.cwd}`,
    `Working directory name: ${fileNameString(opts.cwd)}`,
  ];
  if (gitRoot !== opts.cwd) {
    lines.push(`Git root: ${gitRoot}`);
    lines.push(`Git project: ${fileNameString(gitRoot)}`);
  }
  if (opts.userRoot !== null) {
    lines.push(`User root: ${opts.userRoot}`);
  }
  appendTree(lines, "Working directory tree:", cwdTree);
  appendTree(lines, "Git root tree:", gitRootTree);
  appendTree(lines, "User root tree:", userRootTree);
  return lines.join("\n");
}

async function renderTree(
  root: string,
  readDirectory: RealtimeStartupContextOptions["readDirectory"] = defaultReadDirectory,
): Promise<string[] | null> {
  const lines: string[] = [];
  await collectTreeLines(root, 0, lines, readDirectory);
  return lines.length > 0 ? lines : null;
}

async function collectTreeLines(
  dir: string,
  depth: number,
  lines: string[],
  readDirectory: NonNullable<RealtimeStartupContextOptions["readDirectory"]>,
): Promise<void> {
  if (depth >= TREE_MAX_DEPTH) return;
  const entries = await readDirectory(dir);
  if (entries === null) return;
  const visible = entries.filter((entry) => !isNoisyName(entry.name));
  visible.sort((left, right) => {
    const leftFileRank = left.type === "directory" ? 0 : 1;
    const rightFileRank = right.type === "directory" ? 0 : 1;
    if (leftFileRank !== rightFileRank) return leftFileRank - rightFileRank;
    return left.name.localeCompare(right.name);
  });

  const shown = visible.slice(0, DIR_ENTRY_LIMIT);
  for (const entry of shown) {
    const indent = "  ".repeat(depth);
    const suffix =
      entry.type === "directory" ? "/" : entry.type === "symlink" ? "@" : "";
    lines.push(`${indent}- ${entry.name}${suffix}`);
    if (entry.type === "directory" && entry.readable !== false) {
      await collectTreeLines(join(dir, entry.name), depth + 1, lines, readDirectory);
    }
  }

  if (visible.length > DIR_ENTRY_LIMIT) {
    lines.push(`${"  ".repeat(depth)}- ... ${visible.length - DIR_ENTRY_LIMIT} more entries`);
  }
}

async function defaultReadDirectory(
  path: string,
): Promise<ReadonlyArray<RealtimeWorkspaceEntry> | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "file",
    }));
  } catch {
    return null;
  }
}

function appendTree(
  lines: string[],
  title: string,
  tree: ReadonlyArray<string> | null,
): void {
  if (tree === null) return;
  lines.push("");
  lines.push(title);
  lines.push(...tree);
}

async function groupRootFor(
  cwd: string,
  resolver: RealtimeStartupContextOptions["resolveWorkspaceRoot"],
): Promise<string> {
  return (await resolver?.(cwd)) ?? cwd;
}

function formatThreadGroup(
  currentGroup: string,
  group: string,
  entries: ReadonlyArray<RealtimeRecentThread>,
): string | null {
  const sorted = [...entries].sort((left, right) => updatedAtMs(right) - updatedAtMs(left));
  const latest = sorted[0];
  if (!latest) return null;
  const lines = [
    `${group === currentGroup ? "### Current workspace" : "### Workspace"}: ${group}`,
    `Recent sessions: ${sorted.length}`,
    `Latest activity: ${new Date(updatedAtMs(latest)).toISOString()}`,
  ];
  if (latest.gitBranch) lines.push(`Latest branch: ${latest.gitBranch}`);
  lines.push("");
  lines.push("User asks:");

  const seen = new Set<string>();
  const maxAsks = group === currentGroup ? MAX_CURRENT_CWD_ASKS : MAX_OTHER_CWD_ASKS;
  for (const entry of sorted) {
    const ask = normalizeAsk(entry.firstUserMessage);
    if (ask === null) continue;
    const dedupeKey = `${group}:${ask}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    lines.push(`- ${entry.cwd}: ${limitChars(ask, MAX_ASK_CHARS)}`);
    if (seen.size >= maxAsks) break;
  }

  return lines.length > 5 ? lines.join("\n") : null;
}

function contentToText(content: ResponseItem["content"]): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("") : null;
}

function normalizeAsk(message: string | null | undefined): string | null {
  const ask = (message ?? "").split(/\s+/).filter(Boolean).join(" ");
  return ask.length > 0 ? ask : null;
}

function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatBudgetedStartupContextBlob(
  body: string,
  budgetTokens: number,
): string {
  const wrapperTokens = approxTokenCount(formatStartupContextBlob(""));
  const bodyBudget = Math.max(0, budgetTokens - wrapperTokens);
  return formatStartupContextBlob(
    truncateRealtimeTextToTokenBudget(body, bodyBudget),
  );
}

function formatSection(
  title: string,
  body: string | null,
  budgetTokens: number,
): string | null {
  const trimmed = body?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const heading = `## ${title}\n`;
  const bodyBudget = Math.max(0, budgetTokens - approxTokenCount(heading));
  if (bodyBudget === 0) return null;
  const renderedBody = truncateRealtimeTextToTokenBudget(trimmed, bodyBudget);
  if (renderedBody.length === 0) return null;
  return `${heading}${renderedBody}`;
}

function formatStartupContextBlob(body: string): string {
  return `${STARTUP_CONTEXT_OPEN_TAG}\n${body}\n${STARTUP_CONTEXT_CLOSE_TAG}`;
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / APPROX_BYTES_PER_TOKEN);
}

function latestUpdatedAt(entries: ReadonlyArray<RealtimeRecentThread>): number {
  return entries.reduce((latest, entry) => Math.max(latest, updatedAtMs(entry)), 0);
}

function updatedAtMs(entry: RealtimeRecentThread): number {
  const value = entry.updatedAt;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileNameString(path: string): string {
  return basename(path) || path;
}

function isNoisyName(name: string): boolean {
  return name.startsWith(".") || NOISY_DIR_NAMES.has(name);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
