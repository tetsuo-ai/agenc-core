/**
 * runAgent — drive one subagent's run-turn loop.
 *
 * Hand-port of openclaude `tools/AgentTool/runAgent.ts` (987 LOC)
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
  LLMMessage,
  LLMProvider,
} from "../llm/types.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import { safeStringify } from "../tools/types.js";
import { Session as ChildSession, type Session } from "../session/session.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import type { LiveAgent } from "./control.js";
import type { AgentRoleConfig } from "./role.js";
import type { WorktreeHandle } from "./worktree.js";
import { emitWarning } from "../session/event-log.js";
import type { ThreadId } from "./registry.js";

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
  /** Optional AbortSignal merged with the live agent's controller. */
  readonly externalSignal?: AbortSignal;
}

export type RunAgentProgressEvent =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "message"; readonly message: LLMMessage }
  | { readonly kind: "tool_call"; readonly callId: string; readonly toolName: string }
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

function buildFilteredRegistry(
  base: ToolRegistry,
  allowlist?: ReadonlyArray<string>,
): ToolRegistry {
  if (!allowlist || allowlist.length === 0) {
    return base;
  }

  const allowed = new Set(allowlist);
  const tools = base.tools.filter((tool) => allowed.has(tool.name));

  return {
    tools,
    toLLMTools() {
      return tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
    async dispatch(toolCall): Promise<ToolDispatchResult> {
      if (!allowed.has(toolCall.name)) {
        return {
          content: safeStringify({
            error: `tool not allowed for subagent: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      return base.dispatch(toolCall);
    },
  };
}

function cloneSessionConfiguration(
  parent: Session,
  worktree?: WorktreeHandle,
): Session["sessionConfiguration"] {
  const base = parent.sessionConfiguration;
  const cwd = worktree?.path ?? base.cwd;
  return {
    ...base,
    cwd,
    ...(base.originalConfigDoNotUse
      ? {
          originalConfigDoNotUse: {
            ...base.originalConfigDoNotUse,
            cwd,
            model: base.collaborationMode.model,
            modelReasoningEffort: base.collaborationMode.reasoningEffort,
            modelReasoningSummary: base.modelReasoningSummary,
            serviceTier: base.serviceTier,
            personality: base.personality,
            approvalsReviewer: base.approvalsReviewer,
          },
        }
      : {}),
  };
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
    params.worktree,
  );
  const registry = buildFilteredRegistry(
    params.parent.services.registry,
    params.toolAllowlist ?? params.live.role.config.allowlist ?? undefined,
  );

  return new ChildSession({
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

  try {
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
    const forwardMergedAbort = () => {
      if (!callController.signal.aborted) {
        callController.abort(String(merged.signal.reason ?? "aborted"));
      }
    };
    if (merged.signal.aborted) forwardMergedAbort();
    merged.signal.addEventListener("abort", forwardMergedAbort, { once: true });

    let roleTimeoutFired = false;
    const roleTimeoutHandle =
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

    const childSession = buildChildSession(params, provider);
    const { history, userMessage } = splitInitialMessages(
      params.initialMessages,
      params.taskPrompt,
    );

    let assistantText = "";
    let toolCallCount = 0;
    let stopReason:
      | "completed"
      | "max_turns"
      | "cancelled"
      | "error"
      | "empty_response" = "completed";
    let terminalError: unknown;
    try {
      const iter = childSession.runTurn(userMessage, {
        history,
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
          assistantText = event.content;
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
          yield {
            kind: "tool_call",
            callId: event.toolCall.id,
            toolName: event.toolCall.name,
          };
          continue;
        }

        if (event.type === "turn_complete") {
          assistantText = event.content;
          stopReason = event.stopReason;
        }
      }
    } finally {
      if (roleTimeoutHandle !== null) clearTimeout(roleTimeoutHandle);
      merged.signal.removeEventListener("abort", forwardMergedAbort);
      await childSession.shutdown();
    }

    // If the caller aborted during the provider call, surface that
    // outcome instead of completion. `role_timeout` is a distinct
    // bucket routed through run_error so delegate.ts can retry.
    if (merged.signal.aborted) {
      const reason = String(merged.signal.reason ?? "aborted");
      live.status.markInterrupted(turnId, reason);
      yield { kind: "run_interrupted", reason };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "interrupted",
      };
    }
    if (roleTimeoutFired) {
      const message = `role_timeout after ${roleTimeoutMs}ms`;
      live.status.markErrored(turnId, message);
      yield { kind: "run_error", error: message };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "errored",
        error: new Error(message),
      };
    }

    if (stopReason === "error") {
      const message =
        terminalError instanceof Error
          ? terminalError.message
          : typeof terminalError === "string"
            ? terminalError
            : assistantText || "subagent turn failed";
      live.status.markErrored(turnId, message);
      yield { kind: "run_error", error: message };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "errored",
        error:
          terminalError instanceof Error ? terminalError : new Error(message),
      };
    }

    // Forward the assistant text back to the parent via upInbox so
    // the parent's mailbox sees the completion (I-5: direction=up).
    try {
      live.upInbox.send({
        author: live.agentPath,
        recipient: parent.conversationId ?? "/root",
        content: assistantText,
        triggerTurn: true,
        direction: "up",
        metadata: {
          kind: "subagent_complete",
          turnId,
          toolCallCount,
        },
      });
    } catch (err) {
      // Mailbox closed mid-run — log but still mark the turn completed
      // since the provider call succeeded.
      emitWarning(
        parent.eventLog,
        parent.nextInternalSubId(),
        "subagent_mailbox_closed",
        `subagent ${live.agentPath} upInbox closed before delivery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    live.status.markCompleted(turnId, assistantText);
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
      yield { kind: "run_interrupted", reason };
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "interrupted",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    live.status.markErrored(turnId, message);
    yield { kind: "run_error", error: message };
    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome: "errored",
      error: err,
    };
  } finally {
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
