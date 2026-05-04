/**
 * runAgent — drive one subagent's run-turn loop.
 *
 * Hand-port of the donor AgentTool runner (987 LOC)
 * subset. Responsibilities:
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

import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMUsage,
} from "../llm/types.js";
import { readProviderIdentity } from "../llm/provider.js";
import type { ToolRegistry, ToolDispatchResult } from "./_deps/tool-registry.js";
import {
  safeStringify,
  type Tool,
  type ToolRecoveryCategory,
} from "./_deps/tools-types.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "./_deps/filesystem-args.js";
import { Session as ChildSession, type Session } from "../session/session.js";
import { RolloutStore } from "../session/rollout-store.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import {
  threadConfigSnapshot,
  type ReasoningEffort,
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
  /** Optional AbortSignal merged with the live agent's controller. */
  readonly externalSignal?: AbortSignal;
}

export type RunAgentProgressEvent =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "message"; readonly message: LLMMessage }
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
    }
  | {
      readonly kind: "usage_update";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | { readonly kind: "run_complete"; readonly finalMessage?: string; readonly toolCallCount: number }
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

interface RoleLikeConfig {
  readonly requiredMcpServers?: ReadonlyArray<string>;
}

/**
 * Minimal shape we lean on from the session to check MCP readiness.
 * T10 will extend SessionServices with a first-class mcpManager
 * surface; for now we read it defensively off `session.services`.
 */
interface McpManagerLike {
  isConnected(name: string): boolean;
}

function readMcpManager(parent: Session): McpManagerLike | undefined {
  const services = (parent as unknown as { services?: Record<string, unknown> })
    .services;
  if (!services || typeof services !== "object") return undefined;
  const raw = (services as { mcpManager?: unknown }).mcpManager;
  if (
    raw &&
    typeof raw === "object" &&
    typeof (raw as McpManagerLike).isConnected === "function"
  ) {
    return raw as McpManagerLike;
  }
  return undefined;
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

export interface RunAgentIterator {
  [Symbol.asyncIterator](): AsyncIterator<RunAgentProgressEvent, RunAgentResult>;
}

function providerFromParent(parent: Session): LLMProvider | undefined {
  const services = (parent as unknown as { services?: Record<string, unknown> })
    .services;
  if (!services || typeof services !== "object") return undefined;
  const provider = (services as { provider?: unknown }).provider;
  if (provider && typeof (provider as LLMProvider).chat === "function") {
    return provider as LLMProvider;
  }
  return undefined;
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
  if (
    roleConfig.reasoningEffort &&
    roleConfig.reasoningEffort !== "none"
  ) {
    opts.reasoningEffort = roleConfig.reasoningEffort;
  }
  const effectiveTimeout = timeoutOverrideMs ?? roleConfig.timeoutMs;
  if (typeof effectiveTimeout === "number" && effectiveTimeout > 0) {
    opts.timeoutMs = effectiveTimeout;
  }
  return opts as LLMChatOptions;
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
      (params.live.abortController.signal.aborted || isFinal(params.live.status.value))
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
      triggerTurn: false,
      direction: "up",
      metadata: { kind: "subagent_notification" },
    });
  } catch (err) {
    if (
      err instanceof MailboxClosedError &&
      (params.live.abortController.signal.aborted || isFinal(params.live.status.value))
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

function parentAgentPathFor(agentPath: string): string {
  const index = agentPath.lastIndexOf("/");
  if (index <= 0) return "/root";
  return agentPath.slice(0, index) || "/root";
}

function drainChildMailbox(live: LiveAgent): {
  readonly interruptReason?: string;
  readonly nextUserMessage?: string | readonly LLMContentPart[];
} {
  const drained = live.downInbox.drain();
  if (drained.length === 0) {
    return {};
  }

  const passthrough: InterAgentCommunication[] = [];
  const nextTurnParts: Array<string | readonly LLMContentPart[]> = [];
  let shouldTriggerTurn = false;

  for (const item of drained) {
    if (isAgentExitedSentinel(item)) {
      continue;
    }
    const kind =
      typeof item.metadata?.kind === "string" ? item.metadata.kind : undefined;
    if (kind === "interrupt") {
      const reason =
        typeof item.metadata?.reason === "string" && item.metadata.reason.length > 0
          ? item.metadata.reason
          : item.content.trim().length > 0
            ? item.content
            : "interrupt";
      return { interruptReason: reason };
    }
    passthrough.push(item);
    shouldTriggerTurn ||= item.triggerTurn;
    const inputContent = item.metadata?.inputContent;
    if (isLlmContentParts(inputContent)) {
      nextTurnParts.push(inputContent);
    } else if (typeof inputContent === "string" && inputContent.trim().length > 0) {
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
    return {};
  }

  return { nextUserMessage: mergeChildInputParts(nextTurnParts) };
}

function isLlmContentParts(value: unknown): value is readonly LLMContentPart[] {
  return (
    Array.isArray(value) &&
    value.every((part) => {
      if (part === null || typeof part !== "object") return false;
      const candidate = part as { type?: unknown; text?: unknown; image_url?: unknown };
      if (candidate.type === "text") return typeof candidate.text === "string";
      if (candidate.type === "image_url") {
        const image = candidate.image_url as { url?: unknown } | null;
        return image !== null &&
          typeof image === "object" &&
          typeof image.url === "string";
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
  },
): ToolRegistry {
  const allowed = opts.allowlist ? new Set(opts.allowlist) : null;
  const disabled = opts.disabledTools ?? new Set<string>();
  const isEligible = (name: string): boolean =>
    !disabled.has(name) &&
    (allowed === null || allowed.has(name));
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

      const parsedArgs = parseToolCallArguments(toolCall.arguments);
      const wrappedTool = wrappedByName.get(toolCall.name);
      if (wrappedTool) {
        const result = await wrappedTool.execute(parsedArgs);
        return {
          content: result.content,
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      }

      return base.dispatch({
        ...toolCall,
        arguments: safeStringify(
          injectChildToolArgs(parsedArgs, toolCall.name, opts),
        ),
      });
    },
  };
}

const V2_AGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "followup_task",
  "send_message",
  "list_agents",
]);

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
  ...V2_AGENT_TOOL_NAMES,
]);

export function resolveThreadSpawnDisabledTools(opts: {
  readonly depth: number;
  readonly maxDepth: number;
}): ReadonlySet<string> {
  return opts.depth >= opts.maxDepth
    ? THREAD_SPAWN_DEPTH_CAPPED_TOOL_NAMES
    : THREAD_SPAWN_MAIN_THREAD_TOOL_NAMES;
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

function parseToolCallArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function injectChildToolArgs(
  parsedArgs: Record<string, unknown>,
  toolName: string,
  opts: {
    readonly childConversationId: string;
    readonly worktree?: WorktreeHandle;
  },
): Record<string, unknown> {
  const injectedArgs: Record<string, unknown> = {
    ...parsedArgs,
    [SESSION_ID_ARG]: opts.childConversationId,
  };
  if (opts.worktree?.path) {
    injectedArgs[SESSION_ALLOWED_ROOTS_ARG] = [opts.worktree.path];
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

function wrapToolForChild(
  tool: Tool,
  opts: {
    readonly childConversationId: string;
    readonly worktree?: WorktreeHandle;
  },
): Tool {
  return {
    ...tool,
    execute(args) {
      return tool.execute(injectChildToolArgs(args, tool.name, opts));
    },
  };
}

function recoveryCategoryForTool(
  registry: ToolRegistry,
  toolName: string,
): ToolRecoveryCategory | undefined {
  const category = registry.tools.find((tool) => tool.name === toolName)
    ?.recoveryCategory;
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
  } = {},
): Session["sessionConfiguration"] {
  const base = parent.sessionConfiguration;
  const cwd = worktree?.path ?? base.cwd;
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
            serviceTier: base.serviceTier,
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

  const history = initialMessages.slice(0, -1).map((message) => ({ ...message }));
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
): ChildSession {
  const sessionConfiguration = cloneSessionConfiguration(
    params.parent,
    params.live,
    params.worktree,
    {
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.reasoningEffort !== undefined
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
    },
  );
  const registry = buildFilteredRegistry(
    params.parent.services.registry,
    {
      allowlist:
        params.toolAllowlist ?? params.live.role.config.allowlist ?? undefined,
      childConversationId: params.live.agentId,
      worktree: params.worktree,
      disabledTools: resolveThreadSpawnDisabledTools({
        depth: params.live.depth,
        maxDepth: resolveSessionMaxAgentDepth(params.parent),
      }),
    },
  );

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
      permissionModeRegistry: new PermissionModeRegistry(
        params.parent.permissionModeRegistry.current(),
      ),
    },
    jsRepl: params.parent.jsRepl,
    config: buildChildConfig(params.parent, sessionConfiguration),
    modelInfo: buildChildModelInfo(params.parent, sessionConfiguration),
  });
  params.live.configSnapshot = threadConfigSnapshot(sessionConfiguration) as unknown as Record<string, unknown>;

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
  const { live, parent } = params;

  // Merge parent's + external signal with the live agent's controller.
  const merged = new AbortController();
  const onParentAbort = () => {
    if (!merged.signal.aborted) merged.abort("parent_aborted");
  };
  const onLiveAbort = () => {
    if (!merged.signal.aborted)
      merged.abort(String(live.abortController.signal.reason ?? "interrupted"));
  };
  parent.abortController.signal.addEventListener("abort", onParentAbort, {
    once: true,
  });
  live.abortController.signal.addEventListener("abort", onLiveAbort, {
    once: true,
  });
  if (params.externalSignal) {
    params.externalSignal.addEventListener(
      "abort",
      () =>
        merged.signal.aborted
          ? null
          : merged.abort(
              String(
                (params.externalSignal as AbortSignal & { reason?: unknown }).reason ??
                  "external_aborted",
              ),
            ),
      { once: true },
    );
  }

  const turnId = crypto.randomUUID();
  let childSession: ChildSession | null = null;
  let forwardMergedAbort: (() => void) | null = null;
  let roleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    relayToParentMailbox({
      live,
      parent,
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
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
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
    if (live.messages.length === 0) {
      live.messages.push(
        ...params.initialMessages.map((message) => ({ ...message })),
      );
    }
    for (const message of params.initialMessages) {
      yield { kind: "message", message };
    }

    // Resolve the parent provider (subagents share model access).
    const provider = providerFromParent(parent);
    if (!provider) {
      const err = new Error(
        "subagent has no provider on parent.services.provider",
      );
      live.status.markErrored(turnId, err.message);
      sendSubagentNotificationToParent({ live, parent });
      yield { kind: "run_error", error: err.message };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "errored",
        error: err,
      };
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

    childSession = buildChildSession(params, provider);
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
          relayToParentMailbox({
            live,
            parent,
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

      if (stopReason === "error") {
        const message =
          terminalError instanceof Error
            ? terminalError.message
            : typeof terminalError === "string"
              ? terminalError
              : assistantText || "subagent turn failed";
        live.status.markErrored(turnId, message);
        sendSubagentNotificationToParent({ live, parent });
        relayToParentMailbox({
          live,
          parent,
          content: message,
          triggerTurn: false,
          metadata: {
            kind: "subagent_error",
            turnId,
          },
        });
        yield { kind: "run_error", error: message };
        return {
          threadId: live.agentId,
          durationMs: Date.now() - startedAt,
          outcome: "errored",
          error:
            terminalError instanceof Error ? terminalError : new Error(message),
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
      if (pendingChildInput.nextUserMessage !== undefined) {
        nextUserMessage = pendingChildInput.nextUserMessage;
        live.messages.push({
          role: "user",
          content: typeof nextUserMessage === "string"
            ? nextUserMessage
            : [...nextUserMessage],
        });
        relayToParentMailbox({
          live,
          parent,
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
      break;
    }

    // If the caller aborted during the provider call, surface that
    // outcome instead of completion. `role_timeout` is a distinct
    // bucket routed through run_error so delegate.ts can retry.
    if (merged.signal.aborted) {
      const reason = String(merged.signal.reason ?? "aborted");
      live.status.markInterrupted(turnId, reason);
      relayToParentMailbox({
        live,
        parent,
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
      live.status.markErrored(turnId, message);
      sendSubagentNotificationToParent({ live, parent });
      relayToParentMailbox({
        live,
        parent,
        content: message,
        triggerTurn: false,
        metadata: {
          kind: "subagent_error",
          turnId,
        },
      });
      yield { kind: "run_error", error: message };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "errored",
        error: new Error(message),
        toolCallCount,
      };
    }

    live.status.markCompleted(turnId, assistantText);
    sendSubagentNotificationToParent({ live, parent });
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
      relayToParentMailbox({
        live,
        parent,
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
    live.status.markErrored(turnId, message);
    sendSubagentNotificationToParent({ live, parent });
    relayToParentMailbox({
      live,
      parent,
      content: message,
      triggerTurn: false,
      metadata: {
        kind: "subagent_error",
        turnId,
      },
    });
    yield { kind: "run_error", error: message };
    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome: "errored",
      error: err,
    };
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
  }
}

/** @internal Kept for legacy callers that relied on the park-until-abort
 *  shape. Safe to remove once nothing outside this module references it. */
export function awaitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
