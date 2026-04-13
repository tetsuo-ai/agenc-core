/**
 * WebChat channel plugin for the AgenC Gateway.
 *
 * Unlike Telegram/Discord, WebChat does not manage its own transport.
 * It hooks into the Gateway's existing WebSocket server. The Gateway routes
 * any message with a dotted-namespace type (e.g. 'chat.message', 'skills.list')
 * to this plugin via the WebChatHandler delegate interface.
 *
 * @module
 */

import { BaseChannelPlugin } from "../../gateway/channel.js";
import type { ChannelContext } from "../../gateway/channel.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type {
  OutboundMessage,
  MessageAttachment,
} from "../../gateway/message.js";
import { createGatewayMessage } from "../../gateway/message.js";
import { resolveSessionWorkspaceRoot } from "../../gateway/host-workspace.js";
import { deriveSessionId } from "../../gateway/session.js";
import {
  coerceSessionShellProfile,
  type SessionShellProfile,
} from "../../gateway/shell-profile.js";
import {
  evaluateShellFeatureRollout,
  resolveConfiguredShellProfile,
} from "../../gateway/shell-rollout.js";
import type { GatewayAutonomyConfig } from "../../gateway/types.js";
import { DEFAULT_WORKSPACE_ID } from "../../gateway/workspace.js";
import type { ControlMessage, ControlResponse } from "../../gateway/types.js";
import {
  forkSessionRuntimeState,
  loadPersistedSessionRuntimeState,
  type PersistedSessionRuntimeState,
} from "../../gateway/daemon-session-state.js";
import type { ActiveTaskContext } from "../../llm/turn-execution-contract-types.js";
import { safeStringify } from "../../tools/types.js";
import { summarizeTracePayloadForPreview } from "../../utils/trace-payload-serialization.js";
import type {
  WebChatHandler,
  WebChatDeps,
  WebChatChannelConfig,
  SessionContinuityRecord,
  SessionContinuityDetail,
  SessionForkResult,
  SessionHistoryItem,
  SessionResumePayload,
  SessionResumabilityState,
} from "./types.js";
import type {
  SessionCommandExecutePayload,
  SessionCommandResultData,
  SessionCommandResultPayload,
} from "./protocol.js";
import { HANDLER_MAP } from "./handlers.js";
import type { SendFn } from "./handlers.js";
import type { HandlerRequestContext } from "./handlers.js";
import {
  matchesEventFilters,
  type SocialMessagePayload,
} from "./protocol.js";
import {
  WebChatSessionStore,
  type PersistedWebChatSession,
  type PersistedWebChatForkSource,
  type PersistedWebChatSessionMetadata,
  type PersistedWebChatOwnerCredential,
  type PersistedWebChatPolicyContext,
} from "./session-store.js";

const MESSAGE_ID_TTL_MS = 5 * 60_000;
const MAX_TRACKED_MESSAGE_IDS = 5_000;
const WS_TRACE_PAYLOAD_MAX_CHARS = 2_000;
const execFileAsync = promisify(execFile);

function compactPreview(content: string, maxChars = 140): string | undefined {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.slice(0, maxChars);
}

async function resolveGitSnapshot(
  workspaceRoot: string | undefined,
): Promise<{
  repoRoot?: string;
  branch?: string;
  head?: string;
}> {
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return {};
  }
  try {
    const cwd = resolvePath(workspaceRoot);
    const [{ stdout: repoRootStdout }, { stdout: branchStdout }, { stdout: headStdout }] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd }),
        execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
        execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      ]);
    const repoRoot = repoRootStdout.trim();
    const branch = branchStdout.trim();
    const head = headStdout.trim();
    return {
      ...(repoRoot ? { repoRoot } : {}),
      ...(branch && branch !== "HEAD" ? { branch } : {}),
      ...(head ? { head } : {}),
    };
  } catch {
    return {};
  }
}

// ============================================================================
// WebChatChannel
// ============================================================================

/**
 * Channel plugin that bridges WebSocket clients to the AgenC Gateway.
 *
 * Implements both ChannelPlugin (for PluginCatalog compatibility) and
 * WebChatHandler (for Gateway WS message routing).
 *
 * Each WS connection gets a clientId from the Gateway's auto-incrementing
 * counter. WebChat session IDs are intentionally salted with randomness so a
 * daemon restart cannot accidentally reuse old persisted memory by session ID.
 * Session continuity across reconnects is supported via explicit
 * 'chat.session.resume' requests. Legacy 'chat.resume' is kept as a
 * compatibility alias for non-upgraded external clients.
 */
export class WebChatChannel
  extends BaseChannelPlugin
  implements WebChatHandler
{
  readonly name = "webchat";

  private deps: WebChatDeps;

  // clientId → sessionId mapping (for outbound routing)
  private readonly clientSessions = new Map<string, string>();
  // sessionId → clientId reverse mapping (for send())
  private readonly sessionClients = new Map<string, string>();
  // clientId → server-authenticated durable owner key
  private readonly clientOwnerKeys = new Map<string, string>();
  // clientId → send function (for pushing messages to specific clients)
  private readonly clientSenders = new Map<string, SendFn>();
  // Security: sessionId → durable owner key (or volatile client fallback)
  private readonly sessionOwners = new Map<string, string>();
  // sessionId → chat history for resume support
  private readonly sessionHistory = new Map<
    string,
    Array<{ content: string; sender: "user" | "agent"; timestamp: number }>
  >();
  private readonly sessionPolicyContexts = new Map<
    string,
    PersistedWebChatPolicyContext
  >();
  private readonly sessionWorkspaceRoots = new Map<string, string>();
  // clientIds subscribed to events and their optional filters
  private readonly eventSubscribers = new Map<string, readonly string[] | null>();
  // sessionId → AbortController for in-flight chat execution
  private readonly sessionAbortControllers = new Map<string, AbortController>();
  // Dedup replayed chat.message envelopes (e.g. reconnect flush/retry)
  // per durable owner so fresh clients/runs can safely reuse local counters.
  private readonly seenMessageIds = new Map<
    string,
    { seenAt: number; sessionId: string }
  >();
  private readonly sessionStore?: WebChatSessionStore;

  private healthy = true;

  constructor(deps: WebChatDeps, _config?: WebChatChannelConfig) {
    super();
    this.deps = deps;
    this.sessionStore =
      deps.memoryBackend &&
      typeof deps.memoryBackend.get === "function" &&
      typeof deps.memoryBackend.set === "function"
      ? new WebChatSessionStore({ memoryBackend: deps.memoryBackend })
      : undefined;
  }

  /** Create and track an AbortController for a session's in-flight execution. */
  createAbortController(sessionId: string): AbortController {
    // Abort any existing in-flight execution for this session
    const existing = this.sessionAbortControllers.get(sessionId);
    if (existing) {
      existing.abort();
      this.sessionAbortControllers.delete(sessionId);
    }
    const controller = new AbortController();
    this.sessionAbortControllers.set(sessionId, controller);
    return controller;
  }

  /** Cancel the in-flight execution for a session. */
  cancelSession(sessionId: string): boolean {
    const controller = this.sessionAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionAbortControllers.delete(sessionId);
      return true;
    }
    return false;
  }

  /** Clean up the controller after execution completes. */
  clearAbortController(sessionId: string): void {
    this.sessionAbortControllers.delete(sessionId);
  }

  async loadSessionWorkspaceRoot(sessionId: string): Promise<string | undefined> {
    const cached = this.sessionWorkspaceRoots.get(sessionId);
    if (cached) {
      return cached;
    }
    const persisted = await this.sessionStore?.loadSession(sessionId);
    this.rememberPersistedSessionMetadata(sessionId, persisted);
    return this.sessionWorkspaceRoots.get(sessionId);
  }

  /** Replace the voice bridge at runtime (e.g. after config hot-reload). */
  updateVoiceBridge(
    bridge: import("../../gateway/voice-bridge.js").VoiceBridge | null,
  ): void {
    this.deps = { ...this.deps, voiceBridge: bridge ?? undefined };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  override async initialize(context: ChannelContext): Promise<void> {
    await super.initialize(context);
  }

  override async start(): Promise<void> {
    this.healthy = true;
    this.context.logger.info("WebChat channel started");
  }

  override async stop(): Promise<void> {
    this.clientSessions.clear();
    this.sessionClients.clear();
    this.clientOwnerKeys.clear();
    this.clientSenders.clear();
    this.sessionOwners.clear();
    this.sessionHistory.clear();
    this.sessionPolicyContexts.clear();
    this.sessionWorkspaceRoots.clear();
    this.eventSubscribers.clear();
    this.seenMessageIds.clear();
    this.healthy = false;
    this.context.logger.info("WebChat channel stopped");
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Push to session (daemon → specific WS client by sessionId)
  // --------------------------------------------------------------------------

  /**
   * Push a message to a specific session's WS client. Used by the daemon to
   * send tool events, typing indicators, and approval requests mid-execution.
   */
  pushToSession(sessionId: string, response: ControlResponse): void {
    const clientId = this.sessionClients.get(sessionId);
    if (!clientId) return;
    const send = this.clientSenders.get(clientId);
    if (!send) return;
    this.sendTracedControlResponse(clientId, sessionId, send, response);
  }

  listActiveSessions(): Array<{
    sessionId: string;
    clientId: string;
    workspaceRoot?: string;
  }> {
    return [...this.sessionClients.entries()].map(([sessionId, clientId]) => ({
      sessionId,
      clientId,
      ...(this.sessionWorkspaceRoots.get(sessionId)
        ? { workspaceRoot: this.sessionWorkspaceRoots.get(sessionId) }
        : {}),
    }));
  }

  /**
   * Surface an inbound peer-to-peer social message to every active session on
   * this daemon without replaying it as the daemon agent's own chat history.
   */
  pushSocialMessageToActiveSessions(payload: SocialMessagePayload): number {
    let delivered = 0;
    for (const [sessionId, clientId] of this.sessionClients.entries()) {
      const send = this.clientSenders.get(clientId);
      if (!send) continue;
      this.sendTracedControlResponse(clientId, sessionId, send, {
        type: "social.message",
        payload: {
          ...payload,
          sessionId,
        },
      });
      delivered += 1;
    }
    return delivered;
  }

  // --------------------------------------------------------------------------
  // Outbound (Gateway → WebSocket client)
  // --------------------------------------------------------------------------

  override async send(message: OutboundMessage): Promise<void> {
    const timestamp = Date.now();

    // Store in history for resume
    this.appendHistory(message.sessionId, {
      content: message.content,
      sender: "agent",
      timestamp,
    });
    await this.persistSessionActivity(message.sessionId, {
      content: message.content,
      sender: "agent",
      timestamp,
    });

    const clientId = this.sessionClients.get(message.sessionId);
    if (!clientId) {
      this.context.logger.debug?.(
        `WebChat: no client mapping for session "${message.sessionId}"`,
      );
      return;
    }

    const sendFn = this.clientSenders.get(clientId);
    if (!sendFn) {
      this.context.logger.debug?.(
        `WebChat: no send function for client "${clientId}"`,
      );
      return;
    }

    this.sendTracedControlResponse(clientId, message.sessionId, sendFn, {
      type: "chat.message",
      payload: {
        content: message.content,
        sender: "agent",
        timestamp,
      },
    });
  }

  // --------------------------------------------------------------------------
  // WebChatHandler (Gateway delegates dotted-namespace messages here)
  // --------------------------------------------------------------------------

  handleMessage(
    clientId: string,
    type: string,
    msg: ControlMessage,
    send: (response: ControlResponse) => void,
  ): void {
    // Store sender for outbound routing
    this.clientSenders.set(clientId, send);
    const tracedSend: SendFn = (response) => {
      this.sendTracedControlResponse(
        clientId,
        this.clientSessions.get(clientId),
        send,
        response,
      );
    };

    const id = typeof msg.id === "string" ? msg.id : undefined;
    let payload = msg.payload as Record<string, unknown> | undefined;

    // Voice messages are routed to the voice bridge
    if (type.startsWith("voice.")) {
      this.handleVoiceMessage(clientId, type, payload, id, tracedSend);
      return;
    }

    // Event subscriptions need clientId — handled here, not in HANDLER_MAP
    if (type.startsWith("events.")) {
      this.handleEventMessage(clientId, type, payload, id, tracedSend);
      return;
    }

    // Chat messages are special — they go through the Gateway's message pipeline
    if (type === "chat.message") {
      this.handleChatMessage(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.typing") {
      // Typing indicators are noted but not forwarded
      return;
    }

    if (type === "chat.cancel") {
      const sessionId = this.clientSessions.get(clientId);
      const foregroundCancelled = sessionId ? this.cancelSession(sessionId) : false;
      const backgroundCancelled = sessionId
        ? this.deps.cancelBackgroundRun?.(sessionId)
        : false;
      void Promise.resolve(backgroundCancelled).then((result) => {
        tracedSend({
          type: "chat.cancelled",
          payload: { cancelled: foregroundCancelled || Boolean(result) },
          id,
        });
      });
      return;
    }

    if (type === "chat.new") {
      this.handleChatNew(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.history") {
      this.handleChatHistory(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "chat.resume" || type === "chat.session.resume") {
      this.handleChatResume(clientId, payload, id, tracedSend, type);
      return;
    }

    if (type === "chat.sessions" || type === "chat.session.list") {
      this.handleChatSessions(clientId, payload, id, tracedSend, type);
      return;
    }

    if (type === "chat.session.inspect") {
      this.handleChatInspect(clientId, payload, id, tracedSend, type);
      return;
    }

    if (type === "chat.session.fork") {
      this.handleChatFork(clientId, payload, id, tracedSend, type);
      return;
    }

    if (type === "watch.cockpit.get") {
      this.handleWatchCockpitGet(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "session.command.catalog.get") {
      this.handleSessionCommandCatalog(clientId, payload, id, tracedSend);
      return;
    }

    if (type === "session.command.execute") {
      this.handleSessionCommandExecute(clientId, payload, id, tracedSend);
      return;
    }

    // Desktop create/attach should default to the active webchat session so
    // the chat pane and desktop pane point at the same sandbox.
    if (type === "desktop.create" || type === "desktop.attach") {
      const normalizedPayload =
        payload && typeof payload === "object" ? { ...payload } : {};
      let workspaceRoot: string | undefined;
      try {
        workspaceRoot = this.parseWorkspaceRoot(normalizedPayload);
      } catch (error) {
        tracedSend({
          type: "error",
          error: (error as Error).message,
          id,
        });
        return;
      }
      if (
        typeof normalizedPayload.sessionId !== "string" ||
        normalizedPayload.sessionId.length === 0
      ) {
        const sessionId = this.ensureSession(
          clientId,
          this.currentOwnerKey(clientId),
          {
            metadata: workspaceRoot ? { workspaceRoot } : undefined,
          },
        );
        normalizedPayload.sessionId = sessionId;
        tracedSend({
          type: "chat.session",
          payload: this.buildChatSessionPayload(sessionId, workspaceRoot),
        });
      }
      payload = normalizedPayload;
    }

    // Delegate to subsystem handlers (may be async)
    const handler = HANDLER_MAP[type];
    if (handler) {
      const requestContext: HandlerRequestContext = {
        clientId,
        ownerKey: this.currentOwnerKey(clientId),
        actorId: this.currentActorId(clientId),
        channel: this.name,
        activeSessionId: this.clientSessions.get(clientId),
        listOwnedSessionIds: () => this.listOwnedSessionIds(clientId),
        isSessionOwned: (sessionId: string) =>
          this.sessionOwners.get(sessionId) === this.currentOwnerKey(clientId),
      };
      const result = handler(this.deps, payload, id, tracedSend, requestContext);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.context.logger.warn?.("WebChat handler error:", err);
          tracedSend({
            type: "error",
            error: `Handler error: ${(err as Error).message}`,
            id,
          });
        });
      }
      return;
    }

    tracedSend({ type: "error", error: `Unknown webchat message type: ${type}`, id });
  }

  private sendTracedControlResponse(
    clientId: string,
    sessionId: string | undefined,
    send: SendFn,
    response: ControlResponse,
  ): void {
    this.traceOutboundControlResponse(clientId, sessionId, response);
    send(response);
  }

  private traceOutboundControlResponse(
    clientId: string,
    sessionId: string | undefined,
    response: ControlResponse,
  ): void {
    const payload = response.payload;
    const payloadSessionId =
      payload &&
      typeof payload === "object" &&
      "sessionId" in payload &&
      typeof payload.sessionId === "string"
        ? payload.sessionId
        : undefined;
    const traceLine = {
      clientId,
      ...(payloadSessionId || sessionId
        ? { sessionId: payloadSessionId ?? sessionId }
        : {}),
      type: response.type,
      ...(typeof response.id === "string" ? { id: response.id } : {}),
      ...(typeof response.error === "string" ? { error: response.error } : {}),
      payloadPreview: summarizeTracePayloadForPreview(
        payload ?? null,
        WS_TRACE_PAYLOAD_MAX_CHARS,
      ),
    };
    this.context.logger.info(
      `[trace] webchat.ws.outbound ${safeStringify(traceLine)}`,
    );
  }

  // --------------------------------------------------------------------------
  // Voice message handling
  // --------------------------------------------------------------------------

  private handleVoiceMessage(
    clientId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const bridge = this.deps.voiceBridge;
    if (!bridge) {
      send({
        type: "voice.error",
        payload: {
          message:
            "Voice not available — no LLM provider with voice support configured",
        },
        id,
      });
      return;
    }

    switch (type) {
      case "voice.start": {
        // Pass the client's current sessionId so voice and text share history
        const voiceSessionId = this.ensureSession(
          clientId,
          this.currentOwnerKey(clientId),
        );
        void bridge.startSession(clientId, send, voiceSessionId).catch((error) => {
          this.context.logger?.warn?.("Failed to start voice session:", error);
          send({
            type: "voice.error",
            payload: { message: (error as Error).message },
            id,
          });
        });
        break;
      }
      case "voice.audio": {
        const audio = payload?.audio;
        if (typeof audio === "string") {
          bridge.sendAudio(clientId, audio);
        } else {
          send({
            type: "voice.error",
            payload: { message: "Invalid voice.audio payload" },
            id,
          });
        }
        break;
      }
      case "voice.commit":
        bridge.commitAudio(clientId);
        break;
      case "voice.stop":
        void bridge.stopSession(clientId);
        break;
      default:
        send({
          type: "voice.error",
          payload: {
            message: `Unknown voice message type: ${type}`,
          },
          id,
        });
    }
  }

  // --------------------------------------------------------------------------
  // Chat message handling
  // --------------------------------------------------------------------------

  private handleChatMessage(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const content =
      (payload as Record<string, unknown> | undefined)?.content ??
      (payload as unknown);
    const rawAttachments = (payload as Record<string, unknown> | undefined)
      ?.attachments;

    // Allow empty content if attachments are present
    const hasAttachments =
      Array.isArray(rawAttachments) && rawAttachments.length > 0;
    if (
      typeof content !== "string" ||
      (content.trim().length === 0 && !hasAttachments)
    ) {
      send({
        type: "error",
        error: "Missing or empty content in chat.message",
        id,
      });
      return;
    }

    this.withResolvedOwner(
      clientId,
      payload,
      send,
      (ownerKey) => {
        const workspaceRoot = this.parseWorkspaceRoot(payload);
        const shellProfile = this.parseShellProfile(payload);
        const messageKey =
          typeof id === "string"
            ? this.buildSeenMessageKey(ownerKey, id)
            : undefined;
        const duplicateSessionId = messageKey
          ? this.getDuplicateSessionId(messageKey)
          : undefined;
        if (duplicateSessionId) {
          this.bindClientToSession(clientId, duplicateSessionId, ownerKey);
          void this.upsertSessionWorkspaceRoot(
            duplicateSessionId,
            ownerKey,
            workspaceRoot,
          );
          send({
            type: "chat.session",
            payload: this.buildChatSessionPayload(
              duplicateSessionId,
              workspaceRoot,
            ),
            id,
          });
          return;
        }

        const timestamp = Date.now();
        const sessionId = this.ensureSession(clientId, ownerKey, {
          metadata: workspaceRoot ? { workspaceRoot } : undefined,
        });
        if (messageKey) {
          this.rememberMessageKey(messageKey, sessionId, timestamp);
        }
        void this.upsertSessionWorkspaceRoot(sessionId, ownerKey, workspaceRoot);
        const policyContext =
          this.parsePolicyContext(payload) ??
          this.sessionPolicyContexts.get(sessionId);

        if (policyContext) {
          this.sessionPolicyContexts.set(sessionId, policyContext);
        }

        // Notify the client of its session ID (needed for desktop viewer matching)
        send({
          type: "chat.session",
          payload: this.buildChatSessionPayload(sessionId, workspaceRoot),
          id,
        });

        // Store user message in history
        this.appendHistory(sessionId, {
          content: content as string,
          sender: "user",
          timestamp,
        });
        void this.persistSessionActivity(sessionId, {
          content: content as string,
          sender: "user",
          timestamp,
          ...(policyContext ? { policyContext } : {}),
        });

        // Convert base64 attachments from the WebSocket payload to MessageAttachment[]
        let attachments: MessageAttachment[] | undefined;
        if (hasAttachments) {
          attachments = (rawAttachments as Array<Record<string, unknown>>)
            .map((att): MessageAttachment | null => {
              const filename =
                typeof att.filename === "string" ? att.filename : undefined;
              const mimeType =
                typeof att.mimeType === "string"
                  ? att.mimeType
                  : "application/octet-stream";
              const base64 = typeof att.data === "string" ? att.data : undefined;
              const sizeBytes =
                typeof att.sizeBytes === "number" ? att.sizeBytes : undefined;

              let data: Uint8Array | undefined;
              if (base64) {
                try {
                  const binary = Buffer.from(base64, "base64");
                  data = new Uint8Array(binary);
                } catch {
                  return null;
                }
              }

              const type = mimeType.startsWith("image/")
                ? "image"
                : mimeType.startsWith("audio/")
                  ? "audio"
                  : "file";

              return { type, mimeType, data, filename, sizeBytes };
            })
            .filter((a): a is MessageAttachment => a !== null);
        }

        // Create a GatewayMessage and deliver to the Gateway pipeline
        const gatewayMsg = createGatewayMessage({
          channel: "webchat",
          senderId: clientId,
          senderName: `WebClient(${clientId})`,
          sessionId,
          content: content as string,
          scope: "dm",
          ...((policyContext || shellProfile)
            ? {
                metadata: {
                  ...(policyContext ? { policyContext } : {}),
                  ...(shellProfile ? { shellProfile } : {}),
                },
              }
            : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
        this.context.onMessage(gatewayMsg).catch((err) => {
          this.context.logger.warn?.(
            "WebChat: error delivering message to gateway:",
            err,
          );
          send({
            type: "error",
            error: "Failed to process message",
            id,
          });
        });
      },
      (error) => {
        send({
          type: "error",
          error: `Failed to process chat message: ${error.message}`,
          id,
        });
      },
    );
  }

  private handleChatNew(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    const oldSessionId = this.clientSessions.get(clientId);
    if (oldSessionId && this.deps.resetSessionContext) {
      void Promise.resolve(this.deps.resetSessionContext(oldSessionId)).catch(
        (error) => {
          this.context.logger.warn?.(
            `Failed to reset context for session ${oldSessionId}:`,
            error,
          );
        },
      );
    }

    this.withResolvedOwner(
      clientId,
      payload,
      send,
      (ownerKey) => {
        const workspaceRoot = this.parseWorkspaceRoot(payload);
        const sessionId = this.ensureSession(clientId, ownerKey, {
          forceNew: true,
          metadata: workspaceRoot ? { workspaceRoot } : undefined,
        });
        void this.upsertSessionWorkspaceRoot(sessionId, ownerKey, workspaceRoot);
        send({
          type: "chat.session",
          payload: this.buildChatSessionPayload(sessionId, workspaceRoot),
          id,
        });
        send({ type: "chat.history", payload: [], id });
      },
      (error) => {
        send({
          type: "error",
          error: `Failed to start chat session: ${error.message}`,
          id,
        });
      },
    );
  }

  private handleChatHistory(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleChatHistoryAsync(clientId, payload, id, send).catch((error) => {
      send({
        type: "error",
        error: `Failed to load chat history: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatResume(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType = "chat.session.resumed",
  ): void {
    void this.handleChatResumeAsync(clientId, payload, id, send, responseType).catch((error) => {
      send({
        type: "error",
        error: `Failed to resume chat session: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatSessions(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType = "chat.session.list",
  ): void {
    void this.handleChatSessionsAsync(clientId, payload, id, send, responseType).catch((error) => {
      send({
        type: "error",
        error: `Failed to list chat sessions: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatInspect(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType = "chat.session.inspect",
  ): void {
    void this.handleChatInspectAsync(clientId, payload, id, send, responseType).catch((error) => {
      send({
        type: "error",
        error: `Failed to inspect chat session: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleChatFork(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType = "chat.session.fork",
  ): void {
    void this.handleChatForkAsync(clientId, payload, id, send, responseType).catch((error) => {
      send({
        type: "error",
        error: `Failed to fork chat session: ${(error as Error).message}`,
        id,
      });
    });
  }

  private handleWatchCockpitGet(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleWatchCockpitGetAsync(clientId, payload, id, send).catch(
      (error) => {
        send({
          type: "error",
          error: `Failed to inspect watch cockpit: ${(error as Error).message}`,
          id,
        });
      },
    );
  }

  private async handleChatHistoryAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const boundSessionId = this.clientSessions.get(clientId);
    const sessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : boundSessionId;
    if (!sessionId) {
      send({ type: "chat.history", payload: [], id });
      return;
    }

    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const authorized = await this.isAuthorizedSession(
      sessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({ type: "error", error: "Not authorized to access this session", id });
      return;
    }

    const limit = typeof payload?.limit === "number" ? payload.limit : 50;
    const includeTools = payload?.includeTools === true;
    const history = await this.loadSessionHistory(sessionId, limit, {
      includeTools,
    });
    send({ type: "chat.history", payload: history, id });
  }

  private async handleChatResumeAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType: string,
  ): Promise<void> {
    const targetSessionId = payload?.sessionId;
    if (!targetSessionId || typeof targetSessionId !== "string") {
      send({
        type: "error",
        error: "Missing sessionId in chat.session.resume",
        id,
      });
      return;
    }
    const requestedWorkspaceRoot = this.parseWorkspaceRoot(payload);

    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({
        type: "error",
        error: `Session "${targetSessionId}" not found`,
        id,
      });
      return;
    }

    const resumed = await this.resumeSessionForClient(
      clientId,
      targetSessionId,
      ownerKey,
      requestedWorkspaceRoot,
    );
    send({
      type: responseType === "chat.resume" ? "chat.resumed" : "chat.session.resumed",
      payload: resumed,
      id,
    });
  }

  private async handleChatSessionsAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType: string,
  ): Promise<void> {
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const activeOnly = payload?.activeOnly === true;
    const limit =
      typeof payload?.limit === "number" && payload.limit > 0
        ? payload.limit
        : undefined;
    const profile = this.parseShellProfile(payload);
    const records = await this.listContinuitySessionsForOwner(ownerKey, {
      activeOnly,
      limit,
      shellProfile: profile,
    });
    send({ type: responseType, payload: records, id });
  }

  private async handleChatInspectAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType: string,
  ): Promise<void> {
    const boundSessionId = this.clientSessions.get(clientId);
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const targetSessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : boundSessionId;
    if (!targetSessionId) {
      send({
        type: "error",
        error: "Missing sessionId in chat.session.inspect",
        id,
      });
      return;
    }
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({
        type: "error",
        error: `Session "${targetSessionId}" not found`,
        id,
      });
      return;
    }

    const record = await this.inspectContinuitySession(targetSessionId, ownerKey);
    if (!record) {
      send({
        type: "error",
        error: `Session "${targetSessionId}" not found`,
        id,
      });
      return;
    }
    send({ type: responseType, payload: record, id });
  }

  private async handleChatForkAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
    responseType: string,
  ): Promise<void> {
    const boundSessionId = this.clientSessions.get(clientId);
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const sourceSessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : boundSessionId;
    if (!sourceSessionId) {
      send({
        type: "error",
        error: "Missing sessionId in chat.session.fork",
        id,
      });
      return;
    }
    const authorized = await this.isAuthorizedSession(
      sourceSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({
        type: "error",
        error: `Session "${sourceSessionId}" not found`,
        id,
      });
      return;
    }

    const forked = await this.forkOwnedSession(sourceSessionId, ownerKey, clientId, {
      shellProfile: this.parseShellProfile(payload),
      objective:
        typeof payload?.objective === "string" && payload.objective.trim().length > 0
          ? payload.objective.trim()
          : undefined,
    });
    send({ type: responseType, payload: forked, id });
  }

  private async handleWatchCockpitGetAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const targetSessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : this.clientSessions.get(clientId);
    if (!targetSessionId) {
      send({ type: "error", error: "Missing sessionId in watch.cockpit.get", id });
      return;
    }
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({ type: "error", error: "Not authorized to access this session", id });
      return;
    }
    const continuity = await this.inspectContinuitySession(targetSessionId, ownerKey);
    const sessionRecord = continuity as SessionContinuityRecord | undefined;
    if (!sessionRecord) {
      send({ type: "error", error: "Session continuity unavailable", id });
      return;
    }
    if (!this.deps.getWatchCockpitSnapshot) {
      send({
        type: "watch.cockpit",
        payload: {
          session: sessionRecord,
          repo: { available: false, unavailableReason: "cockpit unavailable" },
          worktrees: { available: false, entries: [], unavailableReason: "cockpit unavailable" },
          review: { status: "idle", source: "local", startedAt: Date.now(), updatedAt: Date.now() },
          verification: {
            status: "idle",
            source: "local",
            verdict: "unknown",
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
          approvals: { count: sessionRecord.pendingApprovalCount ?? 0, entries: [] },
          ownership: [],
        },
        id,
      });
      return;
    }
    const snapshot = await this.deps.getWatchCockpitSnapshot({
      sessionId: targetSessionId,
      actorId: this.currentActorId(clientId),
      channel: "webchat",
      continuity: sessionRecord,
      redactionProfile: "watch_cockpit",
    });
    send({
      type: "watch.cockpit",
      payload: snapshot,
      id,
    });
  }

  private handleSessionCommandCatalog(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleSessionCommandCatalogAsync(clientId, payload, id, send).catch(
      (error) => {
        send({
          type: "error",
          error: (error as Error).message,
          id,
        });
      },
    );
  }

  private async handleSessionCommandCatalogAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const client =
      payload?.client === "shell" ||
      payload?.client === "console" ||
      payload?.client === "web"
        ? payload.client
        : undefined;
    let targetSessionId =
      typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : this.clientSessions.get(clientId);
    if (targetSessionId) {
      const authorized = await this.isAuthorizedSession(
        targetSessionId,
        ownerKey,
        clientId,
      );
      if (!authorized) {
        targetSessionId = undefined;
      }
    }
    const continuity =
      targetSessionId && this.isDurableOwnerKey(ownerKey)
        ? await this.inspectContinuitySession(targetSessionId, ownerKey)
        : undefined;
    const sessionRecord = continuity;
    const autonomyConfig = this.deps.gateway.config as {
      autonomy?: GatewayAutonomyConfig;
    };
    const policyScope =
      targetSessionId && this.deps.resolvePolicyScopeForSession
        ? this.deps.resolvePolicyScopeForSession({
            sessionId: targetSessionId,
            channel: "webchat",
          })
        : undefined;
    const effectiveProfile =
      targetSessionId && sessionRecord?.shellProfile
        ? resolveConfiguredShellProfile({
            autonomy: autonomyConfig.autonomy,
            tenantId: policyScope?.tenantId,
            requested: sessionRecord.shellProfile,
            stableKey: targetSessionId,
          }).profile
        : sessionRecord?.shellProfile;
    const catalog = (this.deps.commandRegistry?.getCatalog() ?? [])
      .filter((entry) => !client || entry.clients.includes(client))
      .map((entry) => {
        if (!entry.rolloutFeature || !targetSessionId) {
          return {
            ...entry,
            ...(effectiveProfile ? { effectiveProfile } : {}),
          };
        }
        const domain =
          entry.rolloutFeature === "shellExtensions"
            ? "extensions"
            : entry.rolloutFeature === "watchCockpit"
              ? "watch"
              : "shell";
        const decision = evaluateShellFeatureRollout({
          autonomy: autonomyConfig.autonomy,
          tenantId: policyScope?.tenantId,
          stableKey: targetSessionId,
          feature: entry.rolloutFeature,
          domain,
        });
        return {
          ...entry,
          available: decision.allowed,
          ...(decision.allowed
            ? {}
            : {
                availabilityReason: `${entry.rolloutFeature} rollout is currently held back for this session`,
                heldBackBy: entry.rolloutFeature,
              }),
          ...(effectiveProfile ? { effectiveProfile } : {}),
        };
      });
    send({
      type: "session.command.catalog",
      payload: catalog,
      id,
    });
  }

  private handleSessionCommandExecute(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    void this.handleSessionCommandExecuteAsync(clientId, payload, id, send).catch(
      (error) => {
        send({
          type: "error",
          error: (error as Error).message,
          id,
        });
      },
    );
  }

  private async handleSessionCommandExecuteAsync(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): Promise<void> {
    const ownerKey = await this.resolveDurableOwner(clientId, payload, send);
    const request = (payload ?? {}) as unknown as SessionCommandExecutePayload;
    const content =
      typeof request.content === "string" ? request.content.trim() : "";
    if (!content.startsWith("/")) {
      send({
        type: "error",
        error: "session.command.execute requires a slash command payload",
        id,
      });
      return;
    }
    const registry = this.deps.commandRegistry;
    if (!registry) {
      send({
        type: "error",
        error: "Command registry unavailable",
        id,
      });
      return;
    }

    let targetSessionId =
      typeof request.sessionId === "string" && request.sessionId.trim().length > 0
        ? request.sessionId.trim()
        : this.clientSessions.get(clientId);
    if (!targetSessionId) {
      targetSessionId = this.ensureSession(clientId, ownerKey);
    }
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      send({
        type: "error",
        error: `Session "${targetSessionId}" not found`,
        id,
      });
      return;
    }

    const parsed = registry.parse(content);
    if (!parsed.isCommand || !parsed.name) {
      send({
        type: "error",
        error: "Invalid slash command payload",
        id,
      });
      return;
    }

    const detailed = await registry.dispatchDetailed(
      content,
      targetSessionId,
      this.currentActorId(clientId),
      this.name,
      async (replyContent) => {
        void replyContent;
      },
    );
    if (!detailed.handled) {
      send({
        type: "error",
        error: `Unknown command: /${parsed.name}`,
        id,
      });
      return;
    }
    const command = registry.get(parsed.name);
    const structuredResult = detailed.result;
    const result: SessionCommandResultPayload = {
      commandName: detailed.commandName ?? command?.name ?? parsed.name,
      content: structuredResult?.text ?? "",
      sessionId: targetSessionId,
      ...(request.client ? { client: request.client } : {}),
      ...((structuredResult?.viewKind ?? command?.metadata?.viewKind)
        ? { viewKind: structuredResult?.viewKind ?? command?.metadata?.viewKind }
        : {}),
      ...(structuredResult?.data
        ? { data: structuredResult.data as SessionCommandResultData }
        : {}),
    };
    send({
      type: "session.command.result",
      payload: result,
      id,
    });
  }

  async listContinuitySessionsForSession(
    requesterSessionId: string,
    params?: {
      activeOnly?: boolean;
      limit?: number;
      shellProfile?: SessionShellProfile;
    },
  ): Promise<readonly SessionContinuityRecord[]> {
    const ownerKey = await this.resolveOwnerKeyForSession(requesterSessionId);
    if (!ownerKey) {
      return [];
    }
    return this.listContinuitySessionsForOwner(ownerKey, params);
  }

  async inspectOwnedSession(
    requesterSessionId: string,
    targetSessionId?: string,
  ): Promise<SessionContinuityDetail | undefined> {
    const ownerKey = await this.resolveOwnerKeyForSession(requesterSessionId);
    if (!ownerKey) {
      return undefined;
    }
    const requestedTarget = targetSessionId?.trim() || requesterSessionId;
    const authorized = await this.isAuthorizedSession(
      requestedTarget,
      ownerKey,
      this.sessionClients.get(requesterSessionId) ?? "",
    );
    if (!authorized) {
      return undefined;
    }
    return this.inspectContinuitySession(requestedTarget, ownerKey);
  }

  async loadOwnedSessionHistory(
    requesterSessionId: string,
    params?: {
      sessionId?: string;
      limit?: number;
      includeTools?: boolean;
    },
  ): Promise<readonly SessionHistoryItem[]> {
    const ownerKey = await this.resolveOwnerKeyForSession(requesterSessionId);
    if (!ownerKey) {
      return [];
    }
    const targetSessionId = params?.sessionId?.trim() || requesterSessionId;
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      this.sessionClients.get(requesterSessionId) ?? "",
    );
    if (!authorized) {
      return [];
    }
    return this.loadSessionHistory(targetSessionId, params?.limit, {
      includeTools: params?.includeTools === true,
    });
  }

  async resumeOwnedSession(
    requesterSessionId: string,
    targetSessionId: string,
  ): Promise<SessionResumePayload | undefined> {
    const clientId = this.sessionClients.get(requesterSessionId);
    if (!clientId) {
      return undefined;
    }
    const ownerKey = await this.resolveOwnerKeyForSession(requesterSessionId);
    if (!ownerKey) {
      return undefined;
    }
    const authorized = await this.isAuthorizedSession(
      targetSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      return undefined;
    }
    return this.resumeSessionForClient(clientId, targetSessionId, ownerKey, undefined);
  }

  async forkOwnedSessionForRequester(
    requesterSessionId: string,
    params?: {
      sessionId?: string;
      shellProfile?: SessionShellProfile;
      objective?: string;
    },
  ): Promise<SessionForkResult | undefined> {
    const clientId = this.sessionClients.get(requesterSessionId);
    const ownerKey = await this.resolveOwnerKeyForSession(requesterSessionId);
    if (!clientId || !ownerKey) {
      return undefined;
    }
    const sourceSessionId = params?.sessionId?.trim() || requesterSessionId;
    const authorized = await this.isAuthorizedSession(
      sourceSessionId,
      ownerKey,
      clientId,
    );
    if (!authorized) {
      return undefined;
    }
    return this.forkOwnedSession(sourceSessionId, ownerKey, clientId, params);
  }

  // --------------------------------------------------------------------------
  // Event subscription handling
  // --------------------------------------------------------------------------

  private handleEventMessage(
    clientId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    id: string | undefined,
    send: SendFn,
  ): void {
    switch (type) {
      case "events.subscribe": {
        const rawFilters = Array.isArray(payload?.filters)
          ? payload.filters
          : [];
        const normalizedFilters = Array.from(
          new Set(
            rawFilters
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        );
        const filters = normalizedFilters.length > 0 ? normalizedFilters : null;
        this.eventSubscribers.set(clientId, filters);
        send({
          type: "events.subscribed",
          payload: {
            active: true,
            filters: filters ?? [],
          },
          id,
        });
        break;
      }
      case "events.unsubscribe":
        this.eventSubscribers.delete(clientId);
        send({
          type: "events.unsubscribed",
          payload: { active: false, filters: [] },
          id,
        });
        break;
      default:
        send({
          type: "error",
          error: `Unknown events message type: ${type}`,
          id,
        });
    }
  }

  /**
   * Inject a synthetic user message into the chat pipeline.
   * Used by slash commands that want to delegate to the normal ChatExecutor.
   */
  injectSyntheticUserMessage(
    sessionId: string,
    senderId: string,
    content: string,
  ): void {
    const gatewayMsg = createGatewayMessage({
      channel: "webchat",
      senderId,
      senderName: `WebClient(${senderId})`,
      sessionId,
      content,
      scope: "dm",
    });
    this.context.onMessage(gatewayMsg).catch((err) => {
      this.context.logger.warn?.(
        "WebChat: error delivering synthetic message:",
        err,
      );
    });
  }

  /**
   * Broadcast an event to all subscribed WS clients.
   */
  broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const traceId = typeof data.traceId === "string" ? data.traceId : undefined;
    const parentTraceId =
      typeof data.parentTraceId === "string" ? data.parentTraceId : undefined;
    const eventData =
      traceId || parentTraceId
        ? Object.fromEntries(
            Object.entries(data).filter(
              ([key]) => key !== "traceId" && key !== "parentTraceId",
            ),
          )
        : data;
    const response: ControlResponse = {
      type: "events.event",
      payload: {
        eventType,
        data: eventData,
        timestamp: Date.now(),
        ...(traceId ? { traceId } : {}),
        ...(parentTraceId ? { parentTraceId } : {}),
      },
    };
    for (const [clientId, filters] of this.eventSubscribers) {
      if (!matchesEventFilters(eventType, filters)) continue;
      const send = this.clientSenders.get(clientId);
      if (send) {
        send(response);
        this.traceOutboundControlResponse(
          clientId,
          this.clientSessions.get(clientId),
          response,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  private ensureSession(
    clientId: string,
    ownerKey: string,
    options?: {
      forceNew?: boolean;
      metadata?: PersistedWebChatSessionMetadata;
    },
  ): string {
    const existing = this.clientSessions.get(clientId);
    const forceNew = options?.forceNew === true;
    if (existing && !forceNew) return existing;

    if (existing && forceNew) {
      this.cancelSession(existing);
      this.sessionClients.delete(existing);
    }

    const sessionSalt = `${Date.now().toString(36)}:${randomUUID()}`;
    const sessionId = deriveSessionId(
      {
        channel: "webchat",
        senderId: `${clientId}:${sessionSalt}`,
        scope: "dm",
        workspaceId: DEFAULT_WORKSPACE_ID,
      },
      "per-channel-peer",
    );

    this.bindClientToSession(clientId, sessionId, ownerKey);
    if (options?.metadata?.workspaceRoot) {
      this.sessionWorkspaceRoots.set(sessionId, options.metadata.workspaceRoot);
    }
    if (options?.metadata?.policyContext) {
      this.sessionPolicyContexts.set(sessionId, options.metadata.policyContext);
    }
    if (this.isDurableOwnerKey(ownerKey)) {
      void this.sessionStore?.ensureSession({
        sessionId,
        ownerKey,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      });
    }

    return sessionId;
  }

  private bindClientToSession(
    clientId: string,
    sessionId: string,
    ownerKey: string,
  ): void {
    const existingSessionId = this.clientSessions.get(clientId);
    if (existingSessionId && existingSessionId !== sessionId) {
      this.sessionClients.delete(existingSessionId);
    }
    this.clientSessions.set(clientId, sessionId);
    this.sessionClients.set(sessionId, clientId);
    this.sessionOwners.set(sessionId, ownerKey);
  }

  private buildSeenMessageKey(ownerKey: string, messageId: string): string {
    return `${ownerKey}:${messageId}`;
  }

  private getDuplicateSessionId(messageKey: string): string | undefined {
    this.pruneMessageIds();
    return this.seenMessageIds.get(messageKey)?.sessionId;
  }

  private rememberMessageKey(
    messageKey: string,
    sessionId: string,
    now = Date.now(),
  ): void {
    this.pruneMessageIds(now);
    this.seenMessageIds.set(messageKey, { seenAt: now, sessionId });
    if (this.seenMessageIds.size > MAX_TRACKED_MESSAGE_IDS) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (typeof oldest === "string") {
        this.seenMessageIds.delete(oldest);
      }
    }
  }

  private pruneMessageIds(now = Date.now()): void {
    for (const [id, entry] of this.seenMessageIds) {
      if (now - entry.seenAt > MESSAGE_ID_TTL_MS) {
        this.seenMessageIds.delete(id);
      }
    }
  }

  private appendHistory(
    sessionId: string,
    entry: { content: string; sender: "user" | "agent"; timestamp: number },
  ): void {
    let history = this.sessionHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionHistory.set(sessionId, history);
    }
    history.push(entry);
  }

  private listOwnedSessionIds(clientId: string): string[] {
    const owned: string[] = [];
    const ownerKey = this.currentOwnerKey(clientId);
    for (const [sessionId, ownerId] of this.sessionOwners) {
      if (ownerId === ownerKey) {
        owned.push(sessionId);
      }
    }
    return owned;
  }

  private currentOwnerKey(clientId: string): string {
    return this.clientOwnerKeys.get(clientId) ?? `volatile:${clientId}`;
  }

  private currentActorId(clientId: string): string {
    return this.currentOwnerKey(clientId);
  }

  private isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof (value as Promise<T> | undefined)?.then === "function";
  }

  private withResolvedOwner(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    send: SendFn,
    onResolved: (ownerKey: string) => void,
    onRejected: (error: Error) => void,
  ): void {
    try {
      const ownerKey = this.resolveDurableOwner(clientId, payload, send);
      if (this.isPromiseLike(ownerKey)) {
        void ownerKey.then(onResolved).catch((error) => {
          onRejected(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
        return;
      }
      onResolved(ownerKey);
    } catch (error) {
      onRejected(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private issueDurableOwner(clientId: string, send: SendFn): string {
    if (!this.sessionStore) {
      return this.currentOwnerKey(clientId);
    }

    const issued = this.sessionStore.createOwnerCredential();
    this.clientOwnerKeys.set(clientId, issued.credential.ownerKey);
    send({
      type: "chat.owner",
      payload: {
        ownerToken: issued.ownerToken,
      },
    });
    this.persistOwnerCredential(clientId, issued.credential);
    return issued.credential.ownerKey;
  }

  private persistOwnerCredential(
    clientId: string,
    credential: PersistedWebChatOwnerCredential,
  ): void {
    void this.sessionStore?.persistOwnerCredential(credential).catch((error) => {
      this.context.logger.debug("Failed to persist webchat owner credential", {
        clientId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private resolveDurableOwner(
    clientId: string,
    payload: Record<string, unknown> | undefined,
    send: SendFn,
  ): string | Promise<string> {
    const ownerToken =
      typeof payload?.ownerToken === "string" ? payload.ownerToken.trim() : "";
    const existingOwnerKey = this.clientOwnerKeys.get(clientId);

    if (!this.sessionStore) {
      return existingOwnerKey ?? this.currentOwnerKey(clientId);
    }

    if (ownerToken.length > 0) {
      return this.sessionStore.resolveOwnerCredential(ownerToken).then((credential) => {
        if (credential) {
          this.clientOwnerKeys.set(clientId, credential.ownerKey);
          return credential.ownerKey;
        }
        return existingOwnerKey ?? this.issueDurableOwner(clientId, send);
      });
    }

    if (existingOwnerKey) {
      return existingOwnerKey;
    }

    return this.issueDurableOwner(clientId, send);
  }

  private isDurableOwnerKey(ownerKey: string): boolean {
    return !ownerKey.startsWith("volatile:");
  }

  private parseWorkspaceRoot(
    payload: Record<string, unknown> | undefined,
  ): string | undefined {
    const rawWorkspaceRoot =
      typeof payload?.workspaceRoot === "string"
        ? payload.workspaceRoot.trim()
        : "";
    if (!rawWorkspaceRoot) {
      return undefined;
    }
    const workspaceRoot = resolveSessionWorkspaceRoot(rawWorkspaceRoot);
    if (!workspaceRoot) {
      throw new Error(
        "Invalid workspaceRoot. Expected an absolute project path outside protected directories.",
      );
    }
    return workspaceRoot;
  }

  private parseShellProfile(
    payload: Record<string, unknown> | undefined,
  ): SessionShellProfile | undefined {
    return coerceSessionShellProfile(payload?.shellProfile);
  }

  private rememberPersistedSessionMetadata(
    sessionId: string,
    persisted: PersistedWebChatSession | undefined,
  ): void {
    const policyContext = persisted?.metadata?.policyContext;
    if (policyContext) {
      this.sessionPolicyContexts.set(sessionId, policyContext);
    }
    const workspaceRoot = persisted?.metadata?.workspaceRoot;
    if (workspaceRoot) {
      this.sessionWorkspaceRoots.set(sessionId, workspaceRoot);
    }
  }

  private buildChatSessionPayload(
    sessionId: string,
    workspaceRoot?: string,
  ): { sessionId: string; workspaceRoot?: string } {
    const resolvedWorkspaceRoot =
      workspaceRoot ?? this.sessionWorkspaceRoots.get(sessionId);
    return {
      sessionId,
      ...(resolvedWorkspaceRoot ? { workspaceRoot: resolvedWorkspaceRoot } : {}),
    };
  }

  private async upsertSessionWorkspaceRoot(
    sessionId: string,
    ownerKey: string,
    workspaceRoot: string | undefined,
  ): Promise<string | undefined> {
    const currentWorkspaceRoot =
      this.sessionWorkspaceRoots.get(sessionId) ??
      (await this.loadSessionWorkspaceRoot(sessionId));
    if (currentWorkspaceRoot) {
      this.sessionWorkspaceRoots.set(sessionId, currentWorkspaceRoot);
      return currentWorkspaceRoot;
    }
    if (!workspaceRoot) {
      return undefined;
    }

    this.sessionWorkspaceRoots.set(sessionId, workspaceRoot);
    if (this.isDurableOwnerKey(ownerKey)) {
      try {
        await this.sessionStore?.ensureSession({
          sessionId,
          ownerKey,
          metadata: { workspaceRoot },
        });
      } catch (error) {
        this.context.logger.debug(
          "Failed to persist webchat session workspace root",
          {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    return workspaceRoot;
  }

  private async persistSessionActivity(
    sessionId: string,
    entry: {
      content: string;
      sender: "user" | "agent";
      timestamp: number;
      policyContext?: PersistedWebChatPolicyContext;
    },
  ): Promise<void> {
    if (!this.sessionStore) {
      return;
    }
    const ownerKey =
      this.sessionOwners.get(sessionId) ??
      (await this.sessionStore.loadSession(sessionId))?.ownerKey;
    if (!ownerKey || !this.isDurableOwnerKey(ownerKey)) {
      return;
    }
    this.sessionOwners.set(sessionId, ownerKey);
    try {
      const workspaceRoot =
        this.sessionWorkspaceRoots.get(sessionId) ??
        (await this.loadSessionWorkspaceRoot(sessionId));
      await this.sessionStore.recordActivity({
        sessionId,
        ownerKey,
        sender: entry.sender,
        content: entry.content,
        timestamp: entry.timestamp,
        ...(entry.policyContext || workspaceRoot
          ? {
              metadata: {
                ...(entry.policyContext
                  ? { policyContext: entry.policyContext }
                  : {}),
                ...(workspaceRoot ? { workspaceRoot } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      this.context.logger.debug("Failed to persist webchat session activity", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async isAuthorizedSession(
    sessionId: string,
    ownerKey: string,
    clientId: string,
  ): Promise<boolean> {
    const cachedOwner = this.sessionOwners.get(sessionId);
    if (cachedOwner) {
      return cachedOwner === ownerKey || cachedOwner === `volatile:${clientId}`;
    }
    const persisted = await this.sessionStore?.loadSession(sessionId);
    if (!persisted) {
      return false;
    }
    this.sessionOwners.set(sessionId, persisted.ownerKey);
    return persisted.ownerKey === ownerKey;
  }

  private async resolveOwnerKeyForSession(
    sessionId: string,
  ): Promise<string | undefined> {
    const cached = this.sessionOwners.get(sessionId);
    if (cached) {
      return cached;
    }
    const persisted = await this.sessionStore?.loadSession(sessionId);
    if (!persisted) {
      return undefined;
    }
    this.sessionOwners.set(sessionId, persisted.ownerKey);
    this.rememberPersistedSessionMetadata(sessionId, persisted);
    return persisted.ownerKey;
  }

  private async resumeSessionForClient(
    clientId: string,
    targetSessionId: string,
    ownerKey: string,
    requestedWorkspaceRoot: string | undefined,
  ): Promise<{
    sessionId: string;
    messageCount: number;
    workspaceRoot?: string;
    shellProfile?: SessionShellProfile;
  }> {
    const oldSession = this.clientSessions.get(clientId);
    if (oldSession) {
      this.sessionClients.delete(oldSession);
    }

    this.clientSessions.set(clientId, targetSessionId);
    this.sessionClients.set(targetSessionId, clientId);
    this.sessionOwners.set(targetSessionId, ownerKey);
    const persisted = await this.sessionStore?.loadSession(targetSessionId);
    this.rememberPersistedSessionMetadata(targetSessionId, persisted);
    const workspaceRoot = await this.upsertSessionWorkspaceRoot(
      targetSessionId,
      ownerKey,
      requestedWorkspaceRoot,
    );

    await Promise.resolve(this.deps.hydrateSessionContext?.(targetSessionId));
    const history = await this.loadSessionHistory(targetSessionId);
    const runtimeState = this.deps.memoryBackend
      ? await loadPersistedSessionRuntimeState(
          this.deps.memoryBackend,
          targetSessionId,
        )
      : undefined;
    return {
      sessionId: targetSessionId,
      messageCount: history.length,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(runtimeState?.shellProfile
        ? { shellProfile: runtimeState.shellProfile }
        : {}),
    };
  }

  private async listContinuitySessionsForOwner(
    ownerKey: string,
    params?: {
      activeOnly?: boolean;
      limit?: number;
      shellProfile?: SessionShellProfile;
    },
  ): Promise<readonly SessionContinuityRecord[]> {
    if (this.sessionStore && this.isDurableOwnerKey(ownerKey)) {
      const persistedSessions = await this.sessionStore.listSessionsForOwner(ownerKey);
      const records = await Promise.all(
        persistedSessions.map((session) => this.buildSessionContinuityRecord(session)),
      );
      return records
        .filter((record) => {
          if (params?.activeOnly && !record.connected) {
            return false;
          }
          if (params?.shellProfile && record.shellProfile !== params.shellProfile) {
            return false;
          }
          if (!params?.activeOnly && record.resumabilityState === "non-resumable") {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, params?.limit && params.limit > 0 ? params.limit : undefined);
    }

    const records = await Promise.all(
      [...this.sessionHistory.entries()].map(async ([sessionId, history]) => {
        const lastEntry = history[history.length - 1];
        const preview =
          history.find((entry) => entry.sender === "user")?.content ??
          history.find((entry) => entry.sender === "agent")?.content ??
          "New conversation";
        return {
          sessionId,
          label: compactPreview(preview, 80) ?? "New conversation",
          preview: compactPreview(preview) ?? "New conversation",
          messageCount: history.length,
          createdAt: history[0]?.timestamp ?? Date.now(),
          updatedAt: lastEntry?.timestamp ?? Date.now(),
          lastActiveAt: lastEntry?.timestamp ?? Date.now(),
          connected: this.sessionClients.has(sessionId),
          resumabilityState: this.sessionClients.has(sessionId)
            ? "active"
            : history.length > 0
              ? "disconnected-resumable"
              : "non-resumable",
          shellProfile: "general" as SessionShellProfile,
          workflowStage: "idle",
          childSessionCount: 0,
          worktreeCount: 0,
          pendingApprovalCount: 0,
        } satisfies SessionContinuityRecord;
      }),
    );
    return records
      .filter((record) =>
        params?.activeOnly ? record.connected : record.resumabilityState !== "non-resumable",
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, params?.limit && params.limit > 0 ? params.limit : undefined);
  }

  private async inspectContinuitySession(
    sessionId: string,
    ownerKey: string,
  ): Promise<SessionContinuityDetail | undefined> {
    const persisted = await this.sessionStore?.loadSession(sessionId);
    if (!persisted || persisted.ownerKey !== ownerKey) {
      return undefined;
    }
    const continuity = await this.buildSessionContinuityRecord(persisted);
    const runtimeState = this.deps.memoryBackend
      ? await loadPersistedSessionRuntimeState(
          this.deps.memoryBackend,
          sessionId,
        )
      : undefined;
    const history = await this.loadSessionHistory(sessionId, 10, {
      includeTools: false,
    });
    const backgroundRun = await this.deps.inspectBackgroundRun?.(sessionId);
    return {
      ...continuity,
      workflowState:
        runtimeState?.workflowState ?? {
          stage: continuity.workflowStage,
          worktreeMode: "off",
          enteredAt: continuity.updatedAt,
          updatedAt: continuity.updatedAt,
        },
      runtimeState: runtimeState
        ? {
            ...(runtimeState.activeTaskContext
              ? { activeTaskContext: runtimeState.activeTaskContext }
              : {}),
            ...(runtimeState.reviewSurfaceState?.status
              ? { reviewStatus: runtimeState.reviewSurfaceState.status }
              : {}),
            ...(runtimeState.verificationSurfaceState?.status
              ? { verificationStatus: runtimeState.verificationSurfaceState.status }
              : {}),
            ...(runtimeState.verificationSurfaceState?.verdict
              ? { verificationVerdict: runtimeState.verificationSurfaceState.verdict }
              : {}),
          }
        : undefined,
      recentHistory: history,
      ...(backgroundRun
        ? {
            backgroundRun: {
              runId: backgroundRun.runId,
              state: backgroundRun.state,
              currentPhase: backgroundRun.currentPhase,
              objective: backgroundRun.objective,
              checkpointAvailable: backgroundRun.checkpointAvailable,
            },
          }
        : {}),
    };
  }

  private async buildSessionContinuityRecord(
    session: PersistedWebChatSession,
  ): Promise<SessionContinuityRecord> {
    const runtimeState = this.deps.memoryBackend
      ? await loadPersistedSessionRuntimeState(
          this.deps.memoryBackend,
          session.sessionId,
        )
      : undefined;
    const workspaceRoot = session.metadata?.workspaceRoot;
    const { repoRoot, branch, head } = await resolveGitSnapshot(workspaceRoot);
    const runtimeStatus = runtimeState?.runtimeContractStatusSnapshot as
      | unknown
      | undefined;
    const pendingApprovalCount = this.countPendingApprovals(session.sessionId);
    const preview =
      runtimeState?.workflowState?.objective ??
      session.label ??
      session.metadata?.lastAssistantOutputPreview ??
      "New conversation";
    const connected = this.sessionClients.has(session.sessionId);
    return {
      sessionId: session.sessionId,
      label: session.label,
      preview: compactPreview(preview) ?? session.label,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastActiveAt: session.lastActiveAt,
      connected,
      resumabilityState: this.resolveResumabilityState({
        connected,
        workspaceRoot,
        messageCount: session.messageCount,
        runtimeState,
      }),
      shellProfile: runtimeState?.shellProfile ?? "general",
      workflowStage: runtimeState?.workflowState?.stage ?? "idle",
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      ...(this.summarizeActiveTask(runtimeState) ? {
        activeTaskSummary: this.summarizeActiveTask(runtimeState),
      } : {}),
      childSessionCount: this.countChildSessions(
        runtimeStatus as Record<string, unknown> | undefined,
      ),
      worktreeCount: this.countWorktreeOwnership(
        runtimeStatus as Record<string, unknown> | undefined,
      ),
      pendingApprovalCount,
      ...(session.metadata?.lastAssistantOutputPreview
        ? { lastAssistantOutputPreview: session.metadata.lastAssistantOutputPreview }
        : {}),
      ...(session.metadata?.forkLineage
        ? { forkLineage: session.metadata.forkLineage }
        : {}),
    };
}

  private resolveResumabilityState(params: {
    connected: boolean;
    workspaceRoot?: string;
    messageCount: number;
    runtimeState?: PersistedSessionRuntimeState;
  }): SessionResumabilityState {
    if (params.connected) {
      return "active";
    }
    if (params.workspaceRoot && !existsSync(params.workspaceRoot)) {
      return "missing-workspace";
    }
    if (params.messageCount > 0 || params.runtimeState) {
      return "disconnected-resumable";
    }
    return "non-resumable";
  }

  private countPendingApprovals(sessionId: string): number {
    const requests = this.deps.approvalEngine?.getPending() ?? [];
    return requests.filter(
      (request) =>
        request.sessionId === sessionId || request.parentSessionId === sessionId,
    ).length;
  }

  private summarizeActiveTask(
    runtimeState: PersistedSessionRuntimeState | undefined,
  ): string | undefined {
    const activeTaskContext = runtimeState?.activeTaskContext as
      | ActiveTaskContext
      | undefined;
    if (activeTaskContext?.taskLineageId) {
      const summary =
        typeof activeTaskContext.displayArtifact === "string" &&
        activeTaskContext.displayArtifact.trim().length > 0
          ? activeTaskContext.displayArtifact.trim()
          : activeTaskContext.targetArtifacts[0] ??
            activeTaskContext.sourceArtifacts[0];
      return summary
        ? `${activeTaskContext.taskLineageId}: ${summary}`
        : activeTaskContext.taskLineageId;
    }
    const snapshot =
      runtimeState?.runtimeContractStatusSnapshot &&
      typeof runtimeState.runtimeContractStatusSnapshot === "object"
        ? (runtimeState.runtimeContractStatusSnapshot as unknown as Record<
            string,
            unknown
          >)
        : undefined;
    const openTasks = Array.isArray(snapshot?.openTasks) ? snapshot.openTasks : [];
    const firstTask =
      openTasks.length > 0 && typeof openTasks[0] === "object" && openTasks[0] !== null
        ? (openTasks[0] as Record<string, unknown>)
        : undefined;
    if (!firstTask) return undefined;
    const taskId = typeof firstTask.id === "string" ? firstTask.id : undefined;
    const summary =
      typeof firstTask.summary === "string" ? firstTask.summary : undefined;
    if (!taskId) {
      return summary;
    }
    return summary ? `${taskId}: ${summary}` : taskId;
  }

  private countChildSessions(
    runtimeStatusSnapshot: Record<string, unknown> | undefined,
  ): number {
    const openWorkers = Array.isArray(runtimeStatusSnapshot?.openWorkers)
      ? runtimeStatusSnapshot.openWorkers
      : [];
    return openWorkers.filter((entry) => {
      const record =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : undefined;
      return typeof record?.continuationSessionId === "string";
    }).length;
  }

  private countWorktreeOwnership(
    runtimeStatusSnapshot: Record<string, unknown> | undefined,
  ): number {
    const openWorkers = Array.isArray(runtimeStatusSnapshot?.openWorkers)
      ? runtimeStatusSnapshot.openWorkers
      : [];
    return openWorkers.filter((entry) => {
      const record =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : undefined;
      const executionLocation =
        record && typeof record.executionLocation === "object"
          ? (record.executionLocation as Record<string, unknown>)
          : undefined;
      return (
        executionLocation?.mode === "worktree" &&
        typeof executionLocation.worktreePath === "string"
      );
    }).length;
  }

  private buildForkedSessionId(clientId: string): string {
    return deriveSessionId(
      {
        channel: "webchat",
        senderId: `${clientId}:fork:${Date.now().toString(36)}:${randomUUID()}`,
        scope: "dm",
        workspaceId: DEFAULT_WORKSPACE_ID,
      },
      "per-channel-peer",
    );
  }

  private async forkOwnedSession(
    sourceSessionId: string,
    ownerKey: string,
    clientId: string,
    params?: {
      shellProfile?: SessionShellProfile;
      objective?: string;
    },
  ): Promise<SessionForkResult> {
    const sourceSession = await this.sessionStore?.loadSession(sourceSessionId);
    if (!sourceSession || sourceSession.ownerKey !== ownerKey) {
      throw new Error(`Session "${sourceSessionId}" not found`);
    }

    const targetSessionId = this.buildForkedSessionId(clientId);
    const workspaceRoot =
      sourceSession.metadata?.workspaceRoot ??
      (await this.loadSessionWorkspaceRoot(sourceSessionId));
    const forkedAt = Date.now();
    let forkSource: PersistedWebChatForkSource | undefined;

    if (
      this.deps.inspectBackgroundRun &&
      this.deps.forkBackgroundRunFromCheckpoint &&
      (await this.deps.inspectBackgroundRun(sourceSessionId))?.checkpointAvailable
    ) {
      const forkedFromCheckpoint = await this.deps.forkBackgroundRunFromCheckpoint({
        sourceSessionId,
        targetSessionId,
        objective: params?.objective,
      });
      if (forkedFromCheckpoint) {
        forkSource = "checkpoint";
      }
    }

    if (!forkSource && this.deps.memoryBackend) {
      const forkedRuntimeState = await forkSessionRuntimeState(
        this.deps.memoryBackend,
        {
          sourceWebSessionId: sourceSessionId,
          targetWebSessionId: targetSessionId,
          ...(params?.shellProfile ? { shellProfile: params.shellProfile } : {}),
          ...(params?.objective
            ? { workflowState: { objective: params.objective } }
            : {}),
        },
      );
      if (forkedRuntimeState) {
        forkSource = "runtime_state";
      }
    }

    if (!forkSource && this.deps.memoryBackend) {
      const sourceThread = await this.deps.memoryBackend.getThread(sourceSessionId);
      for (const entry of sourceThread) {
        await this.deps.memoryBackend.addEntry({
          sessionId: targetSessionId,
          role: entry.role,
          content: entry.content,
          ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
          ...(entry.toolName ? { toolName: entry.toolName } : {}),
          ...(entry.taskPda ? { taskPda: entry.taskPda } : {}),
          ...(entry.metadata ? { metadata: entry.metadata } : {}),
          ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
          ...(entry.agentId ? { agentId: entry.agentId } : {}),
          ...(entry.userId ? { userId: entry.userId } : {}),
          ...(entry.worldId ? { worldId: entry.worldId } : {}),
          ...(entry.channel ? { channel: entry.channel } : {}),
        });
      }
      if (sourceThread.length > 0) {
        forkSource = "history";
      }
    }

    if (!forkSource) {
      throw new Error("No continuity source was available to fork this session");
    }

    await this.sessionStore?.ensureSession({
      sessionId: targetSessionId,
      ownerKey,
      createdAt: forkedAt,
      label: sourceSession.label,
      metadata: {
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(sourceSession.metadata?.lastAssistantOutputPreview
          ? {
              lastAssistantOutputPreview:
                sourceSession.metadata.lastAssistantOutputPreview,
            }
          : {}),
        forkLineage: {
          parentSessionId: sourceSessionId,
          source: forkSource,
          forkedAt,
        },
      },
    });
    await this.sessionStore?.updateSessionMetadata({
      sessionId: targetSessionId,
      ownerKey,
      updatedAt: forkedAt,
      metadata: {
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(sourceSession.metadata?.lastAssistantOutputPreview
          ? {
              lastAssistantOutputPreview:
                sourceSession.metadata.lastAssistantOutputPreview,
            }
          : {}),
        forkLineage: {
          parentSessionId: sourceSessionId,
          source: forkSource,
          forkedAt,
        },
      },
      label: sourceSession.label,
    });
    if (workspaceRoot) {
      this.sessionWorkspaceRoots.set(targetSessionId, workspaceRoot);
    }
    this.sessionOwners.set(targetSessionId, ownerKey);

    const continuity = await this.inspectContinuitySession(targetSessionId, ownerKey);
    return {
      sourceSessionId,
      targetSessionId,
      forkSource,
      ...(continuity ? { session: continuity } : {}),
    };
  }

  private async loadSessionHistory(
    sessionId: string,
    limit?: number,
    options?: {
      includeTools?: boolean;
    },
  ): Promise<SessionHistoryItem[]> {
    if (this.deps.memoryBackend) {
      const entries = await this.deps.memoryBackend.getThread(sessionId, limit);
      const history = entries
        .filter((entry) =>
          options?.includeTools === true
            ? entry.role === "user" ||
              entry.role === "assistant" ||
              entry.role === "tool"
            : entry.role === "user" || entry.role === "assistant",
        )
        .map((entry): SessionHistoryItem => ({
          content: entry.content,
          sender:
            entry.role === "assistant"
              ? "agent"
              : entry.role === "tool"
                ? "tool"
                : "user",
          timestamp: entry.timestamp,
          ...(entry.toolName ? { toolName: entry.toolName } : {}),
        }));
      if (history.length > 0) {
        const nonToolHistory = history
          .filter((entry) => entry.sender !== "tool")
          .map((entry) => ({
            content: entry.content,
            sender: entry.sender === "agent" ? ("agent" as const) : ("user" as const),
            timestamp: entry.timestamp,
          }));
        this.sessionHistory.set(sessionId, nonToolHistory);
      }
      return history;
    }
    const history = this.sessionHistory.get(sessionId) ?? [];
    const bounded =
      typeof limit === "number" && limit > 0 ? history.slice(-limit) : history;
    return bounded;
  }

  private parsePolicyContext(
    payload: Record<string, unknown> | undefined,
  ): PersistedWebChatPolicyContext | undefined {
    if (
      !payload ||
      typeof payload.policyContext !== "object" ||
      payload.policyContext === null
    ) {
      return undefined;
    }
    const raw = payload.policyContext as Record<string, unknown>;
    const tenantId =
      typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
        ? raw.tenantId.trim()
        : undefined;
    const projectId =
      typeof raw.projectId === "string" && raw.projectId.trim().length > 0
        ? raw.projectId.trim()
        : undefined;
    if (!tenantId && !projectId) {
      return undefined;
    }
    return {
      ...(tenantId ? { tenantId } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }

  // --------------------------------------------------------------------------
  // Client cleanup (called when a WS connection disconnects)
  // --------------------------------------------------------------------------

  /**
   * Clean up state for a disconnected client. The Gateway should call this
   * when a WS client disconnects.
   */
  removeClient(clientId: string): void {
    // Stop any active voice session for this client
    if (this.deps.voiceBridge?.hasSession(clientId)) {
      void this.deps.voiceBridge.stopSession(clientId);
    }

    // Remove from event subscribers
    this.eventSubscribers.delete(clientId);

    const sessionId = this.clientSessions.get(clientId);
    if (sessionId) {
      this.sessionClients.delete(sessionId);
      // Note: we keep sessionHistory for resume support
    }
    this.clientSessions.delete(clientId);
    this.clientOwnerKeys.delete(clientId);
    this.clientSenders.delete(clientId);
  }
}
