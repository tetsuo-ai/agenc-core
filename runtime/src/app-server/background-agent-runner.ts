/**
 * Starts daemon-owned background agents through the existing delegate runtime.
 *
 * F-06a keeps the daemon surface narrow: `agent.create` requests become
 * `delegate(..., runInBackground: true)` launches, and the daemon holds the
 * bootstrap/session handles so the child loop remains alive after the JSON-RPC
 * response is returned.
 */

import {
  bootstrapLocalRuntimeSession,
  type BootstrapLocalRuntimeSessionOptions,
  type LocalRuntimeBootstrap,
} from "../bin/bootstrap.js";
import { ensureAgentControl } from "../bin/delegate-tool.js";
import {
  delegate,
  type DelegateOpts,
  type DelegateOutcome,
} from "../agents/delegate.js";
import type { AgentControl } from "../agents/control.js";
import { MailboxClosedError } from "../agents/mailbox.js";
import type { AgentPath } from "../agents/registry.js";
import type { AgentThread } from "../agents/thread.js";
import type { RunAgentProgressEvent } from "../agents/run-agent.js";
import type { LLMContentPart } from "../llm/types.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { setRulesForSource } from "../permissions/rules.js";
import type { PermissionModeRegistry } from "../permissions/mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import { ABORT, DENIED, type ReviewDecision } from "../permissions/review-decision.js";
import { isFinal } from "../agents/status.js";
import type { AgentStatus as ThreadAgentStatus } from "../agents/status.js";
import type {
  AgenCDaemonSessionNotification,
  AgentStatus as DaemonAgentStatus,
  JsonObject,
  JsonValue,
  MessageContent,
} from "./protocol/index.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";

export interface AgenCBackgroundAgentStartParams {
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly metadata?: JsonObject;
  readonly unattendedAllow: readonly string[];
  readonly unattendedDeny: readonly string[];
}

export interface AgenCBackgroundAgentStartResult {
  readonly agentId: string;
  readonly agentPath?: string;
  readonly startedAt: string;
  readonly status: "running";
}

export interface AgenCBackgroundAgentSnapshot {
  readonly status: DaemonAgentStatus;
  readonly lastActiveAt: string;
}

export interface AgenCBackgroundAgentSessionEventBinding {
  readonly sessionId: string;
  readonly emit: (event: JsonObject) => void | Promise<void>;
}

export interface AgenCBackgroundAgentMessageParams {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly originalContent: MessageContent;
  readonly displayUserMessage?: string | null;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
}

export interface AgenCBackgroundAgentToolDecisionParams {
  readonly requestId: string;
  readonly decision: ReviewDecision;
}

export interface AgenCBackgroundAgentToolCancelParams {
  readonly requestId: string;
  readonly reason?: string;
}

export interface AgenCBackgroundAgentRunner {
  startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult>;
  getAgentSnapshot?(
    agentId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null>;
  stopAgent?(agentId: string, reason?: string): Promise<void>;
  attachAgentSessionEvents?(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> | void;
  submitAgentMessage?(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<void>;
  resolveToolDecision?(
    agentId: string,
    params: AgenCBackgroundAgentToolDecisionParams,
  ): Promise<boolean>;
  cancelTool?(
    agentId: string,
    params: AgenCBackgroundAgentToolCancelParams,
  ): Promise<boolean>;
}

export type AgenCDelegateFunction = (opts: DelegateOpts) => Promise<DelegateOutcome>;
export type AgenCBootstrapFunction = (
  options: BootstrapLocalRuntimeSessionOptions,
) => Promise<LocalRuntimeBootstrap>;
export type AgenCEnsureAgentControlFunction = typeof ensureAgentControl;

interface ActiveBackgroundAgent {
  readonly bootstrap: LocalRuntimeBootstrap;
  readonly control: AgentControl;
  readonly thread: AgentThread;
  status: DaemonAgentStatus;
  lastActiveAt: string;
  unsubscribeStatus?: () => void;
  uninstallApprovalBridge?: () => void;
  sessionBinding?: AgenCBackgroundAgentSessionEventBinding;
  bufferedEvents: BackgroundAgentDaemonEvent[];
  activeToolCallIds: Set<string>;
}

interface BackgroundAgentDaemonEvent {
  readonly id: string;
  readonly type: string;
  readonly payload?: JsonObject;
  readonly messageId?: string;
  readonly streamId?: string;
  readonly acceptedAt?: string;
}

export interface AgenCDelegateBackgroundAgentRunnerOptions {
  readonly bootstrap?: AgenCBootstrapFunction;
  readonly delegateFn?: AgenCDelegateFunction;
  readonly ensureAgentControl?: AgenCEnsureAgentControlFunction;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
}

export class AgenCDelegateBackgroundAgentRunner
  implements AgenCBackgroundAgentRunner
{
  readonly #bootstrap: AgenCBootstrapFunction;
  readonly #delegate: AgenCDelegateFunction;
  readonly #ensureAgentControl: AgenCEnsureAgentControlFunction;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #argv: readonly string[] | undefined;
  readonly #now: () => string;
  readonly #active = new Map<string, ActiveBackgroundAgent>();
  readonly #pendingEvents = new Map<string, BackgroundAgentDaemonEvent[]>();
  readonly #pendingActiveToolCallIds = new Map<string, Set<string>>();
  readonly #assistantTextByAgent = new Map<string, string>();
  readonly #pendingToolDecisions = new Map<
    string,
    Map<string, (decision: ReviewDecision) => void>
  >();

  constructor(options: AgenCDelegateBackgroundAgentRunnerOptions = {}) {
    this.#bootstrap = options.bootstrap ?? bootstrapLocalRuntimeSession;
    this.#delegate = options.delegateFn ?? delegate;
    this.#ensureAgentControl =
      options.ensureAgentControl ?? ensureAgentControl;
    this.#env = options.env;
    this.#argv = options.argv;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult> {
    const bootstrap = await this.#bootstrap({
      ...(this.#env !== undefined ? { env: this.#env } : {}),
      argv: buildBootstrapArgv(params, this.#argv),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });
    const uninstallApprovalBridge =
      this.#installDaemonApprovalBridge(bootstrap.session);

    try {
      const { control, registry } = this.#ensureAgentControl(bootstrap.session);
      await applyUnattendedPermissionPolicy(
        bootstrap.session.permissionModeRegistry,
        params.unattendedAllow,
        params.unattendedDeny,
      );
      const outcome = await this.#delegate({
        parent: bootstrap.session,
        parentPath: "/root" as AgentPath,
        control,
        registry,
        taskPrompt: params.objective,
        runInBackground: true,
        isolation: "cwd",
        ...(params.model !== undefined ? { model: params.model } : {}),
        onProgress: (event, thread) =>
          this.#recordProgressEvent(thread.threadId, event),
      });

      if (outcome.kind !== "async_launched") {
        throw new Error(
          outcome.kind === "rejected"
            ? outcome.reason
            : "background delegate returned synchronously",
        );
      }

      const startedAt = this.#now();
      const active: ActiveBackgroundAgent = {
        bootstrap,
        control,
        thread: outcome.thread,
        status: "running",
        lastActiveAt: startedAt,
        uninstallApprovalBridge,
        bufferedEvents: this.#pendingEvents.get(outcome.thread.threadId) ?? [],
        activeToolCallIds:
          this.#pendingActiveToolCallIds.get(outcome.thread.threadId) ??
          new Set(),
      };
      this.#pendingEvents.delete(outcome.thread.threadId);
      this.#pendingActiveToolCallIds.delete(outcome.thread.threadId);
      this.#trackAgentStatus(active);
      this.#active.set(outcome.thread.threadId, active);
      this.#cleanupWhenComplete(outcome.thread.threadId, outcome.thread);
      return {
        agentId: outcome.thread.threadId,
        agentPath: outcome.thread.agentPath,
        startedAt,
        status: "running",
      };
    } catch (error) {
      uninstallApprovalBridge();
      await bootstrap.shutdown().catch(() => {});
      throw error;
    }
  }

  async getAgentSnapshot(
    agentId: string,
  ): Promise<AgenCBackgroundAgentSnapshot | null> {
    const active = this.#active.get(agentId);
    if (active === undefined) return null;
    if (hasCurrentStatus(active.thread) && isFinal(active.thread.currentStatus)) {
      return null;
    }
    return {
      status: active.status,
      lastActiveAt: active.lastActiveAt,
    };
  }

  async stopAgent(agentId: string, reason = "daemon_agent_stop"): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    active.status = "stopping";
    active.lastActiveAt = this.#now();
    try {
      await active.control.shutdown(agentId, reason);
      await active.bootstrap.shutdown();
    } catch (error) {
      active.status = "error";
      active.lastActiveAt = this.#now();
      throw error;
    }
    this.#active.delete(agentId);
    this.#pendingEvents.delete(agentId);
    this.#assistantTextByAgent.delete(agentId);
    this.#pendingActiveToolCallIds.delete(agentId);
    active.unsubscribeStatus?.();
    active.uninstallApprovalBridge?.();
  }

  async attachAgentSessionEvents(
    agentId: string,
    binding: AgenCBackgroundAgentSessionEventBinding,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    active.sessionBinding = binding;
    const replay = active.bufferedEvents.splice(0);
    for (const event of replay) {
      await this.#emitDaemonEvent(active, event);
    }
  }

  async submitAgentMessage(
    agentId: string,
    params: AgenCBackgroundAgentMessageParams,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) {
      throw new Error(`AgenC daemon agent not running: ${agentId}`);
    }
    const input = messageContentToAgentInput(params.content);
    if (typeof input === "string") {
      await active.control.sendInput(agentId, input);
    } else {
      submitStructuredAgentInput(
        active,
        input,
        messageContentDisplayText(params.content),
      );
    }
    active.lastActiveAt = this.#now();
    if (params.displayUserMessage !== null) {
      const displayText =
        params.displayUserMessage ?? messageContentDisplayText(params.content);
      await this.#emitOrBufferEvent(active, {
        id: params.messageId,
        type: "user_message",
        messageId: params.messageId,
        streamId: params.streamId,
        acceptedAt: params.acceptedAt,
        payload: {
          message: params.originalContent,
          displayText,
        },
      });
    }
  }

  async resolveToolDecision(
    agentId: string,
    params: AgenCBackgroundAgentToolDecisionParams,
  ): Promise<boolean> {
    const pendingForAgent = this.#pendingToolDecisions.get(agentId);
    const resolve = pendingForAgent?.get(params.requestId);
    if (resolve === undefined) return false;
    pendingForAgent!.delete(params.requestId);
    if (pendingForAgent!.size === 0) {
      this.#pendingToolDecisions.delete(agentId);
    }
    resolve(params.decision);
    return true;
  }

  async cancelTool(
    agentId: string,
    params: AgenCBackgroundAgentToolCancelParams,
  ): Promise<boolean> {
    const pendingResolved = await this.resolveToolDecision(agentId, {
      requestId: params.requestId,
      decision: ABORT,
    });
    const active = this.#active.get(agentId);
    if (active === undefined) return pendingResolved;
    const activeToolMatched = active.activeToolCallIds.has(params.requestId);
    if (!pendingResolved && !activeToolMatched) return false;
    active.control.interrupt(
      agentId,
      params.reason ?? `tool.cancel:${params.requestId}`,
    );
    active.lastActiveAt = this.#now();
    return true;
  }

  #installDaemonApprovalBridge(session: LocalRuntimeBootstrap["session"]): () => void {
    const services = (session as { services?: {
      approvalResolver?: ApprovalResolver;
    } }).services;
    if (services === undefined) return () => {};
    const previousResolver = services.approvalResolver;
    const resolver: ApprovalResolver = {
      request: (ctx) => this.#requestDaemonToolDecision(ctx),
    };
    services.approvalResolver = resolver;
    return () => {
      if (services.approvalResolver === resolver) {
        if (previousResolver === undefined) {
          delete services.approvalResolver;
        } else {
          services.approvalResolver = previousResolver;
        }
      }
    };
  }

  async #requestDaemonToolDecision(ctx: ApprovalCtx): Promise<ReviewDecision> {
    const agentId = readApprovalAgentId(ctx);
    if (agentId === null) return DENIED;
    const requestId = ctx.callId;
    const decision = new Promise<ReviewDecision>((resolve) => {
      let pendingForAgent = this.#pendingToolDecisions.get(agentId);
      if (pendingForAgent === undefined) {
        pendingForAgent = new Map();
        this.#pendingToolDecisions.set(agentId, pendingForAgent);
      }
      pendingForAgent.set(requestId, resolve);
      const abort = (): void => {
        pendingForAgent!.delete(requestId);
        if (pendingForAgent!.size === 0) {
          this.#pendingToolDecisions.delete(agentId);
        }
        resolve(ABORT);
      };
      ctx.signal?.addEventListener("abort", abort, { once: true });
    });
    await this.#emitOrBufferAgentEvent(agentId, {
      id: requestId,
      type: "request_permissions",
      payload: {
        callId: requestId,
        toolName: ctx.toolName,
        turnId: ctx.turnId,
        permissions: ["tool.use"],
        ...(ctx.retryReason !== undefined ? { reason: ctx.retryReason } : {}),
        input: approvalInputFromPayload(ctx.invocation.payload),
      },
    });
    return decision;
  }

  #trackAgentStatus(active: ActiveBackgroundAgent): void {
    if (!hasStatusSubscription(active.thread)) return;
    let sawInitialStatus = false;
    active.unsubscribeStatus = active.thread.onStatusChange((status) => {
      active.status = mapThreadStatus(status);
      if (status.status === "running") {
        this.#assistantTextByAgent.set(active.thread.threadId, "");
      } else if (
        status.status === "completed" ||
        status.status === "errored" ||
        status.status === "interrupted" ||
        status.status === "shutdown" ||
        status.status === "not_found"
      ) {
        this.#assistantTextByAgent.delete(active.thread.threadId);
      }
      if (sawInitialStatus) {
        active.lastActiveAt = this.#now();
        void this.#emitOrBufferEvent(active, eventFromThreadStatus(status));
      } else {
        void this.#emitOrBufferEvent(active, eventFromThreadStatus(status));
      }
      sawInitialStatus = true;
    });
  }

  #cleanupWhenComplete(agentId: string, thread: AgentThread): void {
    void thread
      .join()
      .catch(() => {})
      .finally(async () => {
        const active = this.#active.get(agentId);
        if (active === undefined || active.thread !== thread) return;
        this.#active.delete(agentId);
        this.#pendingEvents.delete(agentId);
        this.#assistantTextByAgent.delete(agentId);
        this.#pendingActiveToolCallIds.delete(agentId);
        active.unsubscribeStatus?.();
        active.uninstallApprovalBridge?.();
        await active.bootstrap.shutdown().catch(() => {});
      });
  }

  async #emitOrBufferAgentEvent(
    agentId: string,
    event: BackgroundAgentDaemonEvent | null,
  ): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) {
      if (event !== null) {
        const pending = this.#pendingEvents.get(agentId) ?? [];
        pending.push(event);
        this.#pendingEvents.set(agentId, pending);
      }
      return;
    }
    await this.#emitOrBufferEvent(active, event);
  }

  async #recordProgressEvent(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): Promise<void> {
    this.#trackActiveToolCall(agentId, progress);
    const event = this.#eventFromProgress(agentId, progress);
    if (event === null) return;
    const active = this.#active.get(agentId);
    if (active === undefined) {
      const pending = this.#pendingEvents.get(agentId) ?? [];
      pending.push(event);
      this.#pendingEvents.set(agentId, pending);
      return;
    }
    await this.#emitOrBufferEvent(active, event);
  }

  #trackActiveToolCall(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): void {
    if (progress.kind !== "tool_call" && progress.kind !== "tool_result") {
      return;
    }
    const active = this.#active.get(agentId);
    const activeToolCallIds =
      active?.activeToolCallIds ??
      this.#pendingActiveToolCallIds.get(agentId) ??
      new Set<string>();
    if (progress.kind === "tool_call") {
      activeToolCallIds.add(progress.callId);
    } else {
      activeToolCallIds.delete(progress.callId);
    }
    if (active === undefined) {
      if (activeToolCallIds.size === 0) {
        this.#pendingActiveToolCallIds.delete(agentId);
      } else {
        this.#pendingActiveToolCallIds.set(agentId, activeToolCallIds);
      }
    }
  }

  #eventFromProgress(
    agentId: string,
    progress: RunAgentProgressEvent,
  ): BackgroundAgentDaemonEvent | null {
    if (progress.kind === "message" && progress.message.role === "assistant") {
      const text = messageText(progress.message.content);
      const previous = this.#assistantTextByAgent.get(agentId) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      this.#assistantTextByAgent.set(agentId, text);
      if (delta.length === 0) return null;
      return {
        id: `delta-${agentId}-${hashStable(`${previous.length}:${delta}`)}`,
        type: "agent_message_delta",
        payload: { delta },
      };
    }
    return eventFromProgress(agentId, progress);
  }

  async #emitOrBufferEvent(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent | null,
  ): Promise<void> {
    if (event === null) return;
    if (active.sessionBinding === undefined) {
      active.bufferedEvents.push(event);
      return;
    }
    await this.#emitDaemonEvent(active, event);
  }

  async #emitDaemonEvent(
    active: ActiveBackgroundAgent,
    event: BackgroundAgentDaemonEvent,
  ): Promise<void> {
    const binding = active.sessionBinding;
    if (binding === undefined) {
      active.bufferedEvents.push(event);
      return;
    }
    await binding.emit(
      notificationFromDaemonEvent(binding.sessionId, active.thread.threadId, event),
    );
  }
}

function notificationFromDaemonEvent(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): AgenCDaemonSessionNotification {
  const base = eventBaseParams(sessionId, agentId, event);
  const payload = event.payload;
  if (
    event.type === "agent_message_delta" &&
    isJsonObject(payload) &&
    typeof payload.delta === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.message_chunk",
      params: {
        ...base,
        ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        delta: payload.delta,
      },
    };
  }
  if (
    event.type === "tool_call_started" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    const input = toolRequestInputFromPayload(payload);
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.tool_request",
      params: {
        ...base,
        requestId: payload.callId,
        toolName: payload.toolName,
        ...(input !== undefined ? { input } : {}),
      },
    };
  }
  if (
    event.type === "request_permissions" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.permission_request",
      params: {
        ...base,
        requestId: payload.callId,
        ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
        ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
        permissions: stringArray(payload.permissions),
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      },
    };
  }
  if (
    (event.type === "turn_started" ||
      event.type === "turn_complete" ||
      event.type === "error") &&
    isJsonObject(payload)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status: agentStatusFromEventType(event.type),
        ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
        ...(typeof payload.message === "string"
          ? { message: payload.message }
          : typeof payload.lastAgentMessage === "string"
            ? { message: payload.lastAgentMessage }
            : {}),
      },
    };
  }
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.session_event",
    params: {
      ...base,
      event: {
        id: event.id,
        type: event.type,
        ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        ...(event.acceptedAt !== undefined ? { acceptedAt: event.acceptedAt } : {}),
        ...(payload !== undefined ? { payload } : {}),
      },
    },
  };
}

function eventBaseParams(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): {
  readonly sessionId: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly acceptedAt?: string;
} {
  return {
    sessionId,
    eventId: event.id,
    agentId,
    ...(event.acceptedAt !== undefined ? { acceptedAt: event.acceptedAt } : {}),
  };
}

function agentStatusFromEventType(type: string): DaemonAgentStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "error";
    case "turn_complete":
    default:
      return "idle";
  }
}

function toolRequestInputFromPayload(payload: JsonObject): JsonValue | undefined {
  if (payload.input !== undefined && isJsonValue(payload.input)) {
    return payload.input;
  }
  if (typeof payload.args !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload.args);
    return isJsonValue(parsed) ? parsed : payload.args;
  } catch {
    return payload.args;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(
        (item) => item === undefined || isJsonValue(item),
      );
    default:
      return false;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hasCurrentStatus(
  thread: AgentThread,
): thread is AgentThread & { readonly currentStatus: ThreadAgentStatus } {
  return "currentStatus" in thread;
}

function hasStatusSubscription(
  thread: AgentThread,
): thread is AgentThread & {
  onStatusChange(listener: (status: ThreadAgentStatus) => void): () => void;
} {
  return typeof thread.onStatusChange === "function";
}

function mapThreadStatus(status: ThreadAgentStatus): DaemonAgentStatus {
  switch (status.status) {
    case "completed":
    case "not_found":
    case "shutdown":
      return "stopped";
    case "errored":
      return "error";
    case "interrupted":
    case "pending_init":
    case "running":
      return "running";
  }
}

function eventFromThreadStatus(
  status: ThreadAgentStatus,
): BackgroundAgentDaemonEvent | null {
  switch (status.status) {
    case "running":
      return {
        id: status.turnId,
        type: "turn_started",
        payload: {
          turnId: status.turnId,
          ...(status.startedAtMs !== undefined
            ? { startedAt: status.startedAtMs }
            : {}),
        },
      };
    case "completed":
      return {
        id: status.turnId,
        type: "turn_complete",
        payload: {
          turnId: status.turnId,
          ...(status.lastMessage !== undefined
            ? { lastAgentMessage: status.lastMessage }
            : {}),
          ...(status.endedAtMs !== undefined ? { completedAt: status.endedAtMs } : {}),
        },
      };
    case "errored":
      return {
        id: status.turnId,
        type: "error",
        payload: {
          cause: "background_agent_error",
          message: status.error,
          turnId: status.turnId,
        },
      };
    case "interrupted":
      return {
        id: status.turnId,
        type: "turn_aborted",
        payload: {
          turnId: status.turnId,
          reason: status.reason,
        },
      };
    case "shutdown":
      return {
        id: `shutdown-${status.endedAtMs}`,
        type: "turn_aborted",
        payload: {
          reason: "shutdown",
        },
      };
    case "pending_init":
    case "not_found":
      return null;
  }
}

function eventFromProgress(
  agentId: string,
  progress: RunAgentProgressEvent,
): BackgroundAgentDaemonEvent | null {
  switch (progress.kind) {
    case "status":
      return {
        id: `status-${agentId}-${hashStable(progress.text)}`,
        type: "warning",
        payload: {
          cause: "background_agent_status",
          message: progress.text,
        },
      };
    case "message": {
      const text = messageText(progress.message.content);
      if (progress.message.role === "user") {
        return {
          id: `user-${agentId}-${hashStable(text)}`,
          type: "user_message",
          payload: {
            message: progress.message.content,
            displayText: text,
          },
        };
      }
      return {
        id: `agent-${agentId}-${hashStable(text)}`,
        type: "agent_message",
        payload: {
          message: text,
        },
      };
    }
    case "tool_call":
      return {
        id: progress.callId,
        type: "tool_call_started",
        payload: {
          callId: progress.callId,
          toolName: progress.toolName,
          args: progress.arguments ?? "{}",
        },
      };
    case "tool_result":
      return {
        id: `tool-result-${progress.callId}`,
        type: "tool_call_completed",
        payload: {
          callId: progress.callId,
          result: progress.result,
          isError: progress.isError,
          metadata: {
            toolName: progress.toolName,
          },
        },
      };
    case "run_error":
    case "run_interrupted":
    case "run_complete":
      void agentId;
      return null;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function messageContentToAgentInput(
  content: MessageContent,
): string | readonly LLMContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { url: part.image_url.url } };
  });
}

function submitStructuredAgentInput(
  active: ActiveBackgroundAgent,
  input: readonly LLMContentPart[],
  displayText: string,
): void {
  const live = active.thread.live;
  try {
    live.downInbox.send({
      author: live.agentPath,
      recipient: live.agentPath,
      content: displayText,
      triggerTurn: true,
      direction: "down",
      metadata: { kind: "user_input", inputContent: input },
    });
  } catch (error) {
    if (error instanceof MailboxClosedError) {
      throw new Error(`AgenC daemon agent not running: ${active.thread.threadId}`);
    }
    throw error;
  }
}

function messageContentDisplayText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function hashStable(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function readApprovalAgentId(ctx: ApprovalCtx): string | null {
  const session = ctx.invocation.session as { conversationId?: unknown };
  return typeof session.conversationId === "string" &&
    session.conversationId.length > 0
    ? session.conversationId
    : null;
}

function approvalInputFromPayload(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as {
    readonly kind?: unknown;
    readonly arguments?: unknown;
    readonly rawArguments?: unknown;
    readonly input?: unknown;
    readonly params?: unknown;
  };
  if (payload.kind === "function" && typeof payload.arguments === "string") {
    return parseJsonObject(payload.arguments);
  }
  if (payload.kind === "mcp" && typeof payload.rawArguments === "string") {
    return parseJsonObject(payload.rawArguments);
  }
  if (payload.kind === "custom" && typeof payload.input === "string") {
    return { input: payload.input };
  }
  if (
    payload.kind === "local_shell" &&
    payload.params !== null &&
    typeof payload.params === "object" &&
    !Array.isArray(payload.params)
  ) {
    return payload.params as JsonObject;
  }
  return {};
}

function parseJsonObject(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // Fall through to the raw-input carrier below.
  }
  return { input: raw };
}

function buildBootstrapArgv(
  params: AgenCBackgroundAgentStartParams,
  baseArgv: readonly string[] | undefined,
): readonly string[] {
  const argv = [...(baseArgv ?? process.argv)];
  appendFlag(argv, "--provider", params.provider);
  appendFlag(argv, "--model", params.model);
  appendFlag(argv, "--profile", params.profile);
  if (!argv.includes("--autonomous") && !argv.includes("--proactive")) {
    argv.push("--autonomous");
  }
  return argv;
}

function appendFlag(argv: string[], flag: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return;
  argv.push(flag, trimmed);
}

async function applyUnattendedPermissionPolicy(
  registry: PermissionModeRegistry,
  allow: readonly string[],
  deny: readonly string[],
): Promise<void> {
  const allowed = mergeRuleStrings(registry.current(), "allow", allow);
  const denied = mergeRuleStrings(registry.current(), "deny", deny);
  let next = setRulesForSource(registry.current(), "session", "allow", allowed);
  next = setRulesForSource(next, "session", "deny", denied);
  await registry.update(next);
}

function mergeRuleStrings(
  context: ToolPermissionContext,
  behavior: "allow" | "deny",
  values: readonly string[],
): readonly string[] {
  const existing =
    behavior === "allow"
      ? context.alwaysAllowRules.session ?? []
      : context.alwaysDenyRules.session ?? [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}
