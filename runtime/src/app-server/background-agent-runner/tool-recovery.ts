/**
 * Tool-call replay for recovered runs and tool-decision admission helpers.
 * Split out of background-agent-runner.ts as a pure move.
 */

import type { LocalRuntimeBootstrap } from "../../bin/bootstrap.js";
import {
  ROOT_AGENT_PATH,
  joinAgentPath,
  normalizeAgentMetadata,
  normalizeAgentNameForPath,
  type AgentMetadata,
} from "../../agents/registry.js";
import type { AgentThread } from "../../agents/thread.js";
import type { ManagedThread } from "../../agents/thread-manager.js";
import type {
  RunAgentProgressEvent,
  RunAgentResult,
} from "../../agents/run-agent.js";
import type { LLMMessage } from "../../llm/types.js";
import { freshDenialTracking } from "../../permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../../permissions/evaluator.js";
import type { ApprovalCtx } from "../../tools/orchestrator.js";
import { routerFromRegistry } from "../../tools/router.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../../tools/untrusted-tool-result-framing.js";
import type { ToolRegistry } from "../../tool-registry.js";
import { getPlan, getPlanFilePath } from "../../utils/plans.js";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
} from "../../tools/ExitPlanModeTool/constants.js";
import type { AgentId } from "../../types/ids.js";
import type {
  PermissionModeRegistry,
} from "../../permissions/permission-mode.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type { JsonObject, JsonValue } from "../protocol/index.js";

import { metadataStringField } from "./shared.js";
import type {
  AgenCBackgroundAgentRestoreParams,
  AgenCBackgroundAgentReplayToolCall,
  AgenCBackgroundAgentReplayToolResult,
  AgenCRunAgentFunction,
} from "./shared.js";

async function runRestoredAgentToCompletion(
  runAgentFn: AgenCRunAgentFunction,
  opts: {
    readonly thread: AgentThread;
    readonly parent: LocalRuntimeBootstrap["session"];
    readonly registry: ToolRegistry;
    readonly taskPrompt: string;
    readonly initialMessages: ReadonlyArray<LLMMessage>;
    readonly replayToolCalls: readonly AgenCBackgroundAgentReplayToolCall[];
    readonly currentSessionId?: string;
    readonly onReplayToolResult?: (
      result: AgenCBackgroundAgentReplayToolResult,
    ) => void | Promise<void>;
    readonly model?: string;
    readonly onProgress?: (
      event: RunAgentProgressEvent,
      thread: AgentThread,
    ) => void | Promise<void>;
  },
): Promise<RunAgentResult> {
  const replayedMessages = await replayRecoveredToolCalls(opts);
  const initialMessages =
    replayedMessages.length === 0
      ? opts.initialMessages
      : [...opts.initialMessages, ...replayedMessages];
  const iter = runAgentFn({
    live: opts.thread.live,
    parent: opts.parent,
    initialMessages,
    taskPrompt: opts.taskPrompt,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return step.value;
    }
    await opts.onProgress?.(step.value, opts.thread);
  }
}

async function replayRecoveredToolCalls<
  TThread extends AgentThread | ManagedThread,
>(opts: {
  readonly thread: TThread;
  readonly parent: LocalRuntimeBootstrap["session"];
  readonly registry: ToolRegistry;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly replayToolCalls: readonly AgenCBackgroundAgentReplayToolCall[];
  readonly currentSessionId?: string;
  readonly onReplayToolResult?: (
    result: AgenCBackgroundAgentReplayToolResult,
  ) => void | Promise<void>;
  readonly onProgress?: (
    event: RunAgentProgressEvent,
    thread: TThread,
  ) => void | Promise<void>;
}): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];
  for (const replay of opts.replayToolCalls) {
    const args = stringifyReplayToolArguments(replay.args);
    const registeredTool = opts.registry.tools.find(
      (tool) => tool.name === replay.toolName,
    );
    if (registeredTool?.recoveryCategory !== "idempotent") {
      if (opts.currentSessionId !== undefined) {
        await opts.onReplayToolResult?.({
          sessionId: opts.currentSessionId,
          callId: replay.callId,
          toolName: replay.toolName,
          result: `Recovered tool call ${replay.callId} was not replayed because the current tool registration is missing or not idempotent.`,
          isError: true,
          terminalStatus: "poisoned",
          ...(registeredTool?.recoveryCategory !== undefined
            ? { recoveryCategory: registeredTool.recoveryCategory }
            : {}),
        });
      }
      continue;
    }
    await opts.onProgress?.(
      {
        kind: "tool_call",
        callId: replay.callId,
        toolName: replay.toolName,
        arguments: args,
        recoveryCategory: "idempotent",
      },
      opts.thread,
    );
    const result = await dispatchReplayToolCall({
      registry: opts.registry,
      session: opts.parent,
      toolCall: {
        id: replay.callId,
        name: replay.toolName,
        arguments: args,
      },
    });
    if (opts.currentSessionId !== undefined) {
      await opts.onReplayToolResult?.({
        sessionId: opts.currentSessionId,
        callId: replay.callId,
        toolName: replay.toolName,
        result: result.content,
        isError: result.isError === true,
        terminalStatus: result.isError === true ? "failed" : "completed",
        recoveryCategory: "idempotent",
      });
    }
    await opts.onProgress?.(
      {
        kind: "tool_result",
        callId: replay.callId,
        toolName: replay.toolName,
        result: result.content,
        isError: result.isError === true,
      },
      opts.thread,
    );
    if (
      !hasAssistantToolCall(
        [...opts.initialMessages, ...messages],
        replay.callId,
      )
    ) {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: replay.callId,
            name: replay.toolName,
            arguments: args,
          },
        ],
      });
    }
    messages.push({
      role: "tool",
      content: frameUntrustedToolResultContent(
        replay.toolName,
        result.content,
        classifyUntrustedToolResult(replay.toolName, registeredTool),
      ),
      toolCallId: replay.callId,
      toolName: replay.toolName,
    });
  }
  return messages;
}

async function hydrateRecoveredSessionHistory(
  session: LocalRuntimeBootstrap["session"],
  params: {
    readonly initialMessages: ReadonlyArray<LLMMessage>;
    readonly replayedMessages: ReadonlyArray<LLMMessage>;
  },
): Promise<void> {
  if (
    params.initialMessages.length === 0 &&
    params.replayedMessages.length === 0
  ) {
    return;
  }
  const stateLock = (
    session as {
      readonly state?: {
        with?: (
          fn: (state: { history?: unknown }) => void | Promise<void>,
        ) => Promise<void> | void;
      };
    }
  ).state;
  if (typeof stateLock?.with !== "function") return;
  await stateLock.with((state) => {
    const current = Array.isArray(state.history) ? state.history : [];
    const next =
      current.length === 0
        ? [...params.initialMessages, ...params.replayedMessages]
        : [
            ...current,
            ...params.replayedMessages.filter(
              (message) => !historyContainsRecoveredMessage(current, message),
            ),
          ];
    state.history = next.map(cloneRecoveredLlmMessage);
  });
}

function historyContainsRecoveredMessage(
  history: ReadonlyArray<unknown>,
  message: LLMMessage,
): boolean {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    const ids = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    return history.some((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const toolCalls = (entry as { readonly toolCalls?: unknown }).toolCalls;
      return (
        Array.isArray(toolCalls) &&
        toolCalls.some(
          (toolCall) =>
            toolCall !== null &&
            typeof toolCall === "object" &&
            ids.has(String((toolCall as { readonly id?: unknown }).id)),
        )
      );
    });
  }
  if (message.role === "tool" && typeof message.toolCallId === "string") {
    return history.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { readonly role?: unknown }).role === "tool" &&
        (entry as { readonly toolCallId?: unknown }).toolCallId ===
          message.toolCallId,
    );
  }
  return false;
}

function cloneRecoveredLlmMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
        }
      : {}),
  };
}

function hasAssistantToolCall(
  messages: readonly LLMMessage[],
  toolCallId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((toolCall) => toolCall.id === toolCallId) ===
        true,
  );
}

function stringifyReplayToolArguments(value: JsonValue): string {
  return JSON.stringify(value);
}

async function dispatchReplayToolCall(opts: {
  readonly registry: ToolRegistry;
  readonly session: LocalRuntimeBootstrap["session"];
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
}): Promise<{ readonly content: string; readonly isError?: boolean }> {
  try {
    const tool = opts.registry.tools.find(
      (candidate) => candidate.name === opts.toolCall.name,
    );
    if (tool === undefined || typeof tool.execute !== "function") {
      return {
        content:
          "Recovered tool call could not be replayed because the current tool registration is not executable.",
        isError: true,
      };
    }
    const router = routerFromRegistry(opts.registry);
    const permissionModeRegistry = opts.session.permissionModeRegistry;
    const permissionContext = permissionModeRegistry
      ? buildReplayPermissionContext(opts.session, permissionModeRegistry)
      : null;
    const modeChangeRegistry =
      typeof permissionModeRegistry?.subscribeToModeChange === "function"
        ? permissionModeRegistry
        : undefined;
    return await router.dispatchModelToolCall(opts.toolCall, {
      session: opts.session as Session,
      turn: buildReplayTurnContext(opts.session, opts.toolCall.id),
      tracker: replayNoopTracker,
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      ...(permissionContext !== null
        ? {
            canUseTool: hasPermissionsToUseTool,
            permissionContext,
            ...(modeChangeRegistry !== undefined ? { modeChangeRegistry } : {}),
          }
        : {}),
    });
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

const replayNoopTracker = {
  appendFileDiff: () => {},
  snapshot: () => [],
  clear: () => {},
};

function buildReplayPermissionContext(
  session: LocalRuntimeBootstrap["session"],
  permissionModeRegistry: PermissionModeRegistry,
): ToolEvaluatorContext {
  const denialTracking =
    (
      session as {
        readonly denialTracking?: ReturnType<typeof freshDenialTracking>;
      }
    ).denialTracking ?? freshDenialTracking();
  return attachContextDefaults({
    session: session as Session,
    denialTracking,
    executionSurface: "headless",
    getAppState: (): AppStateSnapshot => {
      const current = permissionModeRegistry.current();
      return {
        toolPermissionContext: current,
        denialTracking,
        autoModeActive: current.autoModeActive === true,
      };
    },
  });
}

function buildReplayTurnContext(
  session: LocalRuntimeBootstrap["session"],
  subId: string,
): TurnContext {
  const sessionRecord = session as {
    readonly config?: unknown;
    readonly modelInfo?: unknown;
    readonly provider?: unknown;
    readonly cwd?: unknown;
  };
  const config = (sessionRecord.config ?? {}) as TurnContext["config"];
  return {
    subId,
    config,
    configSnapshot: config,
    modelInfo: (sessionRecord.modelInfo ?? {
      slug: "background-replay",
      effectiveContextWindowPercent: 100,
      contextWindow: 8192,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    }) as TurnContext["modelInfo"],
    provider: (sessionRecord.provider ?? {}) as TurnContext["provider"],
    cwd: typeof sessionRecord.cwd === "string" ? sessionRecord.cwd : "/tmp",
    realtimeActive: false,
    modelProviderId: "background-replay",
    reasoningSummary: "auto",
    sessionSource: "sdk",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
  } as unknown as TurnContext;
}

function restoredAgentMetadata(
  params: AgenCBackgroundAgentRestoreParams,
): AgentMetadata {
  const metadata = params.metadata;
  const agentPath =
    metadataStringField(metadata, "agentPath") ??
    metadataStringField(metadata, "agent_path") ??
    joinAgentPath(ROOT_AGENT_PATH, normalizeAgentNameForPath(params.agentId));
  return normalizeAgentMetadata({
    agentId: params.agentId,
    agentPath,
    ...(metadata?.agentNickname !== undefined
      ? { agentNickname: metadata.agentNickname }
      : {}),
    ...(metadata?.agentRole !== undefined
      ? { agentRole: metadata.agentRole }
      : {}),
    ...(metadata?.agentRoleWorkspaceId !== undefined
      ? { agentRoleWorkspaceId: metadata.agentRoleWorkspaceId }
      : {}),
    ...(metadata?.agentRoleFingerprint !== undefined
      ? { agentRoleFingerprint: metadata.agentRoleFingerprint }
      : {}),
    depth: metadata?.depth ?? 1,
  });
}

export function resolvePermissionDecisionTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.AGENC_PERMISSION_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readApprovalAgentId(ctx: ApprovalCtx): string | null {
  const session = ctx.invocation.session as { conversationId?: unknown };
  return typeof session.conversationId === "string" &&
    session.conversationId.length > 0
    ? session.conversationId
    : null;
}

/**
 * For an ExitPlanMode approval, enrich the request_permissions payload with the
 * plan content and path so the TUI overlay can render the plan being approved.
 * Falls back to the tool input's `plan` string when the on-disk plan is empty.
 * Returns an empty object for any other tool.
 *
 * Exported (under a test-scoped name) so the enrichment can be unit-tested
 * directly with mocked getPlan/getPlanFilePath without bootstrapping an agent.
 */
export function planApprovalPayloadFields(
  toolName: string,
  agentId: string,
  input: JsonObject,
): JsonObject {
  if (toolName !== EXIT_PLAN_MODE_TOOL_NAME) return {};
  const fields: Record<string, JsonValue> = {};
  const agent = agentId as AgentId;
  let planContent: string | null = null;
  try {
    planContent = getPlan(agent);
  } catch {
    planContent = null;
  }
  if (
    (planContent === null || planContent.length === 0) &&
    typeof input.plan === "string" &&
    input.plan.length > 0
  ) {
    planContent = input.plan;
  }
  if (typeof planContent === "string" && planContent.length > 0) {
    fields.planContent = planContent;
  }
  let planFilePath: string | undefined;
  try {
    planFilePath = getPlanFilePath(agent);
  } catch {
    planFilePath = undefined;
  }
  if (typeof planFilePath === "string" && planFilePath.length > 0) {
    fields.planFilePath = planFilePath;
  }
  return fields;
}

// runRestoredAgentToCompletion / restoredAgentMetadata are retained for
// compatibility with the older fork-loop restore path while the live
// ManagedThread restore path handles replay directly above.
void [runRestoredAgentToCompletion, restoredAgentMetadata];

export {
  replayRecoveredToolCalls,
  hydrateRecoveredSessionHistory,
  readApprovalAgentId,
};
