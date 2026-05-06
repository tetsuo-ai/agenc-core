/**
 * Source-aligned with `src/services/extractMemories/extractMemories.ts` at
 * donor commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC `LLMMessage` history has no stable UUID, so the extraction cursor
 *     is the count of model-visible messages processed. If compaction shrinks
 *     the visible history, the next extraction falls back to the retained
 *     visible messages instead of permanently disabling extraction.
 *   - Child tool access is enforced by a `ChildToolPolicy` layered inside
 *     `run-agent.ts`, not by the older `canUseTool` hook.
 *
 * Scope boundaries:
 *   - analytics, feature service lookups, team-memory routing, and shell access.
 */

import { basename, isAbsolute, normalize, resolve } from "node:path";
import type { LLMMessage } from "../../llm/types.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type { CompletedToolResultRecord } from "../../session/turn-state.js";
import type {
  ChildToolPolicy,
  RunAgentProgressEvent,
  RunAgentResult,
} from "../../agents/run-agent.js";
import type { delegate as delegateFn } from "../../agents/delegate.js";
import type { ensureAgentControl as ensureAgentControlFn } from "../../bin/delegate-tool.js";
import { SESSION_ALLOWED_ROOTS_ARG } from "../../agents/_deps/filesystem-args.js";
import type { AgentPath } from "../../agents/registry.js";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { formatMemoryManifest, scanMemoryFiles } from "./memory-scan.js";
import {
  AUTO_MEMORY_INDEX_FILE,
  isPathInsideMemoryDir,
  resolveAutoMemoryDirectory,
  type AutoMemoryPathResult,
  type MemoryPathEnv,
  type ResolveAutoMemoryDirectoryOptions,
} from "./memory-paths.js";
import { buildExtractAutoOnlyPrompt } from "./prompts.js";

const READ_TOOL_NAMES = new Set(["FileRead", "Grep", "Glob"]);
const WRITE_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write"]);
const DEFAULT_MAX_TURNS = 5;
const MAX_EXTRACTION_LANES = 256;

export interface ExtractMemoriesContext {
  readonly messages: readonly LLMMessage[];
  readonly completedToolResults: readonly CompletedToolResultRecord[];
  readonly ctx: TurnContext;
  readonly session: Session;
  readonly signal?: AbortSignal;
}

export type AppendSavedMemoriesFn = (paths: readonly string[]) => void;

export interface ExtractMemoriesChildRequest {
  readonly session: Session;
  readonly messages: readonly LLMMessage[];
  readonly prompt: string;
  readonly memoryDir: string;
  readonly toolPolicy: ChildToolPolicy;
  readonly signal?: AbortSignal;
  readonly onProgress: (event: RunAgentProgressEvent) => void | Promise<void>;
}

export interface ExtractMemoriesChildResult {
  readonly outcome: RunAgentResult["outcome"] | "rejected";
  readonly error?: unknown;
}

export interface ExtractMemoriesDependencies {
  readonly env?: MemoryPathEnv;
  readonly resolveMemoryDirectory?: (
    opts: ResolveAutoMemoryDirectoryOptions,
  ) => Promise<AutoMemoryPathResult>;
  readonly runChild?: (
    request: ExtractMemoriesChildRequest,
  ) => Promise<ExtractMemoriesChildResult>;
  readonly scanMemoryFiles?: typeof scanMemoryFiles;
  readonly maxTurns?: number;
  readonly omitIndexFile?: boolean;
  readonly minEligibleTurns?: number;
  readonly delegateFn?: typeof delegateFn;
  readonly ensureAgentControl?: typeof ensureAgentControlFn;
}

interface QueuedExtraction {
  readonly context: ExtractMemoriesContext;
  readonly appendSavedMemories?: AppendSavedMemoriesFn;
}

interface VisibleRange {
  readonly visibleMessages: readonly LLMMessage[];
  readonly unprocessedMessages: readonly LLMMessage[];
  readonly currentVisibleCount: number;
}

interface ExtractionLane {
  processedVisibleCount: number;
  inProgress: boolean;
  lastAccessedAt: number;
  pendingContext: QueuedExtraction | undefined;
  turnsSinceLastExtraction: number;
}

interface ChildWriteTracker {
  readonly savedPaths: Set<string>;
  policyDenied: boolean;
  failedWrite: boolean;
  onProgress(event: RunAgentProgressEvent): void;
}

/** The active extractor function, set by initExtractMemories(). */
let extractor:
  | ((
      context: ExtractMemoriesContext,
      appendSavedMemories?: AppendSavedMemoriesFn,
    ) => Promise<void>)
  | null = null;

/** The active drain function, set by initExtractMemories(). No-op until init. */
let drainer: (timeoutMs?: number) => Promise<void> = async () => {};

function cloneMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
    ...(message.runtimeOnly !== undefined
      ? { runtimeOnly: { ...message.runtimeOnly } }
      : {}),
  };
}

function snapshotContext(context: ExtractMemoriesContext): ExtractMemoriesContext {
  return {
    ...context,
    messages: context.messages.map(cloneMessage),
    completedToolResults: context.completedToolResults.map((record) => ({
      ...record,
      ...(record.metadata !== undefined
        ? { metadata: { ...record.metadata } }
        : {}),
    })),
  };
}

function visibleRange(
  messages: readonly LLMMessage[],
  processedVisibleCount: number,
): VisibleRange {
  const visibleMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const currentVisibleCount = visibleMessages.length;
  const unprocessedMessages =
    currentVisibleCount < processedVisibleCount
      ? visibleMessages
      : visibleMessages.slice(processedVisibleCount);
  return {
    visibleMessages,
    unprocessedMessages,
    currentVisibleCount,
  };
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function memoryRoot(memoryDir: string): string {
  return normalize(memoryDir);
}

function resolveMemoryPath(
  value: unknown,
  memoryDir: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const raw = value.trim();
  const root = memoryRoot(memoryDir);
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  return isPathInsideMemoryDir(candidate, root) ? candidate : null;
}

function resolveDirectMemoryWritePath(
  value: unknown,
  memoryDir: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const raw = value.trim();
  if (!isAbsolute(raw)) return null;
  const root = memoryRoot(memoryDir);
  const candidate = resolve(raw);
  return isPathInsideMemoryDir(candidate, root) ? candidate : null;
}

function withMemoryAllowedRoot(
  input: Record<string, unknown>,
  memoryDir: string,
): Record<string, unknown> {
  const current = Array.isArray(input[SESSION_ALLOWED_ROOTS_ARG])
    ? (input[SESSION_ALLOWED_ROOTS_ARG] as unknown[]).filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  return {
    ...input,
    [SESSION_ALLOWED_ROOTS_ARG]: [...new Set([...current, memoryDir])],
  };
}

function deny(message: string, reason: string): ReturnType<ChildToolPolicy> {
  return {
    behavior: "deny",
    message,
    metadata: { reason },
  };
}

function allowWithMemoryRoot(
  input: Record<string, unknown>,
  memoryDir: string,
): ReturnType<ChildToolPolicy> {
  return {
    behavior: "allow",
    updatedInput: withMemoryAllowedRoot(input, memoryDir),
  };
}

function staticPrefixBeforeGlob(pattern: string): string {
  const index = pattern.search(/[*?[{]/u);
  return index === -1 ? pattern : pattern.slice(0, index);
}

function globPatternStaysInsideMemory(
  pattern: string,
  basePath: string,
  memoryDir: string,
): boolean {
  const prefix = staticPrefixBeforeGlob(pattern);
  const candidate = isAbsolute(pattern)
    ? resolve(prefix.length > 0 ? prefix : pattern)
    : resolve(basePath, prefix.length > 0 ? prefix : ".");
  return isPathInsideMemoryDir(candidate, memoryRoot(memoryDir));
}

export function createAutoMemoryToolPolicy(memoryDir: string): ChildToolPolicy {
  return (tool, input) => {
    if (tool.name === "FileRead") {
      const filePath = resolveMemoryPath(input.file_path, memoryDir);
      if (!filePath) {
        return deny(
          `FileRead is restricted to the memory directory: ${memoryDir}`,
          "file_read_outside_memory",
        );
      }
      return allowWithMemoryRoot({ ...input, file_path: filePath }, memoryDir);
    }

    if (tool.name === "Grep") {
      const rawPath = input.path ?? input.cwd;
      const path =
        rawPath === undefined
          ? memoryRoot(memoryDir)
          : resolveMemoryPath(rawPath, memoryDir);
      if (!path) {
        return deny(
          `Grep is restricted to the memory directory: ${memoryDir}`,
          "grep_outside_memory",
        );
      }
      return allowWithMemoryRoot({ ...input, path }, memoryDir);
    }

    if (tool.name === "Glob") {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const rawPath = input.path ?? input.cwd;
      const path =
        rawPath === undefined
          ? memoryRoot(memoryDir)
          : resolveMemoryPath(rawPath, memoryDir);
      if (!path) {
        return deny(
          `Glob is restricted to the memory directory: ${memoryDir}`,
          "glob_outside_memory",
        );
      }
      if (
        pattern.length > 0 &&
        !globPatternStaysInsideMemory(pattern, path, memoryDir)
      ) {
        return deny(
          `Glob is restricted to the memory directory: ${memoryDir}`,
          "glob_outside_memory",
        );
      }
      return allowWithMemoryRoot({ ...input, path }, memoryDir);
    }

    if (WRITE_TOOL_NAMES.has(tool.name)) {
      const filePath = resolveMemoryPath(input.file_path, memoryDir);
      if (!filePath) {
        return deny(
          `${tool.name} is restricted to the memory directory: ${memoryDir}`,
          "write_outside_memory",
        );
      }
      return allowWithMemoryRoot({ ...input, file_path: filePath }, memoryDir);
    }

    return deny(
      `only ${[...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].join(", ")} are allowed for memory extraction`,
      "tool_not_allowed",
    );
  };
}

export const createAutoMemCanUseTool = createAutoMemoryToolPolicy

function successfulDirectMemoryWrite(
  messages: readonly LLMMessage[],
  completedToolResults: readonly CompletedToolResultRecord[],
  memoryDir: string,
): boolean {
  const completedByCallId = new Map(
    completedToolResults
      .filter((record) => record.isError !== true)
      .map((record) => [record.callId, record]),
  );
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (!WRITE_TOOL_NAMES.has(toolCall.name)) continue;
      const record = completedByCallId.get(toolCall.id);
      if (!record) continue;
      if (record.toolName !== toolCall.name) continue;
      const args = parseToolArguments(toolCall.arguments);
      const filePath = resolveDirectMemoryWritePath(args.file_path, memoryDir);
      if (filePath) return true;
    }
  }
  return false;
}

function createChildWriteTracker(memoryDir: string): ChildWriteTracker {
  const pathsByCallId = new Map<string, string>();
  const savedPaths = new Set<string>();
  return {
    savedPaths,
    policyDenied: false,
    failedWrite: false,
    onProgress(event) {
      if (event.kind === "tool_call" && WRITE_TOOL_NAMES.has(event.toolName)) {
        const args = parseToolArguments(event.arguments);
        const filePath = resolveMemoryPath(args.file_path, memoryDir);
        if (filePath) {
          pathsByCallId.set(event.callId, filePath);
        }
        return;
      }
      if (event.kind !== "tool_result") return;
      if (event.metadata?.childPolicyDenied === true) {
        this.policyDenied = true;
      }
      const writtenPath = pathsByCallId.get(event.callId);
      if (!writtenPath) return;
      if (event.isError) {
        this.failedWrite = true;
        return;
      }
      savedPaths.add(writtenPath);
    },
  };
}

async function defaultRunChild(
  request: ExtractMemoriesChildRequest,
  maxTurns: number,
  deps: Pick<ExtractMemoriesDependencies, "delegateFn" | "ensureAgentControl">,
): Promise<ExtractMemoriesChildResult> {
  const [{ ensureAgentControl }, { delegate }] = await Promise.all([
    deps.ensureAgentControl
      ? Promise.resolve({ ensureAgentControl: deps.ensureAgentControl })
      : import("../../bin/delegate-tool.js"),
    deps.delegateFn
      ? Promise.resolve({ delegate: deps.delegateFn })
      : import("../../agents/delegate.js"),
  ]);
  const { control, registry } = ensureAgentControl(request.session);
  const outcome = await delegate({
    parent: request.session,
    parentPath: "/root" as AgentPath,
    control,
    registry,
    taskPrompt: request.prompt,
    forkMode: { kind: "full_history" },
    parentMessagesOverride: request.messages,
    agentName: "memory-extraction",
    isolation: "none",
    runInBackground: false,
    forceSynchronous: true,
    silent: true,
    childToolPolicy: request.toolPolicy,
    maxTurns,
    externalSignal: request.signal,
    onProgress: async (event) => {
      await request.onProgress(event);
    },
  });

  if (outcome.kind === "rejected") {
    return { outcome: "rejected", error: outcome.reason };
  }
  if (outcome.kind !== "sync_completed") {
    return { outcome: "rejected", error: "memory extraction launched asynchronously" };
  }
  return {
    outcome: outcome.result.outcome,
    ...(outcome.result.error !== undefined ? { error: outcome.result.error } : {}),
  };
}

function extractionDisabledByEnv(env: MemoryPathEnv | undefined): boolean {
  return isEnvTruthy((env ?? process.env).AGENC_DISABLE_EXTRACT_MEMORIES);
}

function isMainAgentContext(ctx: TurnContext): boolean {
  if ((ctx.depth ?? 0) > 0) return false;
  const source = ctx.sessionSource as unknown;
  if (source === "cli_subagent") return false;
  return !(
    typeof source === "object" &&
    source !== null &&
    (source as { kind?: unknown }).kind === "subagent"
  );
}

function resolveMinEligibleTurns(deps: ExtractMemoriesDependencies): number {
  return Math.max(1, Math.trunc(deps.minEligibleTurns ?? 1));
}

export function initExtractMemories(
  deps: ExtractMemoriesDependencies = {},
): void {
  const inFlightExtractions = new Set<Promise<void>>();
  const lanes = new Map<string, ExtractionLane>();
  const fallbackSessionIds = new WeakMap<object, number>();
  let nextFallbackSessionId = 1;

  function sessionLaneKey(session: Session): string {
    const conversationId = (session as { readonly conversationId?: unknown })
      .conversationId;
    if (typeof conversationId === "string" && conversationId.length > 0) {
      return conversationId;
    }
    const sessionObject = session as unknown as object;
    const existing = fallbackSessionIds.get(sessionObject);
    if (existing !== undefined) return `anon:${existing}`;
    const id = nextFallbackSessionId;
    nextFallbackSessionId += 1;
    fallbackSessionIds.set(sessionObject, id);
    return `anon:${id}`;
  }

  function extractionLane(session: Session, memoryDir: string): ExtractionLane {
    const key = `${sessionLaneKey(session)}\0${memoryRoot(memoryDir)}`;
    const existing = lanes.get(key);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }
    const created: ExtractionLane = {
      processedVisibleCount: 0,
      inProgress: false,
      lastAccessedAt: Date.now(),
      pendingContext: undefined,
      turnsSinceLastExtraction: 0,
    };
    lanes.set(key, created);
    return created;
  }

  function pruneIdleLanes(): void {
    if (lanes.size <= MAX_EXTRACTION_LANES) return;
    const idleEntries = [...lanes.entries()]
      .filter(([, lane]) => !lane.inProgress && lane.pendingContext === undefined)
      .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
    for (const [key] of idleEntries) {
      if (lanes.size <= MAX_EXTRACTION_LANES) return;
      lanes.delete(key);
    }
  }

  async function runExtraction(
    queued: QueuedExtraction,
    memoryDir: string,
    lane: ExtractionLane,
    isTrailingRun = false,
  ): Promise<void> {
    const range = visibleRange(
      queued.context.messages,
      lane.processedVisibleCount,
    );
    const newMessageCount = range.unprocessedMessages.length;
    if (newMessageCount === 0) return;

    if (
      successfulDirectMemoryWrite(
        range.unprocessedMessages,
        queued.context.completedToolResults,
        memoryDir,
      )
    ) {
      lane.processedVisibleCount = range.currentVisibleCount;
      return;
    }

    if (!isTrailingRun) {
      lane.turnsSinceLastExtraction += 1;
      if (lane.turnsSinceLastExtraction < resolveMinEligibleTurns(deps)) return;
    }
    lane.turnsSinceLastExtraction = 0;

    const tracker = createChildWriteTracker(memoryDir);
    const existingMemories = formatMemoryManifest(
      await (deps.scanMemoryFiles ?? scanMemoryFiles)(
        memoryDir,
        queued.context.signal,
      ),
    );
    const prompt = buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      deps.omitIndexFile ?? false,
    );
    const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
    const childResult = await (deps.runChild ??
      ((request) => defaultRunChild(request, maxTurns, deps)))({
      session: queued.context.session,
      messages: queued.context.messages,
      prompt,
      memoryDir,
      toolPolicy: createAutoMemoryToolPolicy(memoryDir),
      signal: queued.context.signal,
      onProgress: (event) => tracker.onProgress(event),
    });

    if (
      childResult.outcome !== "completed" ||
      tracker.policyDenied ||
      tracker.failedWrite
    ) {
      return;
    }

    lane.processedVisibleCount = range.currentVisibleCount;
    const savedPaths = [...tracker.savedPaths].filter(
      (path) => basename(path) !== AUTO_MEMORY_INDEX_FILE,
    );
    if (savedPaths.length > 0) {
      queued.appendSavedMemories?.(savedPaths);
    }
  }

  async function executeExtractMemoriesImpl(
    context: ExtractMemoriesContext,
    appendSavedMemories?: AppendSavedMemoriesFn,
  ): Promise<void> {
    if (!isMainAgentContext(context.ctx)) return;
    if (extractionDisabledByEnv(deps.env)) return;

    const queued: QueuedExtraction = {
      context: snapshotContext(context),
      ...(appendSavedMemories !== undefined ? { appendSavedMemories } : {}),
    };
    const pathResult = await (deps.resolveMemoryDirectory ?? resolveAutoMemoryDirectory)({
      env: deps.env,
      cwd: queued.context.ctx.cwd,
    });
    if (!pathResult.enabled || !pathResult.path) return;

    const memoryDir = pathResult.path;
    const lane = extractionLane(queued.context.session, memoryDir);

    if (lane.inProgress) {
      lane.pendingContext = queued;
      return;
    }

    lane.inProgress = true;
    try {
      try {
        await runExtraction(queued, memoryDir, lane);
      } catch {
        // Best effort: extraction failures must never break the user turn.
      }
      while (lane.pendingContext) {
        const trailing = lane.pendingContext;
        lane.pendingContext = undefined;
        try {
          await runExtraction(trailing, memoryDir, lane, true);
        } catch {
          // Best effort.
        }
      }
    } finally {
      lane.inProgress = false;
      lane.lastAccessedAt = Date.now();
      pruneIdleLanes();
    }
  }

  extractor = async (context, appendSavedMemories) => {
    const promise = executeExtractMemoriesImpl(context, appendSavedMemories);
    inFlightExtractions.add(promise);
    try {
      await promise;
    } finally {
      inFlightExtractions.delete(promise);
    }
  };

  drainer = async (timeoutMs = 60_000) => {
    if (inFlightExtractions.size === 0) return;
    await Promise.race([
      Promise.all(inFlightExtractions).catch(() => {}),
      new Promise<void>((resolveTimer) => {
        const timer = setTimeout(resolveTimer, timeoutMs);
        timer.unref?.();
      }),
    ]);
  };
}

export function ensureExtractMemoriesInitialized(
  deps: ExtractMemoriesDependencies = {},
): void {
  if (extractor === null) {
    initExtractMemories(deps);
  }
}

export async function executeExtractMemories(
  context: ExtractMemoriesContext,
  appendSavedMemories?: AppendSavedMemoriesFn,
): Promise<void> {
  ensureExtractMemoriesInitialized();
  await extractor?.(context, appendSavedMemories);
}

export async function drainPendingExtraction(timeoutMs?: number): Promise<void> {
  await drainer(timeoutMs);
}
