/**
 * `system.agent.delegate` — the subagent spawn dispatcher exposed as
 * a built-in tool the model can invoke directly.
 *
 * Wraps `agents/delegate.ts` with:
 *   - Lazy construction of an AgentControl + AgentRegistry per session
 *     (cached off the session via `ensureAgentControl`). The CLI
 *     placeholder `services.agentControl` is a stub, so we build the
 *     real control plane on first use without mutating the frozen
 *     services container.
 *   - JSON Schema matching the T9 surface: taskPrompt, role, isolation,
 *     worktreeSlug, runInBackground.
 *   - Outcome → ToolResult mapping:
 *       sync_completed  → { finalMessage, toolCallCount } payload
 *       async_launched  → { threadId, agentPath }
 *       rejected        → { error: reason, isError: true }
 *
 * @module
 */

import { AgentControl, type LiveAgent } from "../agents/control.js";
import { delegate, type IsolationMode } from "../agents/delegate.js";
import {
  canonicalAgentRoleName,
  formatAgentRoleLabel,
} from "../agents/role-presentation.js";
import { AgentRegistry, type AgentPath } from "../agents/registry.js";
import { ThreadManager } from "../agents/thread-manager.js";
import { ConversationThreadManager } from "../conversation/thread-manager.js";
import type { Session } from "../session/session.js";
import type { Tool, ToolResult } from "./_deps/tools-types.js";
import { safeStringify } from "./_deps/tools-types.js";

const DELEGATE_TOOL_NAME = "system.agent.delegate";
const SESSION_AGENT_REGISTRY = Symbol("sessionAgentRegistry");

const DELEGATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["taskPrompt"],
  allOf: [
    {
      if: {
        properties: {
          isolation: { const: "worktree" },
        },
      },
      then: {
        required: ["taskPrompt", "worktreeSlug"],
      },
    },
  ],
  properties: {
    taskPrompt: {
      type: "string",
      description: "Task prompt handed to the child agent as its user message.",
    },
    role: {
      type: "string",
      description: "Built-in or user-defined role name. Defaults to `default`.",
    },
    isolation: {
      type: "string",
      enum: ["none", "cwd", "worktree"],
      description:
        "Isolation mode. `worktree` requires `worktreeSlug` and a git repo cwd.",
    },
    worktreeSlug: {
      type: "string",
      description: "Slug used when isolation=worktree.",
    },
    runInBackground: {
      type: "boolean",
      description:
        "When true, spawn asynchronously and return the handle immediately.",
    },
  },
};

/**
 * Per-session control plane cache. The CLI ships with a placeholder
 * `services.agentControl` stub so we can't use that; we lazy-construct
 * a real control plane the first time a delegate call lands and reuse
 * it for subsequent calls within the same process. Keyed by session so
 * multiple sessions don't share subagent state by accident.
 */
const controlCache: WeakMap<
  Session,
  { control: AgentControl; registry: AgentRegistry }
> = new WeakMap();

type AgentControlWithRegistry = AgentControl & {
  [SESSION_AGENT_REGISTRY]?: AgentRegistry;
};

export function bindSessionAgentControl(
  session: Session,
  pair: { control: AgentControl; registry: AgentRegistry },
): void {
  (pair.control as AgentControlWithRegistry)[SESSION_AGENT_REGISTRY] =
    pair.registry;
  controlCache.set(session, pair);
  try {
    const services = session.services as unknown as
      { agentControl?: unknown } | undefined;
    if (services !== undefined && services !== null) {
      services.agentControl = pair.control as unknown;
    }
  } catch {
    /* best effort */
  }
}

/**
 * Get (or create) the AgentControl + AgentRegistry pair for a session.
 * Exported so tests can prime the cache with stubs.
 */
export function ensureAgentControl(session: Session): {
  control: AgentControl;
  registry: AgentRegistry;
} {
  const cached = controlCache.get(session);
  if (cached) return cached;
  const services = (session.services ?? {}) as unknown as {
    agentControl?: unknown;
    threadManager?: unknown;
    conversationThreadManager?: unknown;
  };
  const bound = services.agentControl;
  if (bound instanceof AgentControl) {
    const registry = (bound as AgentControlWithRegistry)[
      SESSION_AGENT_REGISTRY
    ];
    if (registry instanceof AgentRegistry) {
      const pair = { control: bound, registry };
      controlCache.set(session, pair);
      return pair;
    }
  }
  const registry = new AgentRegistry({
    ...(session.config.agent_max_threads !== undefined
      ? { maxThreads: session.config.agent_max_threads }
      : {}),
  });
  const rawThreadManager =
    services.threadManager instanceof ThreadManager
      ? services.threadManager
      : new ThreadManager({ rootSession: session, registry });
  const existingThreadManager =
    services.conversationThreadManager instanceof ConversationThreadManager
      ? services.conversationThreadManager
      : services.threadManager instanceof ConversationThreadManager
        ? services.threadManager
        : new ConversationThreadManager({ threadManager: rawThreadManager });
  services.threadManager = existingThreadManager;
  services.conversationThreadManager = existingThreadManager;
  const control = new AgentControl({
    session,
    registry,
    threadManager: existingThreadManager,
  });
  existingThreadManager.bindAgentControl(control);
  control.registerSessionRoot(session.conversationId);
  const pair = { control, registry };
  bindSessionAgentControl(session, pair);
  return pair;
}

/**
 * Test-only: seed the per-session control-plane cache so a delegate
 * tool execution uses a prebuilt stub instead of constructing a real
 * AgentControl/AgentRegistry pair.
 */
export function _setAgentControlForTesting(
  session: Session,
  pair: { control: AgentControl; registry: AgentRegistry },
): void {
  bindSessionAgentControl(session, pair);
}

/**
 * Test-only: clear any cached control-plane so the next delegate call
 * re-runs `ensureAgentControl`.
 */
export function _clearAgentControlCacheForTesting(session: Session): void {
  controlCache.delete(session);
}

export interface DelegateToolOpts {
  /**
   * Session getter. Late-bound because the CLI builds the tool
   * registry (and therefore the tool list the provider sees at
   * construction) BEFORE the `Session` exists. The getter returns
   * null until the Session is wired in; the tool rejects with a
   * clear error until then.
   */
  readonly getSession: () => Session | null;
  /** Agent path the spawn is parented under. Defaults to "/root". */
  readonly parentPath?: AgentPath;
  /**
   * Override for the delegate dispatcher — tests inject a spy here
   * so we don't need a live provider + run-turn loop.
   */
  readonly delegateFn?: typeof delegate;
}

/**
 * Build the `system.agent.delegate` Tool. The session ref is
 * late-bound via a getter; the CLI supplies the real Session once
 * it's constructed. Tests pass a pre-made Session directly.
 */
export function buildDelegateTool(opts: DelegateToolOpts): Tool {
  const parentPath: AgentPath = opts.parentPath ?? "/root";
  const dispatch = opts.delegateFn ?? delegate;

  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const taskPrompt =
      typeof args.taskPrompt === "string" ? args.taskPrompt : "";
    if (!taskPrompt) {
      return {
        content: safeStringify({
          error: "taskPrompt is required and must be a non-empty string",
        }),
        isError: true,
      };
    }

    const role =
      typeof args.role === "string" && args.role.length > 0
        ? canonicalAgentRoleName(args.role)
        : undefined;
    const isolation = coerceIsolation(args.isolation);
    const worktreeSlugRaw =
      typeof args.worktreeSlug === "string" ? args.worktreeSlug : undefined;
    const worktreeSlug = worktreeSlugRaw;
    const runInBackground =
      typeof args.runInBackground === "boolean"
        ? args.runInBackground
        : undefined;

    if (
      isolation === "worktree" &&
      (!worktreeSlugRaw || worktreeSlugRaw.trim().length === 0)
    ) {
      return {
        content: safeStringify({
          error: 'worktreeSlug is required when isolation="worktree"',
        }),
        isError: true,
      };
    }

    const session = opts.getSession();
    if (!session) {
      return {
        content: safeStringify({
          error: "delegate tool invoked before session was initialized",
        }),
        isError: true,
      };
    }
    const { control, registry } = ensureAgentControl(session);

    try {
      const outcome = await dispatch({
        parent: session,
        parentPath,
        control,
        registry,
        taskPrompt,
        ...(role !== undefined ? { role } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        ...(runInBackground !== undefined ? { runInBackground } : {}),
      });

      switch (outcome.kind) {
        case "sync_completed": {
          const live: LiveAgent = outcome.thread.live;
          return {
            content: safeStringify({
              kind: "sync_completed",
              threadId: outcome.thread.threadId,
              agentPath: live.agentPath,
              nickname: live.nickname,
              role: live.role.name,
              roleDisplayName: formatAgentRoleLabel(live.role.name),
              finalMessage: outcome.result.finalMessage ?? null,
              outcome: outcome.result.outcome,
              toolCallCount: outcome.result.toolCallCount ?? 0,
              durationMs: outcome.result.durationMs,
            }),
          };
        }
        case "async_launched": {
          const live: LiveAgent = outcome.thread.live;
          return {
            content: safeStringify({
              kind: "async_launched",
              threadId: outcome.thread.threadId,
              agentPath: live.agentPath,
              nickname: live.nickname,
              role: live.role.name,
              roleDisplayName: formatAgentRoleLabel(live.role.name),
            }),
          };
        }
        case "rejected":
          return {
            content: safeStringify({
              kind: "rejected",
              error: outcome.reason,
            }),
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: safeStringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
      };
    }
  };

  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Spawn a subagent to handle a scoped task. Accepts any built-in or user-defined role name, optional worktree isolation, and sync vs async execution.",
    inputSchema: DELEGATE_INPUT_SCHEMA,
    metadata: {
      family: "agents",
      source: "builtin",
      keywords: ["delegate", "subagent", "spawn", "agent"],
    },
    execute,
  };
}

function coerceIsolation(v: unknown): IsolationMode | undefined {
  if (v === "none" || v === "cwd" || v === "worktree") return v;
  return undefined;
}

export const DELEGATE_TOOL_NAME_CONST: string = DELEGATE_TOOL_NAME;
