/**
 * runAgent — drive one subagent's run-turn loop.
 *
 * Hand-port of the donor subagent runner subset. Responsibilities:
 *
 *   1. Build a child Session from the parent + fork context.
 *   2. Initialize MCP servers (30s wait, cancellable — I-50).
 *   3. Run session-start hooks.
 *   4. Invoke the child's run-turn loop.
 *   5. Emit progress to the parent via the upInbox (I-5).
 *   6. Clean up: MCP shutdown, caches, bash task kills.
 *
 * This module intentionally keeps the surface small — delegate.ts
 * wraps it with worktree + approval + permissions flow. run-agent
 * is the "run the child's turn machine" primitive.
 *
 * @module
 */

import { normalize } from "node:path";
import { LRUCache } from "lru-cache";
import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMProviderStartupPrewarmHandle,
  LLMProviderStartupPrewarmParams,
  LLMTool,
  LLMUsage,
} from "../llm/types.js";
import type {
  CacheSafeParams,
  REPLHookContext,
} from "../services/PromptSuggestion/runtime.js";
import { createCacheSafeParams } from "../services/PromptSuggestion/runtime.js";
import { llmMessageToAgentSummaryMessage } from "../services/AgentSummary/transcript.js";
import type { StartupPrewarmStore } from "../session/startup-prewarm.js";
import {
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";
import type {
  ToolRegistry,
  ToolDispatchResult,
} from "./_deps/tool-registry.js";
import {
  safeStringify,
  type Tool,
  type ToolRecoveryCategory,
} from "./_deps/tools-types.js";
import {
  withSignedAllowedRoots,
  withSignedSessionId,
} from "./_deps/filesystem-args.js";
import { Session as ChildSession, type Session } from "../session/session.js";
import { RolloutStore } from "../session/rollout-store.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  threadConfigSnapshot,
  type ReasoningEffort,
  type TurnContext,
} from "../session/turn-context.js";
import type { LiveAgent } from "./control.js";
import {
  isAgentExitedSentinel,
  MailboxClosedError,
  type InterAgentCommunication,
} from "./mailbox.js";
import type { AgentRoleConfig } from "./role.js";
import type { WorktreeHandle } from "./worktree.js";
import { emitWarning } from "../session/event-log.js";
import type { ThreadId } from "./registry.js";
import { formatSubagentNotification, isFinal } from "./status.js";
import { asRecord } from "../utils/record.js";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface RunAgentParams {
  readonly live: LiveAgent;
  readonly parent: Session;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly taskPrompt: string;
  readonly worktree?: WorktreeHandle;
  /** Tool allowlist — filters the parent's catalog. Default: all. */
  readonly toolAllowlist?: ReadonlyArray<string>;
  /** Per-turn timeout override (from role config). */
  readonly timeoutMs?: number;
  /** Optional child model override. */
  readonly model?: string;
  /** Optional child reasoning-effort override. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Optional child service-tier override. */
  readonly serviceTier?: string;
  /** Optional AbortSignal merged with the live agent's controller. */
  readonly externalSignal?: AbortSignal;
  /** Optional per-call child tool policy layered after allowlist filtering. */
  readonly childToolPolicy?: ChildToolPolicy;
  /** Query source label for the child session. Defaults to the inherited source. */
  readonly querySource?: string;
  /** Optional per-child turn cap. */
  readonly maxTurns?: number;
  /** Suppress parent mailbox notifications and child rollout recording. */
  readonly silent?: boolean;
  /** Captured once the child turn has the exact cache-safe request state. */
  readonly onCacheSafeParams?: (params: CacheSafeParams) => void;
  /**
   * Keep the agent loop alive between turns. When the model has finished
   * a turn and the mailbox is empty, the loop normally breaks and the
   * thread exits. With `keepAlive: true`, the loop waits on the next
   * mailbox event (or close / abort) before resuming. Used for the
   * daemon's TUI agent so subsequent message.stream calls land on the
   * same live agent instead of getting AGENT_NOT_FOUND.
   */
  readonly keepAlive?: boolean;
}

export type ChildToolPolicyDecision =
  | {
      readonly behavior: "allow";
      readonly updatedInput?: Record<string, unknown>;
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly metadata?: Record<string, unknown>;
    };

export type ChildToolPolicy = (
  tool: Pick<Tool, "name">,
  input: Record<string, unknown>,
) => ChildToolPolicyDecision | Promise<ChildToolPolicyDecision>;

export type RunAgentProgressEvent =
  | { readonly kind: "status"; readonly text: string }
  | {
      readonly kind: "message";
      readonly message: LLMMessage;
      /**
       * Marks the message as a replay of the agent's initial fork
       * context (initialMessages from RunAgentParams), not a fresh
       * turn message. Daemon observability recorders consume these
       * for replay parity, but TUI transcripts MUST suppress them or
       * the parent's chat shows the subagent's prompt as if the user
       * had typed it.
       */
      readonly isInitialReplay?: boolean;
    }
  | {
      readonly kind: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly arguments?: string;
      readonly recoveryCategory?: ToolRecoveryCategory;
    }
  | {
      readonly kind: "tool_result";
      readonly callId: string;
      readonly toolName: string;
      readonly result: string;
      readonly isError: boolean;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: "usage_update";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | {
      readonly kind: "run_complete";
      readonly finalMessage?: string;
      readonly toolCallCount: number;
    }
  | {
      /**
       * Emitted between turns in a keepAlive run, before the agent loop
       * waits on its mailbox for the next user message. Equivalent to
       * `run_complete` for the just-finished turn but does NOT terminate
       * the run. The runner translates this to a daemon `turn_complete`
       * event so the TUI's transcript reducer can flip isStreaming and
       * stop the busy-spinner between turns.
       */
      readonly kind: "turn_complete";
      readonly finalMessage?: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "turn_interrupted";
      readonly reason: string;
      readonly turnId: string;
    }
  | { readonly kind: "run_error"; readonly error: string }
  | { readonly kind: "run_interrupted"; readonly reason: string };

export interface RunAgentResult {
  readonly threadId: ThreadId;
  readonly finalMessage?: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "errored" | "interrupted" | "aborted";
  readonly error?: unknown;
  /** Number of tool-call intents observed on the assistant reply. */
  readonly toolCallCount?: number;
}

// ─────────────────────────────────────────────────────────────────────
// MCP init with cancellation (I-50)
// ─────────────────────────────────────────────────────────────────────

export const MCP_INIT_TIMEOUT_MS = 30_000;
const MCP_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_AGENT_DEPTH = 1;
const FORK_READ_FILE_STATE_CACHE_SIZE = 100;
const FORK_READ_FILE_STATE_MAX_SIZE_BYTES = 25 * 1024 * 1024;

interface ForkFileState {
  readonly content: string;
  readonly timestamp: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly isPartialView?: boolean;
}

class ForkCompatibleFileStateCache {
  private readonly cache = new LRUCache<string, ForkFileState>({
    max: FORK_READ_FILE_STATE_CACHE_SIZE,
    maxSize: FORK_READ_FILE_STATE_MAX_SIZE_BYTES,
    sizeCalculation: (value) =>
      Math.max(1, Buffer.byteLength(value.content, "utf8")),
  });

  get(key: string): ForkFileState | undefined {
    return this.cache.get(normalize(key));
  }

  set(key: string, value: ForkFileState): this {
    this.cache.set(normalize(key), value);
    return this;
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key));
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key));
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get max(): number {
    return this.cache.max;
  }

  get maxSize(): number {
    return this.cache.maxSize;
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize;
  }

  keys(): Generator<string> {
    return this.cache.keys();
  }

  entries(): Generator<[string, ForkFileState]> {
    return this.cache.entries();
  }

  dump(): ReturnType<LRUCache<string, ForkFileState>["dump"]> {
    return this.cache.dump();
  }

  load(entries: ReturnType<LRUCache<string, ForkFileState>["dump"]>): void {
    this.cache.load(entries);
  }
}

interface RoleLikeConfig {
  readonly requiredMcpServers?: ReadonlyArray<string>;
}

/**
 * Minimal shape we lean on from the session to check MCP readiness.
 * T10 will extend SessionServices with a first-class mcpManager
 * surface; currently we read it defensively off `session.services`.
 */
interface McpManagerLike {
  isConnected(name: string): boolean;
}

function readParentServices(parent: Session): Record<string, unknown> | null {
  return asRecord((parent as unknown as { readonly services?: unknown }).services);
}

function readMcpManager(parent: Session): McpManagerLike | undefined {
  const services = readParentServices(parent);
  const raw = asRecord(services?.mcpManager);
  return typeof raw?.isConnected === "function"
    ? (raw as unknown as McpManagerLike)
    : undefined;
}

/**
 * Wait for MCP servers to be ready. I-50: cancellable via abort
 * signal; on abort, resolve immediately with `reason: 'aborted'`.
 *
 * Branches:
 *   - No `requiredMcpServers` → resolve `ready: true` on next
 *     microtask (preserve current "trust session boot" semantics).
 *   - No `mcpManager` attached → same as above (cannot poll; T9 today).
 *   - Otherwise poll `isConnected(name)` every 500ms until every
 *     required server reports ready, the overall timeout fires, or
 *     the caller aborts.
 */
export async function initMcpForAgent(opts: {
  readonly parent: Session;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly roleConfig?: RoleLikeConfig;
}): Promise<{ readonly ready: boolean; readonly reason?: string }> {
  const timeout = opts.timeoutMs ?? MCP_INIT_TIMEOUT_MS;
  const required = opts.roleConfig?.requiredMcpServers ?? [];

  if (opts.signal.aborted) {
    return { ready: false, reason: "aborted" };
  }

  // No required servers → immediate ready.
  if (required.length === 0) {
    await Promise.resolve();
    return { ready: true };
  }

  const mcpManager = readMcpManager(opts.parent);
  // No manager attached → fall back to session-boot trust.
  if (!mcpManager) {
    await Promise.resolve();
    return { ready: true };
  }

  return new Promise<{ ready: boolean; reason?: string }>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (value: { ready: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => settle({ ready: false, reason: "aborted" });
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const check = () => {
      if (settled) return;
      for (const name of required) {
        if (!mcpManager.isConnected(name)) {
          pollTimer = setTimeout(check, MCP_POLL_INTERVAL_MS);
          return;
        }
      }
      settle({ ready: true });
    };

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      // Identify the first server still missing for richer diagnostics.
      const missing = required.find((n) => !mcpManager.isConnected(n));
      settle(
        missing
          ? { ready: false, reason: `missing_server:${missing}` }
          : { ready: false, reason: "timeout" },
      );
    }, timeout);

    check();
  });
}

// ─────────────────────────────────────────────────────────────────────
// runAgent — main entry
// ─────────────────────────────────────────────────────────────────────

function providerFromParent(parent: Session): LLMProvider | undefined {
  const services = readParentServices(parent);
  const provider = asRecord(services?.provider);
  return typeof provider?.chat === "function"
    ? (provider as unknown as LLMProvider)
    : undefined;
}

function buildChatOptions(
  signal: AbortSignal,
  roleConfig: AgentRoleConfig,
  timeoutOverrideMs?: number,
): LLMChatOptions {
  const opts: {
    -readonly [K in keyof LLMChatOptions]: LLMChatOptions[K];
  } = { signal };
  // Only forward reasoning-effort values the provider options type
  // accepts — AgentRole allows "none", LLMChatOptions does not.
  if (roleConfig.reasoningEffort && roleConfig.reasoningEffort !== "none") {
    opts.reasoningEffort = roleConfig.reasoningEffort;
  }
  const effectiveTimeout = timeoutOverrideMs ?? roleConfig.timeoutMs;
  if (typeof effectiveTimeout === "number" && effectiveTimeout > 0) {
    opts.timeoutMs = effectiveTimeout;
  }
  return opts as LLMChatOptions;
}

interface AgentSummaryProviderRequest {
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly options: LLMChatOptions;
}

type AgentSummaryProviderRequestCapture = (
  request: AgentSummaryProviderRequest,
) => void;

function captureAgentSummaryProviderRequest(
  capture: AgentSummaryProviderRequestCapture,
  messages: LLMMessage[],
  options?: LLMChatOptions,
): void {
  capture({
    messages: messages.map((message) => ({ ...message })),
    options: options ?? {},
  });
}

function wrapStartupPrewarmHandleForAgentSummary(
  handle: LLMProviderStartupPrewarmHandle,
  capture: AgentSummaryProviderRequestCapture,
): LLMProviderStartupPrewarmHandle {
  return {
    ...handle,
    chatStream(messages, onChunk, options) {
      captureAgentSummaryProviderRequest(capture, messages, options);
      return handle.chatStream(messages, onChunk, options);
    },
  };
}

function wrapStartupPrewarmForAgentSummary(
  store: StartupPrewarmStore,
  capture: AgentSummaryProviderRequestCapture,
): StartupPrewarmStore {
  return {
    setProviderHandle(handle) {
      store.setProviderHandle(
        wrapStartupPrewarmHandleForAgentSummary(handle, capture),
      );
    },
    setProviderTask(task, opts) {
      store.setProviderTask(
        Promise.resolve(task).then((handle) =>
          handle
            ? wrapStartupPrewarmHandleForAgentSummary(handle, capture)
            : undefined,
        ),
        opts,
      );
    },
    async consumeProviderHandle(opts) {
      const handle = await store.consumeProviderHandle(opts);
      return handle
        ? wrapStartupPrewarmHandleForAgentSummary(handle, capture)
        : undefined;
    },
    expireProviderHandle: () => store.expireProviderHandle(),
    clear: () => store.clear(),
  };
}

function wrapProviderForAgentSummary(
  provider: LLMProvider,
  capture: AgentSummaryProviderRequestCapture,
): LLMProvider {
  return {
    ...provider,
    chatStream(messages, onChunk, options) {
      captureAgentSummaryProviderRequest(capture, messages, options);
      return provider.chatStream(messages, onChunk, options);
    },
    ...(provider.prewarmStartup !== undefined
      ? {
          prewarmStartup(params: LLMProviderStartupPrewarmParams) {
            const prewarm = provider.prewarmStartup?.(params);
            if (
              !prewarm ||
              typeof (prewarm as Promise<unknown>).then !== "function"
            ) {
              return prewarm
                ? wrapStartupPrewarmHandleForAgentSummary(
                    prewarm as LLMProviderStartupPrewarmHandle,
                    capture,
                  )
                : prewarm;
            }
            return Promise.resolve(prewarm).then((handle) =>
              handle
                ? wrapStartupPrewarmHandleForAgentSummary(handle, capture)
                : handle,
            );
          },
        }
      : {}),
  };
}

interface AgentRunContext {
  readonly abortController: AbortController;
  readonly agentId?: string;
  readonly sessionId: string;
  readonly options: {
    readonly mainLoopModel: string;
    readonly tools: readonly AgentRuntimeTool[];
    readonly mcpClients: readonly unknown[];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly providerOverride?: {
      readonly model: string;
      readonly baseURL: string;
      readonly apiKey: string;
    };
    readonly querySource?: string;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly isNonInteractiveSession: boolean;
    readonly cwd?: string;
    readonly verbose: boolean;
  };
  readonly getAppState: () => {
    readonly toolPermissionContext: unknown;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly tasks: Record<string, unknown>;
  };
  readonly readFileState: Map<string, unknown>;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly setStreamMode: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength: (updater: (length: number) => number) => void;
  readonly onCompactProgress: (event: unknown) => void;
  readonly setSDKStatus: (status: "compacting" | null) => void;
  readonly addNotification: (notification: unknown) => void;
  readonly emitWarning: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly clearProviderResponseId: () => void;
  readonly rolloutStore?: unknown;
  readonly session?: { readonly rolloutStore?: unknown };
  readonly provider?: LLMProvider;
  readonly cwd?: string;
}

type AgentRuntimeTool = LLMTool & {
  readonly name: string;
  readonly description: string;
  readonly inputJSONSchema: Record<string, unknown>;
  readonly isMcp: boolean;
  readonly maxResultSizeChars: number;
};

interface AgentModelContext {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

type SessionSurface = {
  readonly readFileState?: Map<string, unknown>;
  readonly loadedNestedMemoryPaths?: Set<string>;
  readonly mcpClients?: readonly unknown[];
  readonly agentDefinitions?: { readonly activeAgents?: readonly unknown[] };
  readonly tasks?: Record<string, unknown>;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: unknown) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly addNotification?: (notification: unknown) => void;
  readonly emitWarning?: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
};

function buildAgentRunContext(
  session: Session,
  ctx: TurnContext,
  opts: { readonly querySource?: string; readonly verbose?: boolean } = {},
): AgentRunContext {
  const model = toAgentModelContext(ctx);
  const providerOverride = buildAgentProviderOverride(session, model.model);
  const surface = readAgentSessionSurface(session);
  const agentDefinitions = {
    activeAgents: Array.isArray(surface.agentDefinitions?.activeAgents)
      ? [...surface.agentDefinitions.activeAgents]
      : [],
  };
  const cwd = ctx.cwd;
  return {
    abortController: session.abortController ?? new AbortController(),
    sessionId: session.conversationId,
    options: {
      mainLoopModel: model.model,
      tools: toAgentRuntimeTools(session.services.registry.toLLMTools()),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
      ...(opts.querySource !== undefined
        ? { querySource: opts.querySource }
        : {}),
      agentDefinitions,
      isNonInteractiveSession: false,
      cwd,
      verbose: opts.verbose ?? false,
    },
    getAppState: () => ({
      toolPermissionContext:
        session.permissionModeRegistry?.current?.() ??
        session.services.permissionModeRegistry?.current?.() ??
        createEmptyToolPermissionContext(),
      agentDefinitions,
      tasks: surface.tasks ?? {},
    }),
    readFileState: surface.readFileState ?? new Map<string, unknown>(),
    loadedNestedMemoryPaths:
      surface.loadedNestedMemoryPaths ?? new Set<string>(),
    setStreamMode: surface.setStreamMode ?? (() => {}),
    setResponseLength: surface.setResponseLength ?? (() => {}),
    onCompactProgress: surface.onCompactProgress ?? (() => {}),
    setSDKStatus: surface.setSDKStatus ?? (() => {}),
    addNotification: surface.addNotification ?? (() => {}),
    emitWarning:
      surface.emitWarning ??
      ((warning) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: warning,
          },
        });
      }),
    ...(surface.queryTracking !== undefined
      ? { queryTracking: surface.queryTracking }
      : {}),
    clearProviderResponseId: () => session.clearProviderResponseId(),
    ...(session.rolloutStore !== undefined
      ? { rolloutStore: session.rolloutStore }
      : {}),
    ...(session.rolloutStore !== undefined
      ? { session: { rolloutStore: session.rolloutStore } }
      : {}),
    provider: session.services.provider,
    cwd,
  };
}

function toAgentModelContext(ctx: TurnContext): AgentModelContext {
  const contextWindowTokens = ctx.modelInfo.contextWindow;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    throw new Error(`Missing context window for model ${ctx.modelInfo.slug}`);
  }
  return {
    model: ctx.modelInfo.slug,
    contextWindowTokens,
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}

function toAgentRuntimeTools(tools: readonly LLMTool[]): AgentRuntimeTool[] {
  return tools.map((tool) => {
    const name = tool.function.name;
    return {
      ...tool,
      name,
      description: tool.function.description,
      inputJSONSchema: tool.function.parameters,
      isMcp: name.startsWith("mcp__"),
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    };
  });
}

function buildAgentProviderOverride(
  session: Session,
  fallbackModel: string,
): AgentRunContext["options"]["providerOverride"] | undefined {
  const provider = session.services.provider;
  const options = readProviderFactoryOptions(provider);
  const model = firstNonEmpty(options.model, fallbackModel);
  const baseURL = firstNonEmpty(options.baseURL);
  if (!model || !baseURL) return undefined;
  return {
    model,
    baseURL,
    apiKey: options.apiKey ?? "",
  };
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readAgentSessionSurface(session: Session): SessionSurface {
  const snapshot = session.state.unsafePeek() as unknown as Record<
    string,
    unknown
  >;
  const direct = session as unknown as Record<string, unknown>;
  const read = <T>(key: keyof SessionSurface): T | undefined => {
    const directValue = direct[key];
    if (directValue !== undefined) return directValue as T;
    const snapshotValue = snapshot[key];
    if (snapshotValue !== undefined) return snapshotValue as T;
    return undefined;
  };
  return {
    readFileState: read<Map<string, unknown>>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions: read<{ readonly activeAgents?: readonly unknown[] }>(
      "agentDefinitions",
    ),
    tasks: read<Record<string, unknown>>("tasks"),
    queryTracking: read<{ readonly chainId?: string; readonly depth?: number }>(
      "queryTracking",
    ),
    setStreamMode:
      read<(mode: "requesting" | "responding" | null) => void>("setStreamMode"),
    setResponseLength:
      read<(updater: (length: number) => number) => void>("setResponseLength"),
    onCompactProgress: read<(event: unknown) => void>("onCompactProgress"),
    setSDKStatus: read<(status: "compacting" | null) => void>("setSDKStatus"),
    addNotification: read<(notification: unknown) => void>("addNotification"),
    emitWarning:
      read<
        (warning: { readonly cause: string; readonly message: string }) => void
      >("emitWarning"),
  };
}

function createAgentSummaryCacheSafeParams(opts: {
  readonly childSession: ChildSession;
  readonly live: LiveAgent;
  readonly turnContext: TurnContext;
  readonly providerRequest: AgentSummaryProviderRequest;
  readonly abortController: AbortController;
}): CacheSafeParams {
  const requestOptions = opts.providerRequest.options;
  const toolUseContext = buildAgentRunContext(
    opts.childSession,
    opts.turnContext,
    { querySource: "agent_summary" },
  );
  const context: REPLHookContext = {
    messages: opts.providerRequest.messages.map(
      llmMessageToAgentSummaryMessage,
    ),
    systemPrompt: requestOptions.systemPrompt ?? "",
    userContext: {},
    systemContext: {
      cwd: opts.childSession.sessionConfiguration.cwd,
    },
    toolUseContext: {
      ...toolUseContext,
      abortController: opts.abortController,
      provider: opts.childSession.services.provider,
      options: {
        ...toolUseContext.options,
        contextWindowTokens:
          requestOptions.contextWindowTokens ??
          toolUseContext.options.contextWindowTokens,
        ...(requestOptions.maxOutputTokens !== undefined
          ? { maxOutputTokens: requestOptions.maxOutputTokens }
          : {}),
      },
      readFileState: new ForkCompatibleFileStateCache(),
      cwd: opts.childSession.sessionConfiguration.cwd,
      queryTracking: {
        chainId: `agent-summary:${opts.live.agentId}`,
        depth: 0,
      },
    } as unknown as REPLHookContext["toolUseContext"],
    querySource: "agent_summary",
  };
  return createCacheSafeParams(context);
}

function relayToParentMailbox(params: {
  readonly live: LiveAgent;
  readonly parent: Session;
  readonly content: string;
  readonly triggerTurn: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}): void {
  try {
    params.live.upInbox.send({
      author: params.live.agentPath,
      recipient: params.parent.conversationId ?? "/root",
      content: params.content,
      triggerTurn: params.triggerTurn,
      direction: "up",
      metadata: params.metadata,
    });
    if (params.triggerTurn) {
      params.parent.mailbox.send({
        author: params.live.agentPath,
        recipient: params.parent.conversationId ?? "/root",
        content: params.content,
        triggerTurn: true,
        direction: "up",
        metadata: params.metadata,
      });
    }
  } catch (err) {
    if (
      err instanceof MailboxClosedError &&
      (params.live.abortController.signal.aborted ||
        isFinal(params.live.status.value))
    ) {
      return;
    }
    emitWarning(
      params.parent.eventLog,
      params.parent.nextInternalSubId(),
      "subagent_mailbox_closed",
      `subagent ${params.live.agentPath} upInbox closed before delivery: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sendSubagentNotificationToParent(params: {
  readonly live: LiveAgent;
  readonly parent: Session;
}): void {
  const content = formatSubagentNotification({
    agentPath: params.live.agentPath,
    status: params.live.status.value,
  });
  try {
    params.parent.mailbox.send({
      author: params.live.agentPath,
      recipient: parentAgentPathFor(params.live.agentPath),
      content,
      triggerTurn: true,
      direction: "up",
      metadata: { kind: "subagent_notification" },
    });
    requestParentFollowupTurn(params);
  } catch (err) {
    if (
      err instanceof MailboxClosedError &&
      (params.live.abortController.signal.aborted ||
        isFinal(params.live.status.value))
    ) {
      return;
    }
    emitWarning(
      params.parent.eventLog,
      params.parent.nextInternalSubId(),
      "subagent_notification_failed",
      `subagent ${params.live.agentPath} notification delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function requestParentFollowupTurn(params: {
  readonly live: LiveAgent;
  readonly parent: Session;
}): void {
  void params.parent.submit("", { displayUserMessage: null }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "Session submit hook is not installed") return;
    emitWarning(
      params.parent.eventLog,
      params.parent.nextInternalSubId(),
      "subagent_followup_turn_failed",
      `subagent ${params.live.agentPath} could not start parent follow-up turn: ${message}`,
    );
  });
}

function parentAgentPathFor(agentPath: string): string {
  const index = agentPath.lastIndexOf("/");
  if (index <= 0) return "/root";
  return agentPath.slice(0, index) || "/root";
}

/**
 * Park the agent loop until the mailbox has new content or the agent is
 * cancelled. Returns true if a new message arrived (caller should drain
 * + continue), false if the mailbox closed or the abort signal tripped
 * (caller should exit).
 *
 * Uses Mailbox.seqWatch (a BehaviorSubject<number>) which advances every
 * time send() commits a message. We capture the current sequence at
 * entry so we resolve only on advances past that point. The abort signal
 * is wired through addEventListener so an explicit stopAgent (which
 * aborts both live.abortController and the merged signal) breaks the
 * wait promptly.
 */
function waitForNextMailboxMessage(
  inbox: import("./mailbox.js").Mailbox,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const startingSeq = inbox.seqWatch.value;
    let unsubscribe: (() => void) | null = null;
    const cleanup = () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = inbox.seqWatch.subscribe((seq) => {
      if (seq > startingSeq) {
        cleanup();
        resolve(true);
      }
    });
  });
}

function drainChildMailbox(live: LiveAgent): {
  readonly clearHistory?: boolean;
  readonly interruptReason?: string;
  readonly nextUserMessage?: string | readonly LLMContentPart[];
  readonly refreshMcpConfig?: unknown;
} {
  const drained = live.downInbox.drain();
  if (drained.length === 0) {
    return {};
  }

  const passthrough: InterAgentCommunication[] = [];
  const nextTurnParts: Array<string | readonly LLMContentPart[]> = [];
  let clearHistory = false;
  let refreshMcpConfig: unknown;
  let shouldTriggerTurn = false;

  for (const item of drained) {
    if (isAgentExitedSentinel(item)) {
      continue;
    }
    const kind =
      typeof item.metadata?.kind === "string" ? item.metadata.kind : undefined;
    if (kind === "interrupt") {
      const reason =
        typeof item.metadata?.reason === "string" &&
        item.metadata.reason.length > 0
          ? item.metadata.reason
          : item.content.trim().length > 0
            ? item.content
            : "interrupt";
      return { interruptReason: reason };
    }
    if (kind === "history_clear") {
      clearHistory = true;
      passthrough.length = 0;
      nextTurnParts.length = 0;
      shouldTriggerTurn = false;
      continue;
    }
    if (kind === "mcp_refresh") {
      // Control message: refresh the live child's MCP servers between turns.
      // Latest config wins; does not itself trigger a turn.
      refreshMcpConfig = item.metadata?.mcpConfig;
      continue;
    }
    passthrough.push(item);
    shouldTriggerTurn ||= item.triggerTurn;
    const inputContent = item.metadata?.inputContent;
    if (isLlmContentParts(inputContent)) {
      nextTurnParts.push(inputContent);
    } else if (
      typeof inputContent === "string" &&
      inputContent.trim().length > 0
    ) {
      nextTurnParts.push(inputContent);
    } else if (item.content.trim().length > 0) {
      nextTurnParts.push(item.content);
    }
  }

  if (!shouldTriggerTurn) {
    for (const msg of passthrough) {
      const { seq: _seq, ...rest } = msg;
      void _seq;
      try {
        live.downInbox.send(rest);
      } catch {
        break;
      }
    }
    return {
      ...(clearHistory ? { clearHistory } : {}),
      ...(refreshMcpConfig !== undefined ? { refreshMcpConfig } : {}),
    };
  }

  return {
    ...(clearHistory ? { clearHistory } : {}),
    ...(refreshMcpConfig !== undefined ? { refreshMcpConfig } : {}),
    nextUserMessage: mergeChildInputParts(nextTurnParts),
  };
}

export function drainChildMailboxForTesting(
  live: LiveAgent,
): ReturnType<typeof drainChildMailbox> {
  return drainChildMailbox(live);
}

interface ChildConversationHistorySession {
  readonly state: {
    with(
      fn: (state: { history: unknown[] }) => void | Promise<void>,
    ): Promise<unknown>;
  };
  clearProviderResponseId(): void;
}

export async function clearChildConversationHistory(
  childSession: ChildConversationHistorySession,
  live: Pick<LiveAgent, "messages">,
  initialHistory: LLMMessage[],
): Promise<void> {
  await childSession.state.with((state) => {
    state.history.length = 0;
  });
  childSession.clearProviderResponseId();
  initialHistory.length = 0;
  live.messages.length = 0;
}

function isLlmContentParts(value: unknown): value is readonly LLMContentPart[] {
  return (
    Array.isArray(value) &&
    value.every((part) => {
      if (part === null || typeof part !== "object") return false;
      const candidate = part as {
        type?: unknown;
        text?: unknown;
        image_url?: unknown;
      };
      if (candidate.type === "text") return typeof candidate.text === "string";
      if (candidate.type === "image_url") {
        const image = candidate.image_url as { url?: unknown } | null;
        return (
          image !== null &&
          typeof image === "object" &&
          typeof image.url === "string"
        );
      }
      return false;
    })
  );
}

function mergeChildInputParts(
  parts: readonly (string | readonly LLMContentPart[])[],
): string | readonly LLMContentPart[] {
  if (!parts.some((part) => Array.isArray(part))) {
    return (parts as readonly string[]).join("\n\n");
  }
  const merged: LLMContentPart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim().length > 0) merged.push({ type: "text", text: part });
      continue;
    }
    merged.push(...part);
  }
  return merged;
}

export function buildFilteredRegistry(
  base: ToolRegistry,
  opts: {
    readonly allowlist?: ReadonlyArray<string>;
    readonly childConversationId: string;
    readonly worktree?: WorktreeHandle;
    readonly disabledTools?: ReadonlySet<string>;
    readonly childToolPolicy?: ChildToolPolicy;
  },
): ToolRegistry {
  const allowed = opts.allowlist ? new Set(opts.allowlist) : null;
  const disabled = opts.disabledTools ?? new Set<string>();
  const isEligible = (name: string): boolean =>
    !disabled.has(name) && (allowed === null || allowed.has(name));
  const wrappedTools = base.tools
    .filter((tool) => isEligible(tool.name))
    .map((tool) => wrapToolForChild(tool, opts));
  const wrappedByName = new Map(wrappedTools.map((tool) => [tool.name, tool]));
  const fallbackAdvertisedTools = () =>
    wrappedTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  const advertisedLLMTools = () => {
    const advertised = base.toLLMTools();
    if (advertised.length === 0) {
      return fallbackAdvertisedTools();
    }
    return advertised.filter((tool) =>
      isEligible(tool.function.name as string),
    );
  };
  const advertisedNames = () =>
    new Set(advertisedLLMTools().map((tool) => tool.function.name as string));

  return {
    get tools() {
      const names = advertisedNames();
      return wrappedTools.filter((tool) => names.has(tool.name));
    },
    toLLMTools() {
      return advertisedLLMTools();
    },
    async dispatch(toolCall): Promise<ToolDispatchResult> {
      if (disabled.has(toolCall.name)) {
        return {
          content: safeStringify({
            error: `tool not allowed for subagent: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      if (allowed && !allowed.has(toolCall.name)) {
        return {
          content: safeStringify({
            error: `tool not allowed for subagent: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      if (!advertisedNames().has(toolCall.name)) {
        return {
          content: safeStringify({
            error: `tool not allowed for subagent: ${toolCall.name}`,
          }),
          isError: true,
        };
      }

      const parseResult = parseToolCallArguments(toolCall.arguments);
      if (!parseResult.ok) {
        // Surface the parse failure explicitly so weak models can
        // recover instead of looping on "field X required" feedback.
        return {
          content: formatToolArgumentsParseError(toolCall.name, parseResult),
          isError: true,
        };
      }
      // SECURITY: strip model-supplied `__agenc*` keys at the child
      // tool-call boundary, before any policy/injection runs.
      const parsedArgs = stripModelSuppliedChildArgs(parseResult.args);
      const wrappedTool = wrappedByName.get(toolCall.name);
      if (wrappedTool) {
        const result = await wrappedTool.execute(parsedArgs);
        return {
          content: result.content,
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
          ...(result.metadata !== undefined
            ? { metadata: result.metadata }
            : {}),
        };
      }

      const policyResult = await applyChildToolPolicy(
        { name: toolCall.name },
        parsedArgs,
        opts,
      );
      if ("result" in policyResult) {
        return policyResult.result;
      }
      return base.dispatch({
        ...toolCall,
        arguments: safeStringify(
          injectChildToolArgs(policyResult.args, toolCall.name, opts),
        ),
      });
    },
  };
}

const THREAD_SPAWN_MAIN_THREAD_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "Brief",
  "SendUserMessage",
  "VerifyPlanExecution",
  "CronCreate",
  "CronDelete",
  "CronList",
  "WorkflowTool",
  "RemoteTrigger",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const THREAD_SPAWN_DEPTH_CAPPED_TOOL_NAMES = new Set([
  ...THREAD_SPAWN_MAIN_THREAD_TOOL_NAMES,
]);

const THREAD_SPAWN_SUBAGENT_TOOL_NAMES = new Set([
  ...THREAD_SPAWN_MAIN_THREAD_TOOL_NAMES,
]);

export function resolveThreadSpawnDisabledTools(opts: {
  readonly depth: number;
  readonly maxDepth: number;
}): ReadonlySet<string> {
  if (opts.depth >= opts.maxDepth) {
    return THREAD_SPAWN_DEPTH_CAPPED_TOOL_NAMES;
  }
  return opts.depth > 0
    ? THREAD_SPAWN_SUBAGENT_TOOL_NAMES
    : THREAD_SPAWN_MAIN_THREAD_TOOL_NAMES;
}

/**
 * Fold a role's `disallowlist` (e.g. read-only scanner/Plan/verification roles
 * denying edit/write/spawn) into the depth-based disabled-tools set. The merged
 * set is enforced by `buildFilteredRegistry` both when advertising tools and at
 * dispatch time, so denied tools are neither offered to nor callable by the
 * child. Returns the original set unchanged when the role has no denylist.
 */
export function mergeRoleDisallowlist(
  base: ReadonlySet<string>,
  disallowlist: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  if (!disallowlist || disallowlist.length === 0) return base;
  return new Set<string>([...base, ...disallowlist]);
}

function resolveSessionMaxAgentDepth(parent: Session): number {
  const asDepth = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
      ? value
      : undefined;
  return (
    asDepth((parent.config as { agent_max_depth?: unknown }).agent_max_depth) ??
    asDepth(
      (
        parent.sessionConfiguration.originalConfigDoNotUse as
          | { agent_max_depth?: unknown }
          | undefined
      )?.agent_max_depth,
    ) ??
    DEFAULT_MAX_AGENT_DEPTH
  );
}

type ParsedToolCallArguments =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string; readonly raw: string };

/**
 * Parse a tool_call's `arguments` JSON string into a plain object.
 *
 * Returns a discriminated result instead of silently coercing parse
 * failures into `{}`. The previous behavior — return {} on JSON parse
 * failure — let weak local models (qwen, llama family) loop on the
 * same broken tool call: the runtime would dispatch the empty args,
 * the tool would respond "field X required," the model would
 * interpret that as "I need to add field X" and re-emit the SAME
 * broken JSON. With this surfaced parse error the caller can route
 * the model back to the right correction: "your JSON didn't parse,
 * here's the input I saw, please re-emit valid JSON."
 *
 * Non-object roots (arrays, strings, null, numbers) are also surfaced
 * as errors — tool arguments must be a JSON object per the
 * function-calling contract used by all openai-compatible providers.
 */
function parseToolCallArguments(
  raw: string | undefined,
): ParsedToolCallArguments {
  const text = raw ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse failed: ${message}`, raw: text };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind =
      parsed === null
        ? "null"
        : Array.isArray(parsed)
          ? "array"
          : typeof parsed;
    return {
      ok: false,
      error: `tool_call arguments must be a JSON object (got ${kind})`,
      raw: text,
    };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

function formatToolArgumentsParseError(
  toolName: string,
  parsed: Extract<ParsedToolCallArguments, { ok: false }>,
): string {
  // The trailing instruction is what unsticks weak models from a
  // re-emit loop. Without it qwen/llama tend to re-send the same
  // broken JSON ("the model says I need field X — let me try again").
  return [
    `tool_call arguments for ${toolName} could not be parsed: ${parsed.error}.`,
    `Received raw arguments: ${parsed.raw}`,
    "Please re-emit the tool_call with valid JSON object arguments.",
  ].join("\n");
}

/**
 * Drop every `__agenc*` key from a model-supplied child tool-call args
 * object.
 *
 * SECURITY: `__agenc*` keys (`__agencSessionAllowedRoots`,
 * `__agencSessionId`, …) are a TRUSTED INTERNAL channel the runtime uses
 * to scope a child agent's filesystem access. A child model that emits
 * `__agencSessionAllowedRoots:["/"]` could otherwise widen its own
 * allowed roots and escape its worktree (audit #1/#2/#4). We strip these
 * from the raw model args BEFORE the child-tool policy runs, so the only
 * `__agenc*` values that survive are runtime/policy-injected. Returns the
 * input untouched when there is nothing to strip.
 */
function stripModelSuppliedChildArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  let needsStrip = false;
  for (const key of Object.keys(args)) {
    if (key.startsWith("__agenc")) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("__agenc")) continue;
    out[key] = value;
  }
  return out;
}

function injectChildToolArgs(
  parsedArgs: Record<string, unknown>,
  toolName: string,
  opts: {
    readonly childConversationId: string;
    readonly worktree?: WorktreeHandle;
  },
): Record<string, unknown> {
  // NOTE: model-supplied `__agenc*` keys are stripped UPSTREAM
  // (`stripModelSuppliedChildArgs`, applied to the raw model tool-call
  // args before `applyChildToolPolicy`). By the time we reach here, any
  // `__agencSessionAllowedRoots` present came from a TRUSTED source — the
  // child-tool policy's `updatedInput` (e.g. session-memory dir), which
  // is itself HMAC-signed via `withSignedAllowedRoots`. We route the
  // worktree-root injection through `withSignedAllowedRoots` so the
  // union (existing signed roots ∪ worktree) is re-signed; any unsigned
  // root that slipped past the strip is dropped rather than laundered.
  // Sign the child conversation id so the plan-file carve-out sink
  // (coding-common.ts `planFileContextFromArgs`) honors it. An unsigned
  // id verifies as absent there, exactly like an unsigned trusted root.
  let injectedArgs: Record<string, unknown> = withSignedSessionId(
    parsedArgs,
    opts.childConversationId,
  );
  if (opts.worktree?.path) {
    injectedArgs = withSignedAllowedRoots(injectedArgs, [opts.worktree.path]);
  }
  if (
    opts.worktree?.path &&
    (toolName === "system.bash" ||
      toolName === "exec_command" ||
      toolName === "apply_patch") &&
    (typeof injectedArgs.cwd !== "string" || injectedArgs.cwd.length === 0)
  ) {
    injectedArgs.cwd = opts.worktree.path;
  }
  return injectedArgs;
}

async function applyChildToolPolicy(
  tool: Pick<Tool, "name">,
  args: Record<string, unknown>,
  opts: {
    readonly childToolPolicy?: ChildToolPolicy;
  },
): Promise<
  | { readonly args: Record<string, unknown> }
  | { readonly result: ToolDispatchResult }
> {
  if (!opts.childToolPolicy) {
    return { args };
  }
  const decision = await opts.childToolPolicy(tool, args);
  if (decision.behavior === "deny") {
    return {
      result: {
        content: safeStringify({ error: decision.message }),
        isError: true,
        metadata: {
          ...(decision.metadata ?? {}),
          childPolicyDenied: true,
        },
      },
    };
  }
  return { args: decision.updatedInput ?? args };
}

function wrapToolForChild(
  tool: Tool,
  opts: {
    readonly childConversationId: string;
    readonly worktree?: WorktreeHandle;
    readonly childToolPolicy?: ChildToolPolicy;
  },
): Tool {
  return {
    ...tool,
    async execute(args) {
      // SECURITY: strip model-supplied `__agenc*` keys before the child
      // policy/injection runs (idempotent if the caller already stripped).
      const sanitizedArgs = stripModelSuppliedChildArgs(args);
      const policyResult = await applyChildToolPolicy(
        tool,
        sanitizedArgs,
        opts,
      );
      if ("result" in policyResult) {
        return policyResult.result;
      }
      return tool.execute(
        injectChildToolArgs(policyResult.args, tool.name, opts),
      );
    },
  };
}

function recoveryCategoryForTool(
  registry: ToolRegistry,
  toolName: string,
): ToolRecoveryCategory | undefined {
  const category = registry.tools.find(
    (tool) => tool.name === toolName,
  )?.recoveryCategory;
  return category === "idempotent" ||
    category === "side-effecting" ||
    category === "interactive"
    ? category
    : undefined;
}

function cloneSessionConfiguration(
  parent: Session,
  live: LiveAgent,
  worktree?: WorktreeHandle,
  overrides: {
    readonly model?: string;
    readonly reasoningEffort?: ReasoningEffort;
    readonly serviceTier?: string;
  } = {},
): Session["sessionConfiguration"] {
  const base = parent.sessionConfiguration;
  const cwd = worktree?.path ?? base.cwd;
  const serviceTier =
    overrides.serviceTier !== undefined
      ? overrides.serviceTier
      : base.serviceTier;
  const collaborationMode = {
    ...base.collaborationMode,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
  };
  return {
    ...base,
    cwd,
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    collaborationMode,
    sessionSource: {
      kind: "subagent",
      source: {
        kind: "thread_spawn",
        parentThreadId: parent.conversationId,
        depth: live.depth,
        agentPath: live.agentPath,
        agentNickname: live.nickname,
        agentRole: live.role.name,
      },
    },
    ...(base.originalConfigDoNotUse
      ? {
          originalConfigDoNotUse: {
            ...base.originalConfigDoNotUse,
            cwd,
            model: collaborationMode.model,
            modelReasoningEffort: collaborationMode.reasoningEffort,
            modelReasoningSummary: base.modelReasoningSummary,
            serviceTier,
            personality: base.personality,
            approvalsReviewer: base.approvalsReviewer,
          },
        }
      : {}),
  };
}

function createChildRolloutStore(
  parent: Session,
  sessionConfiguration: Session["sessionConfiguration"],
  childConversationId: string,
): RolloutStore | null {
  const parentRollout = parent.rolloutStore;
  if (!parentRollout) {
    return null;
  }

  const store = new RolloutStore({
    cwd: sessionConfiguration.cwd,
    sessionId: childConversationId,
    agencVersion: parentRollout.store.agencVersion,
    ...(parentRollout.projectRootMarkers !== undefined
      ? { projectRootMarkers: parentRollout.projectRootMarkers }
      : {}),
  });
  store.open({
    sessionId: childConversationId,
    timestamp: new Date().toISOString(),
    cwd: sessionConfiguration.cwd,
    originator: "agenc-subagent",
    agencVersion: parentRollout.store.agencVersion,
    model: sessionConfiguration.collaborationMode.model,
    modelProvider:
      readProviderIdentity(parent.services.provider) ??
      parent.services.provider.name,
  });
  return store;
}

function buildChildConfig(
  parent: Session,
  sessionConfiguration: Session["sessionConfiguration"],
): Session["config"] {
  return {
    ...parent.config,
    cwd: sessionConfiguration.cwd,
    model: sessionConfiguration.collaborationMode.model,
    modelReasoningEffort:
      sessionConfiguration.collaborationMode.reasoningEffort,
    modelReasoningSummary: sessionConfiguration.modelReasoningSummary,
    serviceTier: sessionConfiguration.serviceTier,
    personality: sessionConfiguration.personality,
    approvalsReviewer: sessionConfiguration.approvalsReviewer,
  };
}

function buildChildModelInfo(
  parent: Session,
  sessionConfiguration: Session["sessionConfiguration"],
): Session["modelInfo"] {
  return {
    ...parent.modelInfo,
    slug: sessionConfiguration.collaborationMode.model,
  };
}

function splitInitialMessages(
  initialMessages: ReadonlyArray<LLMMessage>,
  fallbackUserMessage: string,
): { history: LLMMessage[]; userMessage: string } {
  if (initialMessages.length === 0) {
    return { history: [], userMessage: fallbackUserMessage };
  }

  const history = initialMessages
    .slice(0, -1)
    .map((message) => ({ ...message }));
  const last = initialMessages[initialMessages.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    return { history, userMessage: last.content };
  }

  return {
    history: initialMessages.map((message) => ({ ...message })),
    userMessage: fallbackUserMessage,
  };
}

function buildChildSession(
  params: RunAgentParams,
  provider: LLMProvider,
  startupPrewarm?: StartupPrewarmStore,
): ChildSession {
  const roleConfig = params.live.role.config;
  const childModel = params.model ?? roleConfig.model;
  const childReasoningEffort =
    params.reasoningEffort ?? roleConfig.reasoningEffort;
  const childServiceTier = params.serviceTier ?? roleConfig.serviceTier;
  const sessionConfiguration = cloneSessionConfiguration(
    params.parent,
    params.live,
    params.worktree,
    {
      ...(childModel !== undefined ? { model: childModel } : {}),
      ...(childReasoningEffort !== undefined
        ? { reasoningEffort: childReasoningEffort }
        : {}),
      ...(childServiceTier !== undefined
        ? { serviceTier: childServiceTier }
        : {}),
    },
  );
  const registry = buildFilteredRegistry(params.parent.services.registry, {
    allowlist:
      params.toolAllowlist ?? params.live.role.config.allowlist ?? undefined,
    childConversationId: params.live.agentId,
    worktree: params.worktree,
    disabledTools: mergeRoleDisallowlist(
      resolveThreadSpawnDisabledTools({
        depth: params.live.depth,
        maxDepth: resolveSessionMaxAgentDepth(params.parent),
      }),
      params.live.role.config.disallowlist,
    ),
    ...(params.childToolPolicy !== undefined
      ? { childToolPolicy: params.childToolPolicy }
      : {}),
  });

  const childSession = new ChildSession({
    conversationId: params.live.agentId,
    initialState: {
      sessionConfiguration,
      history: [],
    },
    features: params.parent.features,
    services: {
      ...params.parent.services,
      provider,
      registry,
      ...(startupPrewarm !== undefined ? { startupPrewarm } : {}),
      querySource: params.querySource ?? params.parent.services.querySource,
      permissionModeRegistry: new PermissionModeRegistry(
        params.parent.permissionModeRegistry.current(),
      ),
    },
    jsRepl: params.parent.jsRepl,
    config: buildChildConfig(params.parent, sessionConfiguration),
    modelInfo: buildChildModelInfo(params.parent, sessionConfiguration),
  });
  params.live.configSnapshot = threadConfigSnapshot(
    sessionConfiguration,
  ) as unknown as Record<string, unknown>;

  if (!params.silent) {
    try {
      const childRolloutStore = createChildRolloutStore(
        params.parent,
        sessionConfiguration,
        params.live.agentId,
      );
      if (childRolloutStore) {
        childSession.mountRolloutStore(childRolloutStore);
        params.live.rolloutPath = childRolloutStore.rolloutPath;
      }
    } catch (err) {
      emitWarning(
        params.parent.eventLog,
        params.parent.nextInternalSubId(),
        "subagent_rollout_init_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return childSession;
}

/**
 * Run the subagent to completion. Yields progress events to the
 * caller + returns the final RunAgentResult. Caller (delegate.ts)
 * decides whether to wait synchronously or register-and-return
 * (async-mode subagent).
 */
export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void> {
  const startedAt = Date.now();
  const turnId = crypto.randomUUID();
  const { live, parent } = params;
  const relayAgentEvent = (
    event: Omit<Parameters<typeof relayToParentMailbox>[0], "live" | "parent">,
  ): void => {
    if (params.silent) return;
    relayToParentMailbox({ live, parent, ...event });
  };
  const sendParentNotification = (): void => {
    if (params.silent) return;
    sendSubagentNotificationToParent({ live, parent });
  };
  const finishErroredRun = (opts: {
    readonly message: string;
    readonly error: unknown;
    readonly toolCallCount?: number;
    readonly relayToParent?: boolean;
  }): RunAgentResult => {
    live.status.markErrored(turnId, opts.message);
    sendParentNotification();
    if (opts.relayToParent ?? true) {
      relayAgentEvent({
        content: opts.message,
        triggerTurn: false,
        metadata: {
          kind: "subagent_error",
          turnId,
        },
      });
    }
    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome: "errored",
      error: opts.error,
      ...(opts.toolCallCount !== undefined
        ? { toolCallCount: opts.toolCallCount }
        : {}),
    };
  };

  // Merge parent's + external signal with the live agent's controller.
  const merged = new AbortController();
  const onParentAbort = () => {
    if (!merged.signal.aborted) merged.abort("parent_aborted");
  };
  const onLiveAbort = () => {
    if (!merged.signal.aborted)
      merged.abort(String(live.abortController.signal.reason ?? "interrupted"));
  };
  const onExternalAbort = params.externalSignal
    ? () => {
        if (!merged.signal.aborted) {
          merged.abort(
            String(
              (params.externalSignal as AbortSignal & { reason?: unknown })
                .reason ?? "external_aborted",
            ),
          );
        }
      }
    : null;
  parent.abortController.signal.addEventListener("abort", onParentAbort, {
    once: true,
  });
  live.abortController.signal.addEventListener("abort", onLiveAbort, {
    once: true,
  });
  if (params.externalSignal && onExternalAbort !== null) {
    params.externalSignal.addEventListener("abort", onExternalAbort, {
      once: true,
    });
  }

  let childSession: ChildSession | null = null;
  let forwardMergedAbort: (() => void) | null = null;
  let roleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    relayAgentEvent({
      content: `spawned subagent ${live.agentPath} (role=${live.role.name})`,
      triggerTurn: false,
      metadata: {
        kind: "subagent_status",
        phase: "spawned",
        turnId,
      },
    });
    yield {
      kind: "status",
      text: `spawned subagent ${live.agentPath} (role=${live.role.name})`,
    };

    // I-50: wait for MCP ready with abort signal.
    const mcp = await initMcpForAgent({
      parent,
      signal: merged.signal,
      ...(params.timeoutMs !== undefined
        ? { timeoutMs: params.timeoutMs }
        : {}),
      roleConfig: live.role.config as RoleLikeConfig,
    });
    if (!mcp.ready) {
      emitWarning(
        parent.eventLog,
        parent.nextInternalSubId(),
        "subagent_mcp_unavailable",
        `subagent ${live.agentPath} proceeding without MCP (${mcp.reason})`,
      );
    }

    if (merged.signal.aborted) {
      const reason = String(merged.signal.reason ?? "aborted");
      live.status.markInterrupted(turnId, reason);
      yield { kind: "run_interrupted", reason };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "aborted",
      };
    }

    // Mark running.
    live.status.markRunning(turnId);

    // Stream the fork-context messages as progress events so callers
    // observing the generator can record the child's initial history.
    // The `isInitialReplay` flag lets downstream consumers distinguish
    // these replays from genuine new-turn messages — TUI clients must
    // suppress replays or the parent transcript shows the subagent's
    // initial prompt as if the user had typed it.
    if (live.messages.length === 0) {
      live.messages.push(
        ...params.initialMessages.map((message) => ({ ...message })),
      );
    }
    for (const message of params.initialMessages) {
      yield { kind: "message", message, isInitialReplay: true };
    }

    // Resolve the parent provider (subagents share model access).
    const provider = providerFromParent(parent);
    if (!provider) {
      const err = new Error(
        "subagent has no provider on parent.services.provider",
      );
      const result = finishErroredRun({
        message: err.message,
        error: err,
        relayToParent: false,
      });
      yield { kind: "run_error", error: err.message };
      return result;
    }

    // Build the chat options. Honor per-role timeoutMs via an inner
    // AbortController wired into the merged signal so we can label the
    // timeout reason distinctly ("role_timeout") without clobbering
    // the parent's abort reason.
    const roleTimeoutMs = params.timeoutMs ?? live.role.config.timeoutMs;
    const callController = new AbortController();
    forwardMergedAbort = () => {
      if (!callController.signal.aborted) {
        callController.abort(String(merged.signal.reason ?? "aborted"));
      }
    };
    if (merged.signal.aborted) forwardMergedAbort();
    merged.signal.addEventListener("abort", forwardMergedAbort, { once: true });

    let roleTimeoutFired = false;
    roleTimeoutHandle =
      typeof roleTimeoutMs === "number" && roleTimeoutMs > 0
        ? setTimeout(() => {
            if (!callController.signal.aborted) {
              roleTimeoutFired = true;
              callController.abort("role_timeout");
            }
          }, roleTimeoutMs)
        : null;

    const chatOptions = buildChatOptions(
      callController.signal,
      live.role.config,
      params.timeoutMs,
    );

    // The filtered child ToolRegistry enforces the allowlist, but we
    // still emit the warning so operators can see the delegated scope.
    const allowlist =
      params.toolAllowlist ?? live.role.config.allowlist ?? undefined;
    if (allowlist && allowlist.length > 0) {
      emitWarning(
        parent.eventLog,
        parent.nextInternalSubId(),
        "subagent_tool_allowlist",
        `subagent ${live.agentPath} allowlist: ${allowlist.join(",")}`,
      );
    }

    let cacheSafeParamsCaptured = false;
    let activeTurnContext: TurnContext | null = null;
    const captureCacheSafeParams: AgentSummaryProviderRequestCapture = (
      providerRequest,
    ) => {
      if (
        cacheSafeParamsCaptured ||
        childSession === null ||
        activeTurnContext === null
      ) {
        return;
      }
      cacheSafeParamsCaptured = true;
      params.onCacheSafeParams?.(
        createAgentSummaryCacheSafeParams({
          childSession,
          live,
          turnContext: activeTurnContext,
          providerRequest,
          abortController: callController,
        }),
      );
    };
    const childProvider = params.onCacheSafeParams
      ? wrapProviderForAgentSummary(provider, captureCacheSafeParams)
      : provider;
    const childStartupPrewarm =
      params.onCacheSafeParams && parent.services.startupPrewarm !== undefined
        ? wrapStartupPrewarmForAgentSummary(
            parent.services.startupPrewarm,
            captureCacheSafeParams,
          )
        : parent.services.startupPrewarm;
    childSession = buildChildSession(
      params,
      childProvider,
      childStartupPrewarm,
    );
    const { history, userMessage } = splitInitialMessages(
      params.initialMessages,
      params.taskPrompt,
    );
    if (live.role.config.systemPrompt) {
      history.unshift({
        role: "system",
        content: live.role.config.systemPrompt,
      } as LLMMessage);
    }
    let nextUserMessage: string | readonly LLMContentPart[] = userMessage;
    let firstTurn = true;
    let assistantText = "";
    let toolCallCount = 0;
    while (true) {
      let turnAssistantText = "";
      let turnUsage: LLMUsage | undefined;
      let stopReason:
        | "completed"
        | "max_turns"
        | "cancelled"
        | "error"
        | "empty_response" = "completed";
      let terminalError: unknown;

      const iter = childSession.runTurn(nextUserMessage, {
        ctx: (() => {
          activeTurnContext =
            params.maxTurns !== undefined
              ? childSession.newTurnWithSubId(
                  childSession.nextInternalSubId(),
                  { maxTurns: params.maxTurns },
                )
              : childSession.newDefaultTurnWithSubId(
                  childSession.nextInternalSubId(),
                );
          return activeTurnContext;
        })(),
        ...(firstTurn ? { history } : {}),
        signal: chatOptions.signal,
      });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const step = await iter.next();
        if (step.done) {
          terminalError = step.value?.error;
          break;
        }
        const event = step.value;
        if (event.type === "assistant_text") {
          turnAssistantText = event.content;
          yield {
            kind: "message",
            message: {
              role: "assistant",
              content: event.content,
            },
          };
          continue;
        }

        if (event.type === "tool_call") {
          toolCallCount += 1;
          const recoveryCategory = recoveryCategoryForTool(
            childSession.services.registry,
            event.toolCall.name,
          );
          relayAgentEvent({
            content: `${event.toolCall.name} (${event.toolCall.id})`,
            triggerTurn: false,
            metadata: {
              kind: "subagent_tool_call",
              turnId,
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
            },
          });
          yield {
            kind: "tool_call",
            callId: event.toolCall.id,
            toolName: event.toolCall.name,
            arguments: event.toolCall.arguments,
            ...(recoveryCategory !== undefined ? { recoveryCategory } : {}),
          };
          continue;
        }

        if (event.type === "tool_result") {
          yield {
            kind: "tool_result",
            callId: event.toolCall.id,
            toolName: event.toolCall.name,
            result: event.result.content,
            isError: event.result.isError ?? false,
            ...(event.result.metadata !== undefined
              ? { metadata: event.result.metadata }
              : {}),
          };
          continue;
        }

        if (event.type === "turn_complete") {
          turnAssistantText = event.content;
          stopReason = event.stopReason;
          turnUsage = event.usage;
        }
      }

      assistantText = turnAssistantText;
      if (turnUsage !== undefined) {
        live.tokenUsage.inputTokens += turnUsage.promptTokens ?? 0;
        live.tokenUsage.outputTokens += turnUsage.completionTokens ?? 0;
        live.tokenUsage.totalTokens +=
          turnUsage.totalTokens ??
          (turnUsage.promptTokens ?? 0) + (turnUsage.completionTokens ?? 0);
        yield {
          kind: "usage_update",
          inputTokens: live.tokenUsage.inputTokens,
          outputTokens: live.tokenUsage.outputTokens,
          totalTokens: live.tokenUsage.totalTokens,
        };
        if (merged.signal.aborted) break;
      }

      if (stopReason === "error" || stopReason === "max_turns") {
        let message: string;
        if (stopReason === "max_turns") {
          message = `subagent exceeded maxTurns${params.maxTurns !== undefined ? ` (${params.maxTurns})` : ""}`;
        } else if (terminalError instanceof Error) {
          message = terminalError.message;
        } else if (typeof terminalError === "string") {
          message = terminalError;
        } else {
          message = assistantText || "subagent turn failed";
        }
        const result = finishErroredRun({
          message,
          error:
            terminalError instanceof Error ? terminalError : new Error(message),
          toolCallCount,
        });
        yield { kind: "run_error", error: message };
        return result;
      }

      if (stopReason === "cancelled") {
        if (roleTimeoutFired) {
          const message = `role_timeout after ${roleTimeoutMs}ms`;
          const result = finishErroredRun({
            message,
            error: new Error(message),
            toolCallCount,
          });
          yield { kind: "run_error", error: message };
          return result;
        }
        const reason =
          terminalError instanceof Error
            ? terminalError.message
            : typeof terminalError === "string"
              ? terminalError
              : "cancelled";
        live.status.markInterrupted(turnId, reason);
        relayAgentEvent({
          content: reason,
          triggerTurn: false,
          metadata: {
            kind: "subagent_interrupted",
            turnId,
          },
        });
        yield { kind: "run_interrupted", reason };
        return {
          threadId: live.agentId,
          durationMs: Date.now() - startedAt,
          outcome: "interrupted",
          toolCallCount,
        };
      }

      firstTurn = false;
      if (assistantText.length > 0) {
        live.messages.push({ role: "assistant", content: assistantText });
      }
      const pendingChildInput = drainChildMailbox(live);
      if (pendingChildInput.interruptReason) {
        if (!merged.signal.aborted) {
          merged.abort(pendingChildInput.interruptReason);
        }
        break;
      }
      if (pendingChildInput.clearHistory) {
        await clearChildConversationHistory(childSession, live, history);
        assistantText = "";
      }
      if (pendingChildInput.refreshMcpConfig !== undefined) {
        // Apply a parent-initiated MCP-config refresh to the live child so a
        // running subagent picks up added/removed MCP servers between turns
        // (previously a silent no-op in submitToLiveAgent).
        await childSession.services.mcpManager?.refreshFromConfig?.(
          pendingChildInput.refreshMcpConfig,
        );
      }
      if (pendingChildInput.nextUserMessage !== undefined) {
        nextUserMessage = pendingChildInput.nextUserMessage;
        live.messages.push({
          role: "user",
          content:
            typeof nextUserMessage === "string"
              ? nextUserMessage
              : [...nextUserMessage],
        });
        relayAgentEvent({
          content: `accepted follow-up input for ${live.agentPath}`,
          triggerTurn: false,
          metadata: {
            kind: "subagent_status",
            phase: "follow_up",
            turnId,
          },
        });
        continue;
      }
      // Mailbox is empty. One-shot agents exit here. Persistent agents
      // (the daemon's TUI agent, marked `keepAlive: true`) wait for new
      // input before exiting. The wait resolves when the mailbox advances
      // (new message arrived) OR closes (explicit shutdown) OR the
      // external/abort signal trips. Each iteration of the outer loop
      // re-checks the mailbox via drainChildMailbox.
      if (!params.keepAlive) break;
      // Emit a per-turn complete signal so the TUI flips isStreaming
      // and the busy-spinner stops between turns. The agent itself
      // stays in `running` from the FSM's perspective (we don't fire
      // markCompleted, which would be a final state).
      yield {
        kind: "turn_complete",
        turnId,
        ...(assistantText ? { finalMessage: assistantText } : {}),
      };
      const advanced = await waitForNextMailboxMessage(
        live.downInbox,
        merged.signal,
      );
      if (!advanced) break;
    }

    // If the caller aborted during the provider call, surface that
    // outcome instead of completion. `role_timeout` is a distinct
    // bucket routed through run_error so delegate.ts can retry.
    if (merged.signal.aborted) {
      const reason = String(merged.signal.reason ?? "aborted");
      live.status.markInterrupted(turnId, reason);
      relayAgentEvent({
        content: reason,
        triggerTurn: false,
        metadata: {
          kind: "subagent_interrupted",
          turnId,
        },
      });
      yield { kind: "run_interrupted", reason };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "interrupted",
        toolCallCount,
      };
    }
    if (roleTimeoutFired) {
      const message = `role_timeout after ${roleTimeoutMs}ms`;
      const result = finishErroredRun({
        message,
        error: new Error(message),
        toolCallCount,
      });
      yield { kind: "run_error", error: message };
      return result;
    }

    live.status.markCompleted(turnId, assistantText);
    sendParentNotification();
    yield {
      kind: "run_complete",
      ...(assistantText !== undefined ? { finalMessage: assistantText } : {}),
      toolCallCount,
    };

    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome: "completed",
      finalMessage: assistantText,
      toolCallCount,
    };
  } catch (err) {
    // Signal-abort-driven failures can surface as thrown errors from
    // the provider — prefer the interrupted outcome in that case.
    if (merged.signal.aborted) {
      const reason = String(merged.signal.reason ?? "aborted");
      live.status.markInterrupted(turnId, reason);
      relayAgentEvent({
        content: reason,
        triggerTurn: false,
        metadata: {
          kind: "subagent_interrupted",
          turnId,
        },
      });
      yield { kind: "run_interrupted", reason };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "interrupted",
        toolCallCount: 0,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    const result = finishErroredRun({
      message,
      error: err,
    });
    yield { kind: "run_error", error: message };
    return result;
  } finally {
    if (roleTimeoutHandle !== null) clearTimeout(roleTimeoutHandle);
    if (forwardMergedAbort !== null) {
      merged.signal.removeEventListener("abort", forwardMergedAbort);
    }
    if (childSession !== null) {
      await childSession.shutdown();
    }
    parent.abortController.signal.removeEventListener("abort", onParentAbort);
    live.abortController.signal.removeEventListener("abort", onLiveAbort);
    if (params.externalSignal && onExternalAbort !== null) {
      params.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** @internal Kept for compatibility callers that relied on the park-until-abort
 *  shape. Safe to remove once nothing outside this module references it. */
export function awaitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
