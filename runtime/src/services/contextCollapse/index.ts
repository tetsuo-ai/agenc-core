import { randomUUID } from "crypto";
import type { QuerySource } from "../../constants/querySource.js";
import type { Message } from "../../types/message.js";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { logForDebugging } from "../../utils/debug.js";
import { createUserMessage } from "../../utils/messages.js";
import { getSettings_DEPRECATED } from "../../utils/settings/settings.js";
import { getContextWindowForModel } from "../../utils/context.js";
import { tokenCountWithEstimation } from "../../utils/tokens.js";
import {
  recordContextCollapseCommit,
  recordContextCollapseSnapshot,
} from "../../utils/sessionStorage.js";
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from "../../types/logs.js";

export interface ContextCollapseResult {
  readonly committed: number;
  readonly messages: ReadonlyArray<Message>;
}

export interface ContextCollapseHealth {
  readonly totalSpawns: number;
  readonly totalErrors: number;
  readonly totalEmptySpawns: number;
  readonly emptySpawnWarningEmitted: boolean;
  readonly lastError?: string;
}

export interface ContextCollapseStats {
  readonly collapsedSpans: number;
  readonly collapsedMessages: number;
  readonly stagedSpans: number;
  readonly health: ContextCollapseHealth;
}

export interface ContextCollapseSnapshot {
  readonly sessionId: string;
  readonly committed: number;
  readonly collapsedMessages: number;
  readonly querySource?: QuerySource;
  readonly messages: ReadonlyArray<Message>;
}

export interface ContextCollapseState {
  readonly stats: ContextCollapseStats;
  readonly stagedBySession: ReadonlyMap<string, ContextCollapseSnapshot>;
}

export interface ContextCollapseRuntimeService {
  readonly isContextCollapseEnabled: () => boolean;
  readonly isEnabled: () => boolean;
  readonly getContextCollapseState: () => ContextCollapseState;
  readonly getStats: () => ContextCollapseStats;
  readonly subscribe: (listener: () => void) => () => void;
  readonly resetContextCollapse: () => void;
  readonly maybeCollapseContext: (
    messages: ReadonlyArray<Message>,
    ctx?: { readonly session?: { readonly conversationId?: string } | null },
  ) => ReadonlyArray<Message>;
  readonly recoverFromOverflow: (
    messages: ReadonlyArray<Message>,
    querySource?: QuerySource,
    ctx?: { readonly session?: { readonly conversationId?: string } | null },
  ) => ContextCollapseResult;
}

type AnyMessage = Message & {
  uuid?: string;
  type?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
  content?: unknown;
};

type CommittedCollapse = ContextCollapseCommitEntry & {
  archived: AnyMessage[];
};

type StagedCollapse = ContextCollapseSnapshotEntry["staged"][number];

type CollapseHealth = {
  totalSpawns: number;
  totalErrors: number;
  totalEmptySpawns: number;
  lastError?: string;
  emptySpawnWarningEmitted: boolean;
};

type DonorContextCollapseState = {
  commits: CommittedCollapse[];
  staged: StagedCollapse[];
  armed: boolean;
  lastSpawnTokens: number;
  health: CollapseHealth;
  nextCollapseId: number;
};

const EMPTY_SESSION_KEY = "__context_collapse_default__";
const COMMIT_THRESHOLD = 0.9;
const KEEP_RECENT_MESSAGES = 8;
const MIN_COLLAPSE_MESSAGES = 4;
const EMPTY_SPAWN_WARNING_THRESHOLD = 3;
const subscribers = new Set<() => void>();
const manuallyStagedBySession = new Map<string, ContextCollapseSnapshot>();

const EMPTY_HEALTH = (): CollapseHealth => ({
  totalSpawns: 0,
  totalErrors: 0,
  totalEmptySpawns: 0,
  lastError: undefined,
  emptySpawnWarningEmitted: false,
});

let state: DonorContextCollapseState = {
  commits: [],
  staged: [],
  armed: false,
  lastSpawnTokens: 0,
  health: EMPTY_HEALTH(),
  nextCollapseId: 1,
};

const EMPTY_STATS: ContextCollapseStats = Object.freeze({
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: Object.freeze({
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  }),
});

function emitChange(): void {
  for (const subscriber of subscribers) subscriber();
}

export function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function replaceState(next: DonorContextCollapseState): void {
  state = next;
  emitChange();
}

function patchState(
  updater: (current: DonorContextCollapseState) => DonorContextCollapseState,
): void {
  replaceState(updater(state));
}

function resolveSessionId(
  ctx?: { readonly session?: { readonly conversationId?: string } | null },
): string {
  return ctx?.session?.conversationId ?? EMPTY_SESSION_KEY;
}

function cloneMessages(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> {
  return messages.map((message) => ({ ...message }));
}

function getModelFromToolUseContext(toolUseContext: unknown): string {
  const model =
    typeof toolUseContext === "object" &&
    toolUseContext &&
    "options" in toolUseContext &&
    typeof toolUseContext.options === "object" &&
    toolUseContext.options &&
    "mainLoopModel" in toolUseContext.options
      ? (toolUseContext.options.mainLoopModel as string | undefined)
      : undefined;
  return model || "claude-sonnet-4-6";
}

function getMessageUuid(message: AnyMessage): string | undefined {
  return typeof message?.uuid === "string" ? message.uuid : undefined;
}

function extractPlainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return typeof item.text === "string" ? item.text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function summarizeMessage(message: AnyMessage): string {
  if (message.type === "system") {
    return extractPlainText(message.content);
  }
  if (message && typeof message === "object" && "message" in message) {
    return extractPlainText(message.message?.content);
  }
  return extractPlainText(message.content);
}

function buildSummary(archived: AnyMessage[]): string {
  const previews = archived
    .map(summarizeMessage)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  const prefix = `Earlier conversation collapsed (${archived.length} messages).`;
  if (previews.length === 0) return prefix;
  return `${prefix} ${previews.join(" | ").slice(0, 240)}`;
}

function makeCollapseId(nextCollapseId: number): string {
  return String(nextCollapseId).padStart(16, "0");
}

function buildSummaryContent(collapseId: string, summary: string): string {
  return `<collapsed id="${collapseId}">${summary}</collapsed>`;
}

function buildSummaryMessage(
  summaryUuid: string,
  summaryContent: string,
): AnyMessage {
  return createUserMessage({
    content: summaryContent,
    isMeta: true,
    uuid: summaryUuid,
  }) as unknown as AnyMessage;
}

function applyCommitProjection(
  inputMessages: AnyMessage[],
  commit: CommittedCollapse,
): AnyMessage[] {
  const startIndex = inputMessages.findIndex(
    (message) => getMessageUuid(message) === commit.firstArchivedUuid,
  );
  const endIndex = inputMessages.findIndex(
    (message) => getMessageUuid(message) === commit.lastArchivedUuid,
  );

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex < startIndex ||
    inputMessages.some(
      (message) => getMessageUuid(message) === commit.summaryUuid,
    )
  ) {
    return inputMessages;
  }

  const archived = inputMessages.slice(startIndex, endIndex + 1);
  if (archived.length === 0) {
    return inputMessages;
  }

  commit.archived = archived;

  return [
    ...inputMessages.slice(0, startIndex),
    buildSummaryMessage(commit.summaryUuid, commit.summaryContent),
    ...inputMessages.slice(endIndex + 1),
  ];
}

function projectCommitted(messages: AnyMessage[]): AnyMessage[] {
  return state.commits.reduce(
    (currentMessages, commit) => applyCommitProjection(currentMessages, commit),
    messages,
  );
}

function getCollapsedMessageCount(): number {
  return state.commits.reduce(
    (total, commit) => total + (commit.archived.length || 0),
    0,
  );
}

function buildStatsSnapshot(): ContextCollapseStats {
  const stagedSpans = state.staged.length + manuallyStagedBySession.size;
  if (
    state.commits.length === 0 &&
    getCollapsedMessageCount() === 0 &&
    stagedSpans === 0 &&
    state.health.totalSpawns === 0 &&
    state.health.totalErrors === 0 &&
    state.health.totalEmptySpawns === 0 &&
    !state.health.emptySpawnWarningEmitted &&
    state.health.lastError === undefined
  ) {
    return EMPTY_STATS;
  }
  return {
    collapsedSpans: state.commits.length,
    collapsedMessages: getCollapsedMessageCount(),
    stagedSpans,
    health: {
      totalSpawns: state.health.totalSpawns,
      totalErrors: state.health.totalErrors,
      totalEmptySpawns: state.health.totalEmptySpawns,
      emptySpawnWarningEmitted: state.health.emptySpawnWarningEmitted,
      ...(state.health.lastError !== undefined
        ? { lastError: state.health.lastError }
        : {}),
    },
  };
}

function chooseCollapseSpan(messages: AnyMessage[]): {
  startIndex: number;
  endIndex: number;
  archived: AnyMessage[];
} | null {
  const firstCandidate = messages.findIndex(
    (message) => message.type !== "system" && !message.isMeta,
  );
  if (firstCandidate === -1) return null;

  const available = messages.length - KEEP_RECENT_MESSAGES - firstCandidate;
  if (available < MIN_COLLAPSE_MESSAGES) return null;

  const spanLength = Math.max(
    MIN_COLLAPSE_MESSAGES,
    Math.floor(available / 2),
  );
  const startIndex = firstCandidate;
  const endIndex = Math.min(
    messages.length - KEEP_RECENT_MESSAGES - 1,
    startIndex + spanLength - 1,
  );
  if (endIndex <= startIndex) return null;

  const archived = messages.slice(startIndex, endIndex + 1);
  if (archived.length < MIN_COLLAPSE_MESSAGES) return null;

  return { startIndex, endIndex, archived };
}

async function persistStateSnapshot(): Promise<void> {
  await recordContextCollapseSnapshot({
    staged: state.staged,
    armed: state.armed,
    lastSpawnTokens: state.lastSpawnTokens,
  });
}

async function commitSpan(
  messages: AnyMessage[],
  span: { startIndex: number; endIndex: number; archived: AnyMessage[] },
): Promise<{ messages: AnyMessage[]; committed: number }> {
  const collapseId = makeCollapseId(state.nextCollapseId);
  const summaryUuid = randomUUID();
  const summary = buildSummary(span.archived);
  const summaryContent = buildSummaryContent(collapseId, summary);
  const firstArchivedUuid = getMessageUuid(span.archived[0]!);
  const lastArchivedUuid = getMessageUuid(span.archived.at(-1)!);

  if (!firstArchivedUuid || !lastArchivedUuid) {
    return { messages, committed: 0 };
  }

  const commit: CommittedCollapse = {
    type: "marble-origami-commit",
    sessionId: "" as never,
    collapseId,
    summaryUuid,
    summaryContent,
    summary,
    firstArchivedUuid,
    lastArchivedUuid,
    archived: span.archived,
  };

  patchState((current) => ({
    ...current,
    commits: [...current.commits, commit],
    staged: [],
    armed: false,
    nextCollapseId: current.nextCollapseId + 1,
    health: {
      ...current.health,
      totalSpawns: current.health.totalSpawns + 1,
      totalEmptySpawns: 0,
      emptySpawnWarningEmitted: false,
    },
  }));

  await recordContextCollapseCommit({
    collapseId,
    summaryUuid,
    summaryContent,
    summary,
    firstArchivedUuid,
    lastArchivedUuid,
  });
  await persistStateSnapshot();

  const projected = [
    ...messages.slice(0, span.startIndex),
    buildSummaryMessage(summaryUuid, summaryContent),
    ...messages.slice(span.endIndex + 1),
  ];

  logForDebugging(
    `[context-collapse] committed ${collapseId} covering ${span.archived.length} messages`,
  );

  return { messages: projected, committed: 1 };
}

function noteEmptySpawn(): void {
  patchState((current) => {
    const totalEmptySpawns = current.health.totalEmptySpawns + 1;
    return {
      ...current,
      health: {
        ...current.health,
        totalSpawns: current.health.totalSpawns + 1,
        totalEmptySpawns,
        emptySpawnWarningEmitted:
          totalEmptySpawns >= EMPTY_SPAWN_WARNING_THRESHOLD,
      },
    };
  });
}

function noteError(error: unknown): void {
  patchState((current) => ({
    ...current,
    health: {
      ...current.health,
      totalSpawns: current.health.totalSpawns + 1,
      totalErrors: current.health.totalErrors + 1,
      lastError: error instanceof Error ? error.message : String(error),
    },
  }));
}

function isExplicitlyDisabled(): boolean {
  const raw = process.env.CLAUDE_CONTEXT_COLLAPSE;
  return raw === "0" || raw === "false";
}

function isConfiguredEnabled(): boolean {
  if (isExplicitlyDisabled()) return false;
  if (isEnvTruthy(process.env.CLAUDE_CONTEXT_COLLAPSE)) return true;
  return getSettings_DEPRECATED()?.contextManagementStrategy === "collapse";
}

export function isContextCollapseEnabled(): boolean {
  return (
    isConfiguredEnabled() ||
    state.commits.length > 0 ||
    state.staged.length > 0 ||
    manuallyStagedBySession.size > 0
  );
}

export function getStats(): ContextCollapseStats {
  return buildStatsSnapshot();
}

export function getContextCollapseState(): ContextCollapseState {
  return {
    stats: getStats(),
    stagedBySession: new Map(
      [...manuallyStagedBySession.entries()].map(([sessionId, snapshot]) => [
        sessionId,
        {
          ...snapshot,
          messages: cloneMessages(snapshot.messages),
        },
      ]),
    ),
  };
}

export function resetContextCollapse(): void {
  manuallyStagedBySession.clear();
  replaceState({
    commits: [],
    staged: [],
    armed: false,
    lastSpawnTokens: 0,
    health: EMPTY_HEALTH(),
    nextCollapseId: 1,
  });
}

export function stageContextCollapseForSession(
  sessionId: string,
  messages: ReadonlyArray<Message>,
  opts: {
    readonly committed?: number;
    readonly collapsedMessages?: number;
    readonly querySource?: QuerySource;
  } = {},
): void {
  manuallyStagedBySession.set(sessionId, {
    sessionId,
    committed: Math.max(1, opts.committed ?? 1),
    collapsedMessages: Math.max(0, opts.collapsedMessages ?? 0),
    querySource: opts.querySource,
    messages: cloneMessages(messages),
  });
  emitChange();
}

export function projectView(
  messages: ReadonlyArray<Message>,
  ctx?: { readonly session?: { readonly conversationId?: string } | null },
): ReadonlyArray<Message> {
  const staged = manuallyStagedBySession.get(resolveSessionId(ctx));
  if (staged) {
    return cloneMessages(staged.messages);
  }
  return projectCommitted([...messages] as AnyMessage[]);
}

export function maybeCollapseContext(
  messages: ReadonlyArray<Message>,
  ctx?: { readonly session?: { readonly conversationId?: string } | null },
): ReadonlyArray<Message> {
  return projectView(messages, ctx);
}

export async function applyCollapsesIfNeeded(
  messages: ReadonlyArray<Message>,
  toolUseContext?: unknown,
  _querySource?: QuerySource,
): Promise<{ readonly messages: ReadonlyArray<Message>; readonly committed: number }> {
  if (!isContextCollapseEnabled()) {
    return { messages, committed: 0 };
  }

  const projected = projectCommitted([...messages] as AnyMessage[]);
  const model = getModelFromToolUseContext(toolUseContext);
  const tokenCount = tokenCountWithEstimation(projected as never);
  const contextWindow = getContextWindowForModel(model);
  const threshold = Math.floor(contextWindow * COMMIT_THRESHOLD);

  patchState((current) => ({
    ...current,
    armed: tokenCount >= threshold,
    lastSpawnTokens: tokenCount,
  }));

  if (tokenCount < threshold) {
    return { messages: projected, committed: 0 };
  }

  try {
    const span = chooseCollapseSpan(projected);
    if (!span) {
      noteEmptySpawn();
      await persistStateSnapshot();
      return { messages: projected, committed: 0 };
    }
    return await commitSpan(projected, span);
  } catch (error) {
    noteError(error);
    await persistStateSnapshot();
    return { messages: projected, committed: 0 };
  }
}

export function recoverFromOverflow(
  messages: ReadonlyArray<Message>,
  querySource?: QuerySource,
  ctx?: { readonly session?: { readonly conversationId?: string } | null },
): ContextCollapseResult {
  const sessionId = resolveSessionId(ctx);
  const staged = manuallyStagedBySession.get(sessionId);
  if (staged) {
    manuallyStagedBySession.delete(sessionId);
    patchState((current) => ({
      ...current,
      health: {
        ...current.health,
        totalSpawns: current.health.totalSpawns + 1,
        totalEmptySpawns: 0,
        emptySpawnWarningEmitted: false,
      },
    }));
    emitChange();
    void querySource;
    return {
      committed: staged.committed,
      messages: cloneMessages(staged.messages),
    };
  }

  if (!isContextCollapseEnabled()) {
    return { messages, committed: 0 };
  }

  const projected = projectCommitted([...messages] as AnyMessage[]);
  const span = chooseCollapseSpan(projected);
  if (!span) {
    noteEmptySpawn();
    void persistStateSnapshot();
    return { messages: projected, committed: 0 };
  }

  const collapseId = makeCollapseId(state.nextCollapseId);
  const summaryUuid = randomUUID();
  const summary = buildSummary(span.archived);
  const summaryContent = buildSummaryContent(collapseId, summary);
  const firstArchivedUuid = getMessageUuid(span.archived[0]!);
  const lastArchivedUuid = getMessageUuid(span.archived.at(-1)!);
  if (!firstArchivedUuid || !lastArchivedUuid) {
    return { messages: projected, committed: 0 };
  }

  const commit: CommittedCollapse = {
    type: "marble-origami-commit",
    sessionId: "" as never,
    collapseId,
    summaryUuid,
    summaryContent,
    summary,
    firstArchivedUuid,
    lastArchivedUuid,
    archived: span.archived,
  };

  patchState((current) => ({
    ...current,
    commits: [...current.commits, commit],
    staged: [],
    armed: false,
    nextCollapseId: current.nextCollapseId + 1,
    health: {
      ...current.health,
      totalSpawns: current.health.totalSpawns + 1,
      totalEmptySpawns: 0,
      emptySpawnWarningEmitted: false,
    },
  }));

  void recordContextCollapseCommit({
    collapseId,
    summaryUuid,
    summaryContent,
    summary,
    firstArchivedUuid,
    lastArchivedUuid,
  }).then(() => persistStateSnapshot());

  void querySource;
  return {
    messages: [
      ...projected.slice(0, span.startIndex),
      buildSummaryMessage(summaryUuid, summaryContent),
      ...projected.slice(span.endIndex + 1),
    ],
    committed: 1,
  };
}

export function isWithheldPromptTooLong(
  message: unknown,
  isPromptTooLongMessage?: (message: unknown) => boolean,
  querySource?: string,
): boolean {
  if (!isContextCollapseEnabled()) return false;
  if (querySource === "compact" || querySource === "session_memory") {
    return false;
  }
  return Boolean(isPromptTooLongMessage?.(message));
}

export function getContextVisualizationData() {
  return {
    commits: state.commits.map((commit) => ({
      collapseId: commit.collapseId,
      summary: commit.summary,
      archivedMessages: commit.archived.length,
    })),
    staged: state.staged,
    health: state.health,
  };
}

export function getContextCollapseSnapshot():
  | ContextCollapseSnapshotEntry
  | undefined {
  if (
    state.staged.length === 0 &&
    state.armed === false &&
    state.lastSpawnTokens === 0
  ) {
    return undefined;
  }
  return {
    type: "marble-origami-snapshot",
    sessionId: "" as never,
    staged: state.staged,
    armed: state.armed,
    lastSpawnTokens: state.lastSpawnTokens,
  };
}

export function getContextCollapseCommits(): ContextCollapseCommitEntry[] {
  return state.commits.map(({ archived: _archived, ...commit }) => commit);
}

export function restoreContextCollapseState(
  commits: ContextCollapseCommitEntry[],
  snapshot?: ContextCollapseSnapshotEntry,
): void {
  const maxCollapseId = commits.reduce((max, entry) => {
    const parsed = Number.parseInt(entry.collapseId, 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);

  replaceState({
    commits: commits.map((commit) => ({
      ...commit,
      archived: [],
    })),
    staged: snapshot?.staged ?? [],
    armed: snapshot?.armed ?? false,
    lastSpawnTokens: snapshot?.lastSpawnTokens ?? 0,
    health: EMPTY_HEALTH(),
    nextCollapseId: maxCollapseId + 1,
  });
}

export const contextCollapseService: ContextCollapseRuntimeService =
  Object.freeze({
    isContextCollapseEnabled,
    isEnabled: isContextCollapseEnabled,
    getContextCollapseState,
    getStats,
    subscribe,
    resetContextCollapse,
    maybeCollapseContext,
    recoverFromOverflow,
  });
