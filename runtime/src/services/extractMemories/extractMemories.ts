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
 *     `run-agent.ts`, not by the older `canUseTool` hook, and the child only
 *     ever sees the read/write file tools through `toolAllowlist`.
 *   - Every gate that stops a run and every failed run emits a `warning`
 *     event (`memory_extraction_skipped` / `memory_extraction_failed`) so the
 *     reason is visible in the session log instead of being swallowed.
 *
 * Scope boundaries:
 *   - remote feature-service lookups, team-memory routing, and shell access.
 */

import { basename, isAbsolute, normalize, resolve } from "node:path";
import type { LLMMessage } from "../../llm/types.js";
import {
  cloneLlmMessageSnapshot as cloneMessage,
} from "../../llm/content-conversion.js";
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
import { withSignedAllowedRoots } from "../../agents/_deps/filesystem-args.js";
import type { AgentPath } from "../../agents/registry.js";
import {
  createMemoryExtractionTriggerState,
  DEFAULT_MIN_ELIGIBLE_TURNS,
  hasSuccessfulMemoryWrite,
  isMainMemoryExtractionContext,
  isMemoryExtractionDisabledByEnv,
  memoryExtractionVisibleRange,
  parseMemoryToolArguments,
  shouldDeferForEligibleTurnCadence,
  type MemoryExtractionTriggerState,
} from "../../memory/extraction-triggers.js";
import {
  formatMemoryManifest,
  scanForSecrets,
  scanMemoryFiles,
} from "../../memory/index.js";
import {
  AUTO_MEMORY_INDEX_FILE,
  isPathInsideMemoryDir,
  resolveAutoMemoryDirectory,
  resolveGlobalMemoryDirectory,
  type AutoMemoryPathResult,
  type MemoryPathEnv,
  type ResolveAutoMemoryDirectoryOptions,
} from "./memory-paths.js";
import { buildExtractAutoOnlyPrompt } from "./prompts.js";
import type { MemoryExtractionTriggerPersisted } from "../../session/rollout-item.js";

const READ_TOOL_NAMES = new Set(["FileRead", "Grep", "Glob"]);
const WRITE_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write"]);
/** The only tools the extraction child is offered, before the path policy. */
export const MEMORY_EXTRACTION_TOOL_ALLOWLIST: readonly string[] = [
  ...READ_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
];
/**
 * Delegate agent names must be lowercase letters, digits and underscores
 * (assertValidAgentName); the hyphenated name was rejected at spawn and the
 * extraction never ran.
 */
export const MEMORY_EXTRACTION_AGENT_NAME = "memory_extraction";

const DEFAULT_MAX_TURNS = 5;
const MAX_EXTRACTION_LANES = 256;

type ExtractionWarningCause =
  | "memory_extraction_skipped"
  | "memory_extraction_failed"
  | "memory_extraction_denied_read";

/**
 * Record why an extraction run stopped. Warning causes outside the TUI's
 * user-visible allow-list stay in the session log and observability sinks,
 * so this is diagnostic, not chat noise. Test doubles may not carry an
 * event bus, in which case the note is dropped.
 */
function emitExtractionWarning(
  session: Session,
  cause: ExtractionWarningCause,
  message: string,
): void {
  const bus = session as Partial<Pick<Session, "emit" | "nextInternalSubId">>;
  if (
    typeof bus.emit !== "function" ||
    typeof bus.nextInternalSubId !== "function"
  ) {
    return;
  }
  try {
    bus.emit({
      id: bus.nextInternalSubId(),
      msg: { type: "warning", payload: { cause, message } },
    });
  } catch {
    // Diagnostics must never break the turn.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  trigger: MemoryExtractionTriggerState;
  inProgress: boolean;
  lastAccessedAt: number;
  pendingContext: QueuedExtraction | undefined;
}

interface ChildWriteTracker {
  readonly savedPaths: Set<string>;
  /** A memory write the child wanted was refused by the path policy. */
  policyDeniedWrite: boolean;
  /**
   * Reads outside the memory directory that the policy refused. The child
   * usually probes a wrong directory first (live: two sibling project memory
   * roots the prompt never named) and then finishes correctly; that is not a
   * failed extraction and must not re-queue the messages.
   */
  deniedReads: number;
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

function memoryRoot(memoryDir: string): string {
  return normalize(memoryDir);
}

/**
 * First root that contains `value`, or undefined. Read tools may look in any
 * memory root the session owns; writes stay in one.
 */
function resolveMemoryPathInRoots(
  value: unknown,
  roots: readonly string[],
): string | undefined {
  for (const root of roots) {
    const resolved = resolveMemoryPath(value, root);
    if (resolved) return resolved;
  }
  return undefined;
}

function allowWithMemoryRoots(
  input: Record<string, unknown>,
  roots: readonly string[],
): ReturnType<ChildToolPolicy> {
  return {
    behavior: "allow",
    updatedInput: withSignedAllowedRoots(input, [...roots]),
  };
}

function describeRoots(roots: readonly string[]): string {
  return roots.length === 1
    ? (roots[0] as string)
    : `${roots.join(" or ")}`;
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

function deny(message: string, reason: string): ReturnType<ChildToolPolicy> {
  return {
    behavior: "deny",
    message,
    metadata: { reason },
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

/**
 * The child may READ every memory root the session owns and WRITE only to the
 * project root.
 *
 * Reads were single-root, so the child could not open the global
 * `$AGENC_HOME/memory` index that the main agent reads and writes. Live, it
 * probed that root, was denied, and the run was recorded as a failed
 * extraction. The platform already unions both roots for file tools
 * (`resolveToolAllowedPaths`); only this policy was stricter.
 *
 * Writes stay project-scoped on purpose. The child summarizes untrusted
 * conversation content, and the global root is shared by every project on the
 * machine: a memory planted there from one conversation would reach every
 * later session everywhere. Reading it is enough to stop the duplicate writes
 * that motivated this; extracting `user`-type memories into the global root
 * needs a routing rule and a narrower writer, which is its own change.
 */
export function createAutoMemoryToolPolicy(
  memoryDir: string,
  readOnlyRoots: readonly string[] = [],
): ChildToolPolicy {
  const writeRoot = memoryDir;
  const readRoots = [
    memoryDir,
    ...readOnlyRoots.filter((root) => memoryRoot(root) !== memoryRoot(memoryDir)),
  ];
  return (tool, input) => {
    if (tool.name === "FileRead") {
      const filePath = resolveMemoryPathInRoots(input.file_path, readRoots);
      if (!filePath) {
        return deny(
          `FileRead is restricted to the memory directory: ${describeRoots(readRoots)}`,
          "file_read_outside_memory",
        );
      }
      return allowWithMemoryRoots({ ...input, file_path: filePath }, readRoots);
    }

    if (tool.name === "Grep") {
      const rawPath = input.path ?? input.cwd;
      const path =
        rawPath === undefined
          ? memoryRoot(writeRoot)
          : resolveMemoryPathInRoots(rawPath, readRoots);
      if (!path) {
        return deny(
          `Grep is restricted to the memory directory: ${describeRoots(readRoots)}`,
          "grep_outside_memory",
        );
      }
      return allowWithMemoryRoots({ ...input, path }, readRoots);
    }

    if (tool.name === "Glob") {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const rawPath = input.path ?? input.cwd;
      const path =
        rawPath === undefined
          ? memoryRoot(writeRoot)
          : resolveMemoryPathInRoots(rawPath, readRoots);
      if (!path) {
        return deny(
          `Glob is restricted to the memory directory: ${describeRoots(readRoots)}`,
          "glob_outside_memory",
        );
      }
      if (
        pattern.length > 0 &&
        !readRoots.some((root) => globPatternStaysInsideMemory(pattern, path, root))
      ) {
        return deny(
          `Glob is restricted to the memory directory: ${describeRoots(readRoots)}`,
          "glob_outside_memory",
        );
      }
      return allowWithMemoryRoots({ ...input, path }, readRoots);
    }

    if (WRITE_TOOL_NAMES.has(tool.name)) {
      const filePath = resolveMemoryPath(input.file_path, writeRoot);
      if (!filePath) {
        const readable = resolveMemoryPathInRoots(input.file_path, readRoots);
        return deny(
          readable
            ? `${tool.name} may only write to this session's project memory directory: ${writeRoot}. The other memory roots are readable but not writable from memory extraction.`
            : `${tool.name} is restricted to the memory directory: ${writeRoot}`,
          "write_outside_memory",
        );
      }
      // The child reads the whole conversation including tool output; never
      // let a token it saw there land in plain-text memory.
      const secrets = scanForSecrets(writtenContent(input));
      if (secrets.length > 0) {
        return deny(
          `Content contains potential secrets (${secrets.map((match) => match.label).join(", ")}) and cannot be written to memory. Remove the sensitive content and try again.`,
          "secret_in_memory_write",
        );
      }
      return allowWithMemoryRoots({ ...input, file_path: filePath }, [writeRoot]);
    }

    return deny(
      `only ${[...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].join(", ")} are allowed for memory extraction`,
      "tool_not_allowed",
    );
  };
}


/** Every string a Write, Edit or MultiEdit call would put on disk. */
function writtenContent(input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof input.content === "string") parts.push(input.content);
  if (typeof input.new_string === "string") parts.push(input.new_string);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const candidate = (edit as { new_string?: unknown } | null)?.new_string;
      if (typeof candidate === "string") parts.push(candidate);
    }
  }
  return parts.join("\n");
}

function createChildWriteTracker(memoryDir: string): ChildWriteTracker {
  const pathsByCallId = new Map<string, string>();
  const savedPaths = new Set<string>();
  return {
    savedPaths,
    policyDeniedWrite: false,
    deniedReads: 0,
    failedWrite: false,
    onProgress(event) {
      if (event.kind === "tool_call" && WRITE_TOOL_NAMES.has(event.toolName)) {
        const args = parseMemoryToolArguments(event.arguments);
        const filePath = resolveMemoryPath(args.file_path, memoryDir);
        if (filePath) {
          pathsByCallId.set(event.callId, filePath);
        }
        return;
      }
      if (event.kind !== "tool_result") return;
      if (event.metadata?.childPolicyDenied === true) {
        if (WRITE_TOOL_NAMES.has(event.toolName)) {
          this.policyDeniedWrite = true;
        } else {
          this.deniedReads += 1;
        }
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
    agentName: MEMORY_EXTRACTION_AGENT_NAME,
    isolation: "none",
    runInBackground: false,
    forceSynchronous: true,
    silent: true,
    // The catalog is filtered before the path policy runs, so the child
    // never sees shell, network, or agent tools it would only be denied.
    toolAllowlist: MEMORY_EXTRACTION_TOOL_ALLOWLIST,
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

  async function readSeededTrigger(
    session: Session,
    memoryDir: string,
  ): Promise<MemoryExtractionTriggerState | undefined> {
    const stateLock = session.state;
    if (!stateLock?.with) return undefined;
    return stateLock.with((s) => {
      const stored = (
        s as { memoryExtractionTrigger?: MemoryExtractionTriggerPersisted }
      ).memoryExtractionTrigger;
      if (stored?.memoryRoot !== memoryRoot(memoryDir)) return undefined;
      return {
        processedVisibleCount: stored.processedVisibleCount,
        turnsSinceLastExtraction: stored.turnsSinceLastExtraction,
      };
    });
  }

  async function persistTrigger(
    session: Session,
    trigger: MemoryExtractionTriggerState,
    memoryDir: string,
  ): Promise<void> {
    const snapshot: MemoryExtractionTriggerPersisted = {
      processedVisibleCount: trigger.processedVisibleCount,
      turnsSinceLastExtraction: trigger.turnsSinceLastExtraction,
      memoryRoot: memoryRoot(memoryDir),
    };
    const stateLock = session.state;
    if (stateLock?.with) {
      await stateLock.with((s) => {
        (
          s as { memoryExtractionTrigger?: MemoryExtractionTriggerPersisted }
        ).memoryExtractionTrigger = snapshot;
      });
    }
    const rollout = session.services?.rollout;
    if (!rollout?.record) return;
    await rollout.record({
      type: "session_state",
      payload: { memoryExtractionTrigger: snapshot },
    });
  }

  async function extractionLane(
    session: Session,
    memoryDir: string,
  ): Promise<ExtractionLane> {
    const key = `${sessionLaneKey(session)}\0${memoryRoot(memoryDir)}`;
    const existing = lanes.get(key);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }
    const seeded = await readSeededTrigger(session, memoryDir);
    const raced = lanes.get(key);
    if (raced) {
      raced.lastAccessedAt = Date.now();
      return raced;
    }
    const created: ExtractionLane = {
      trigger: seeded ?? createMemoryExtractionTriggerState(),
      inProgress: false,
      lastAccessedAt: Date.now(),
      pendingContext: undefined,
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
    readOnlyMemoryRoots: readonly string[] = [],
  ): Promise<void> {
    const session = queued.context.session;
    const range: VisibleRange = memoryExtractionVisibleRange(
      queued.context.messages,
      lane.trigger.processedVisibleCount,
    );
    const newMessageCount = range.unprocessedMessages.length;
    if (newMessageCount === 0) {
      emitExtractionWarning(
        session,
        "memory_extraction_skipped",
        "no new model-visible messages since the last extraction",
      );
      return;
    }

    if (
      hasSuccessfulMemoryWrite({
        messages: range.unprocessedMessages,
        completedToolResults: queued.context.completedToolResults,
        writeToolNames: WRITE_TOOL_NAMES,
        resolveMemoryPath: (value) =>
          resolveDirectMemoryWritePath(value, memoryDir),
      })
    ) {
      lane.trigger.processedVisibleCount = range.currentVisibleCount;
      emitExtractionWarning(
        session,
        "memory_extraction_skipped",
        "main agent already wrote memory in this range",
      );
      await persistTrigger(queued.context.session, lane.trigger, memoryDir);
      return;
    }

    const cadence = shouldDeferForEligibleTurnCadence({
      state: lane.trigger,
      minEligibleTurns: deps.minEligibleTurns,
      isTrailingRun,
    });
    if (cadence.defer) {
      emitExtractionWarning(
        session,
        "memory_extraction_skipped",
        `deferred by eligible-turn cadence (${cadence.waiting}/${Math.max(1, Math.trunc(deps.minEligibleTurns ?? DEFAULT_MIN_ELIGIBLE_TURNS))} eligible turns)`,
      );
      await persistTrigger(queued.context.session, lane.trigger, memoryDir);
      return;
    }

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
      memoryDir,
      readOnlyMemoryRoots[0],
    );
    const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
    const childResult = await (deps.runChild ??
      ((request) => defaultRunChild(request, maxTurns, deps)))({
      session: queued.context.session,
      messages: queued.context.messages,
      prompt,
      memoryDir,
      toolPolicy: createAutoMemoryToolPolicy(memoryDir, readOnlyMemoryRoots),
      signal: queued.context.signal,
      onProgress: (event) => tracker.onProgress(event),
    });

    if (
      childResult.outcome !== "completed" ||
      tracker.policyDeniedWrite ||
      tracker.failedWrite
    ) {
      let detail: string;
      if (childResult.outcome !== "completed") {
        detail = "child outcome " + childResult.outcome;
        if (childResult.error !== undefined) {
          detail += ": " + errorText(childResult.error);
        }
      } else if (tracker.policyDeniedWrite) {
        detail = "child tool policy denied a memory write";
      } else {
        detail = "a memory write failed";
      }
      emitExtractionWarning(
        session,
        "memory_extraction_failed",
        detail + "; " + newMessageCount + " message(s) stay queued for the next run",
      );
      await persistTrigger(queued.context.session, lane.trigger, memoryDir);
      return;
    }

    if (tracker.deniedReads > 0) {
      emitExtractionWarning(
        session,
        "memory_extraction_denied_read",
        `child tool policy denied ${tracker.deniedReads} read(s) outside the memory directory; the extraction completed`,
      );
    }
    lane.trigger.processedVisibleCount = range.currentVisibleCount;
    await persistTrigger(queued.context.session, lane.trigger, memoryDir);
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
    // Subagent turns are structurally out of scope; no note, it would fire
    // on every child turn.
    if (!isMainMemoryExtractionContext(context.ctx)) return;
    if (isMemoryExtractionDisabledByEnv(deps.env)) {
      emitExtractionWarning(
        context.session,
        "memory_extraction_skipped",
        "AGENC_DISABLE_EXTRACT_MEMORIES is set",
      );
      return;
    }

    const queued: QueuedExtraction = {
      context: snapshotContext(context),
      ...(appendSavedMemories !== undefined ? { appendSavedMemories } : {}),
    };
    const pathResult = await (deps.resolveMemoryDirectory ?? resolveAutoMemoryDirectory)({
      env: deps.env,
      cwd: queued.context.ctx.cwd,
      configStore: queued.context.session.services?.configStore,
      runtimeOptions: queued.context.session.services.runtimeOptions,
    });
    // The main agent reads and writes a machine-wide memory root too. The
    // child could not open it, so it probed, was denied, and the run was
    // recorded as a failed extraction. It may read that root to avoid
    // duplicating what is already there; it still writes only to this
    // session's project root.
    const globalMemoryRoot = await resolveGlobalMemoryDirectory({
      env: deps.env,
      cwd: queued.context.ctx.cwd,
      configStore: queued.context.session.services?.configStore,
      runtimeOptions: queued.context.session.services.runtimeOptions,
    }).catch(() => undefined);
    if (!pathResult.enabled || !pathResult.path) {
      emitExtractionWarning(
        queued.context.session,
        "memory_extraction_skipped",
        `memory directory unavailable (${pathResult.reason ?? "disabled"})`,
      );
      return;
    }

    const memoryDir = pathResult.path;
    const readOnlyMemoryRoots =
      globalMemoryRoot === undefined ? [] : [globalMemoryRoot];
    const lane = await extractionLane(queued.context.session, memoryDir);

    if (lane.inProgress) {
      lane.pendingContext = queued;
      return;
    }

    lane.inProgress = true;
    try {
      try {
        await runExtraction(queued, memoryDir, lane, false, readOnlyMemoryRoots);
      } catch (error) {
        // Best effort: extraction failures must never break the user turn,
        // but they must not vanish either.
        emitExtractionWarning(
          queued.context.session,
          "memory_extraction_failed",
          errorText(error),
        );
      }
      while (lane.pendingContext) {
        const trailing = lane.pendingContext;
        lane.pendingContext = undefined;
        try {
          await runExtraction(trailing, memoryDir, lane, true, readOnlyMemoryRoots);
        } catch (error) {
          emitExtractionWarning(
            trailing.context.session,
            "memory_extraction_failed",
            `trailing run: ${errorText(error)}`,
          );
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
