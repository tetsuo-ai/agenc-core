/**
 * AgenC daemon realtime JSON-RPC method handlers.
 *
 * This service maps the daemon protocol surface onto the existing realtime
 * conversation phase machine while keeping concrete network transports
 * injected by the runtime bootstrap.
 */

import { AgenCDaemonAgentLifecycleError } from "./agent-lifecycle.js";
import {
  buildRealtimeSessionConfig,
  buildRealtimeSessionConfigFromSession,
  builtinRealtimeVoices,
  type RealtimeActiveHandle,
  type RealtimeConversation,
  type RealtimeConversationItemPayload,
  type RealtimeEvent,
  type RealtimeOutputModality,
  type RealtimeSessionMode,
  type RealtimeSessionVersion,
  type RealtimeTransportConnection,
  type RealtimeTransportRequest,
  type RealtimeTransportSelection,
  type RealtimeVoice,
} from "../conversation/realtime/conversation.js";
import type {
  RealtimeStartupContextOptions,
  RealtimeStartupContextSessionLike,
} from "../conversation/realtime/context.js";
import { type AgenCRealtimeCallClient } from "./realtime-transport.js";
import {
  JSON_RPC_VERSION,
  type AgenCDaemonNotification,
  type ThreadRealtimeAppendAudioParams,
  type ThreadRealtimeAppendAudioResponse,
  type ThreadRealtimeAppendTextParams,
  type ThreadRealtimeAppendTextResponse,
  type ThreadRealtimeListVoicesParams,
  type ThreadRealtimeListVoicesResponse,
  type ThreadRealtimeStartParams,
  type ThreadRealtimeStartResponse,
  type ThreadRealtimeStopParams,
  type ThreadRealtimeStopResponse,
  type ThreadRealtimeVoicesList,
} from "./protocol/index.js";

export type AgenCRealtimeNotificationSender = (
  notification: AgenCDaemonNotification,
) => void | Promise<void>;

export interface AgenCRealtimeRpcContext {
  readonly sendNotification?: AgenCRealtimeNotificationSender;
}

export interface AgenCRealtimeThreadBinding {
  readonly threadId: string;
  readonly conversation: RealtimeConversation;
  readonly session?: RealtimeStartupContextSessionLike;
  readonly connectTransport: (
    request: RealtimeTransportRequest,
  ) => Promise<RealtimeTransportConnection> | RealtimeTransportConnection;
  readonly routeRealtimeTextInput?: (text: string) => Promise<void> | void;
  readonly callClient?: AgenCRealtimeCallClient;
  readonly backendPrompt?: string | null;
  readonly startupContext?: string | null;
  readonly startupContextOptions?: Omit<
    RealtimeStartupContextOptions,
    "history" | "cwd" | "conversationId"
  >;
  readonly version?: RealtimeSessionVersion;
  readonly sessionMode?: RealtimeSessionMode;
  readonly model?: string | null;
  readonly configuredVoice?: RealtimeVoice | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AgenCRealtimeRpcHandlers {
  /** True only for an implementation whose start path is actually enabled. */
  readonly startEnabled?: boolean;
  start(
    params: ThreadRealtimeStartParams,
    context?: AgenCRealtimeRpcContext,
  ): Promise<ThreadRealtimeStartResponse>;
  appendAudio(
    params: ThreadRealtimeAppendAudioParams,
  ): Promise<ThreadRealtimeAppendAudioResponse>;
  appendText(
    params: ThreadRealtimeAppendTextParams,
  ): Promise<ThreadRealtimeAppendTextResponse>;
  stop(params: ThreadRealtimeStopParams): Promise<ThreadRealtimeStopResponse>;
  listVoices(
    params?: ThreadRealtimeListVoicesParams,
  ): Promise<ThreadRealtimeListVoicesResponse>;
}

export interface AgenCRealtimeRpcServiceOptions {
  readonly resolveThread?: (
    threadId: string,
  ) =>
    | AgenCRealtimeThreadBinding
    | null
    | Promise<AgenCRealtimeThreadBinding | null>;
  /** Isolated contract-test seam; production must never provide this token. */
  readonly unadmittedStartOverride?:
    typeof TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START;
}

export const TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START = Symbol(
  "test-only-allow-unadmitted-realtime-start",
);

export const REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC =
  "thread/realtime/start is disabled: realtime provider traffic has no durable run/step admission, bounded budget reservation, or authoritative usage reconciliation; use ordinary daemon session turns until realtime admission is implemented";

interface ActiveRealtimeFanout {
  readonly active: RealtimeActiveHandle;
  providerSdp?: string;
  closeReason: "requested" | "transport_closed" | "error";
  startedSent: boolean;
  closed: boolean;
}

interface RealtimeStartupGuard {
  cancelled: boolean;
}

export class AgenCRealtimeRpcService implements AgenCRealtimeRpcHandlers {
  readonly #registeredThreads = new Map<string, AgenCRealtimeThreadBinding>();
  readonly #activeFanouts = new Map<string, ActiveRealtimeFanout>();
  readonly #startupGuards = new Map<string, RealtimeStartupGuard>();
  readonly #resolveThread:
    | ((
        threadId: string,
      ) =>
        | AgenCRealtimeThreadBinding
        | null
        | Promise<AgenCRealtimeThreadBinding | null>)
    | undefined;
  readonly #allowUnadmittedStart: boolean;

  constructor(options: AgenCRealtimeRpcServiceOptions = {}) {
    this.#resolveThread = options.resolveThread;
    this.#allowUnadmittedStart =
      options.unadmittedStartOverride ===
      TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START;
  }

  get startEnabled(): boolean {
    return this.#allowUnadmittedStart;
  }

  registerThread(binding: AgenCRealtimeThreadBinding): void {
    this.#registeredThreads.set(binding.threadId, binding);
  }

  unregisterThread(threadId: string): boolean {
    return this.#registeredThreads.delete(threadId);
  }

  async start(
    params: ThreadRealtimeStartParams,
    context: AgenCRealtimeRpcContext = {},
  ): Promise<ThreadRealtimeStartResponse> {
    if (!this.#allowUnadmittedStart) {
      throw new AgenCDaemonAgentLifecycleError(
        "EXECUTION_ADMISSION_REQUIRED",
        REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC,
      );
    }
    const binding = await this.#requireThread(params.threadId);
    const transport = normalizeRealtimeStartTransport(params.transport);
    const guard: RealtimeStartupGuard = { cancelled: false };
    this.#startupGuards.set(params.threadId, guard);
    this.#deferRealtimeStartup({
      params,
      binding,
      transport,
      guard,
      sendNotification: context.sendNotification,
    });
    return {};
  }

  #deferRealtimeStartup(options: {
    readonly params: ThreadRealtimeStartParams;
    readonly binding: AgenCRealtimeThreadBinding;
    readonly transport: RealtimeTransportSelection;
    readonly guard: RealtimeStartupGuard;
    readonly sendNotification: AgenCRealtimeNotificationSender | undefined;
  }): void {
    setImmediate(() => {
      void this.#startRealtimeConversation(options);
    });
  }

  async #startRealtimeConversation(options: {
    readonly params: ThreadRealtimeStartParams;
    readonly binding: AgenCRealtimeThreadBinding;
    readonly transport: RealtimeTransportSelection;
    readonly guard: RealtimeStartupGuard;
    readonly sendNotification: AgenCRealtimeNotificationSender | undefined;
  }): Promise<void> {
    const { params, binding, transport, guard, sendNotification } = options;
    let activeFanout: ActiveRealtimeFanout | undefined;
    let active: RealtimeActiveHandle | undefined;
    try {
      if (guard.cancelled) {
        await this.#sendStartupCancelled(params.threadId, sendNotification);
        return;
      }
      const config = await this.#buildSessionConfig(binding, params);
      let providerSdp: string | undefined;
      let connectTransport = binding.connectTransport;
      if (transport.type === "webrtc" && binding.callClient !== undefined) {
        const response = await binding.callClient.createWithSession(
          transport.sdp,
          config,
          binding.headers,
        );
        providerSdp = response.sdp;
        connectTransport = (request) =>
          binding.connectTransport({
            ...request,
            providerCallId: response.callId,
            providerSdp: response.sdp,
          });
      }

      const started = await binding.conversation.start({
        sessionConfig: config,
        transport,
        ...(binding.headers !== undefined ? { headers: binding.headers } : {}),
        connectTransport,
        ...(binding.routeRealtimeTextInput !== undefined
          ? { routeRealtimeTextInput: binding.routeRealtimeTextInput }
          : {}),
      });
      providerSdp = providerSdp ?? started.providerSdp;
      active = started.active;
      activeFanout = {
        active: started.active,
        ...(providerSdp !== undefined ? { providerSdp } : {}),
        closeReason: "transport_closed",
        startedSent: false,
        closed: false,
      };
      const fanout = activeFanout;
      this.#activeFanouts.set(params.threadId, activeFanout);

      const fanoutRegistered = await binding.conversation.registerFanout(
        started.active,
        (events) =>
          this.#fanoutEvents(params.threadId, fanout, events, sendNotification),
      );
      if (!fanoutRegistered) {
        activeFanout.closeReason = "error";
        if (this.#activeFanouts.get(params.threadId) === activeFanout) {
          this.#activeFanouts.delete(params.threadId);
        }
        activeFanout.closed = true;
        await binding.conversation
          .finishIfActive(started.active)
          .catch(() => {});
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          `realtime fanout is already registered for thread: ${params.threadId}`,
        );
      }

      if (guard.cancelled) {
        // A stop() arrived while the conversation was connecting. Tear the
        // now-live session down cleanly instead of orphaning it. The fanout's
        // finally block emits the "requested" closed notification.
        activeFanout.closeReason = "requested";
        await binding.conversation.finishIfActive(started.active);
      }
    } catch (error) {
      if (activeFanout !== undefined && active !== undefined) {
        activeFanout.closeReason = "error";
        if (this.#activeFanouts.get(params.threadId) === activeFanout) {
          this.#activeFanouts.delete(params.threadId);
        }
        activeFanout.closed = true;
        await binding.conversation.finishIfActive(active).catch(() => {});
      }
      await this.#send(sendNotification, {
        method: "thread/realtime/error",
        params: {
          threadId: params.threadId,
          message: errorMessage(error),
        },
      }).catch(() => {});
    } finally {
      if (this.#startupGuards.get(params.threadId) === guard) {
        this.#startupGuards.delete(params.threadId);
      }
    }
  }

  async #sendStartupCancelled(
    threadId: string,
    sendNotification: AgenCRealtimeNotificationSender | undefined,
  ): Promise<void> {
    await this.#send(sendNotification, {
      method: "thread/realtime/closed",
      params: { threadId, reason: "requested" },
    }).catch(() => {});
  }

  async appendAudio(
    params: ThreadRealtimeAppendAudioParams,
  ): Promise<ThreadRealtimeAppendAudioResponse> {
    const binding = await this.#requireThread(params.threadId);
    await binding.conversation.audioIn({
      data: params.audio.data,
      sampleRate: params.audio.sampleRate,
      numChannels: params.audio.numChannels,
      ...(params.audio.samplesPerChannel !== undefined &&
      params.audio.samplesPerChannel !== null
        ? { samplesPerChannel: params.audio.samplesPerChannel }
        : {}),
      ...(params.audio.itemId !== undefined && params.audio.itemId !== null
        ? { itemId: params.audio.itemId }
        : {}),
    });
    return {};
  }

  async appendText(
    params: ThreadRealtimeAppendTextParams,
  ): Promise<ThreadRealtimeAppendTextResponse> {
    const binding = await this.#requireThread(params.threadId);
    await binding.conversation.textIn(params.text);
    return {};
  }

  async stop(
    params: ThreadRealtimeStopParams,
  ): Promise<ThreadRealtimeStopResponse> {
    const binding = await this.#requireThread(params.threadId);
    const running = await binding.conversation.runningState();
    if (running === undefined) {
      // A stop() may race ahead of a deferred startup that has not yet brought
      // the conversation into a running state. Flag the in-flight guard so the
      // startup path cancels cleanly instead of orphaning the session.
      const pending = this.#startupGuards.get(params.threadId);
      if (pending !== undefined) pending.cancelled = true;
      return {};
    }
    const fanout = this.#activeFanouts.get(params.threadId);
    if (fanout !== undefined) fanout.closeReason = "requested";
    await binding.conversation.finishIfActive(running.active);
    return {};
  }

  async listVoices(
    _params: ThreadRealtimeListVoicesParams = {},
  ): Promise<ThreadRealtimeListVoicesResponse> {
    const voices = builtinRealtimeVoices();
    return {
      voices: {
        v1: voices.v1,
        v2: voices.v2,
        defaultV1: voices.defaultV1,
        defaultV2: voices.defaultV2,
      } satisfies ThreadRealtimeVoicesList,
    };
  }

  async #buildSessionConfig(
    binding: AgenCRealtimeThreadBinding,
    params: ThreadRealtimeStartParams,
  ) {
    const outputModality = params.outputModality as RealtimeOutputModality;
    const voice = params.voice as RealtimeVoice | null | undefined;
    if (binding.session !== undefined) {
      return buildRealtimeSessionConfigFromSession({
        session: binding.session,
        outputModality,
        prompt: params.prompt,
        backendPrompt: binding.backendPrompt,
        startupContext: binding.startupContext,
        realtimeSessionId: params.realtimeSessionId,
        voice,
        configuredVoice: binding.configuredVoice,
        version: binding.version,
        sessionMode: binding.sessionMode,
        model: binding.model,
        ...(binding.startupContextOptions !== undefined
          ? { startupContextOptions: binding.startupContextOptions }
          : {}),
      });
    }
    return buildRealtimeSessionConfig({
      conversationId: params.threadId,
      outputModality,
      prompt: params.prompt,
      backendPrompt: binding.backendPrompt,
      startupContext: binding.startupContext,
      realtimeSessionId: params.realtimeSessionId,
      voice,
      configuredVoice: binding.configuredVoice,
      version: binding.version,
      sessionMode: binding.sessionMode,
      model: binding.model,
    });
  }

  async #fanoutEvents(
    threadId: string,
    activeFanout: ActiveRealtimeFanout,
    events: AsyncIterable<RealtimeEvent>,
    sendNotification: AgenCRealtimeNotificationSender | undefined,
  ): Promise<void> {
    try {
      for await (const event of events) {
        await this.#fanoutEvent(
          threadId,
          activeFanout,
          event,
          sendNotification,
        );
      }
    } catch (error) {
      activeFanout.closeReason = "error";
      await this.#send(sendNotification, {
        method: "thread/realtime/error",
        params: {
          threadId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      await this.#closeFanout(threadId, activeFanout, sendNotification).catch(
        () => {},
      );
    }
  }

  async #sendStartedNotification(options: {
    readonly threadId: string;
    readonly activeFanout: ActiveRealtimeFanout;
    readonly realtimeSessionId: string;
    readonly version: RealtimeSessionVersion;
    readonly sendNotification: AgenCRealtimeNotificationSender | undefined;
  }): Promise<void> {
    if (options.activeFanout.startedSent) return;
    options.activeFanout.startedSent = true;
    await this.#send(options.sendNotification, {
      method: "thread/realtime/started",
      params: {
        threadId: options.threadId,
        realtimeSessionId: options.realtimeSessionId,
        version: options.version,
      },
    });
    if (options.activeFanout.providerSdp !== undefined) {
      const sdp = options.activeFanout.providerSdp;
      options.activeFanout.providerSdp = undefined;
      await this.#send(options.sendNotification, {
        method: "thread/realtime/sdp",
        params: {
          threadId: options.threadId,
          sdp,
        },
      });
    }
  }

  async #fanoutEvent(
    threadId: string,
    activeFanout: ActiveRealtimeFanout,
    event: RealtimeEvent,
    sendNotification: AgenCRealtimeNotificationSender | undefined,
  ): Promise<void> {
    switch (event.type) {
      case "audio_out":
        await this.#send(sendNotification, {
          method: "thread/realtime/outputAudio/delta",
          params: {
            threadId,
            audio: {
              data: event.frame.data,
              sampleRate: event.frame.sampleRate,
              numChannels: event.frame.numChannels,
              ...(event.frame.samplesPerChannel !== undefined
                ? { samplesPerChannel: event.frame.samplesPerChannel }
                : {}),
              ...(event.frame.itemId !== undefined
                ? { itemId: event.frame.itemId }
                : {}),
            },
          },
        });
        break;
      case "input_transcript_delta":
        await this.#send(sendNotification, {
          method: "thread/realtime/transcript/delta",
          params: { threadId, role: "user", delta: event.delta },
        });
        break;
      case "output_transcript_delta":
        await this.#send(sendNotification, {
          method: "thread/realtime/transcript/delta",
          params: { threadId, role: "assistant", delta: event.delta },
        });
        break;
      case "input_transcript_done":
        await this.#send(sendNotification, {
          method: "thread/realtime/transcript/done",
          params: { threadId, role: "user", text: event.text },
        });
        break;
      case "output_transcript_done":
        await this.#send(sendNotification, {
          method: "thread/realtime/transcript/done",
          params: { threadId, role: "assistant", text: event.text },
        });
        break;
      case "conversation_item_added":
        await this.#send(sendNotification, {
          method: "thread/realtime/itemAdded",
          params: { threadId, item: event.item },
        });
        break;
      case "handoff_requested":
        await this.#send(sendNotification, {
          method: "thread/realtime/itemAdded",
          params: {
            threadId,
            item: handoffItemPayload(event.handoff),
          },
        });
        break;
      case "error":
        activeFanout.closeReason = "error";
        await this.#send(sendNotification, {
          method: "thread/realtime/error",
          params: { threadId, message: event.message },
        });
        break;
      case "session_updated":
        await this.#sendStartedNotification({
          threadId,
          activeFanout,
          realtimeSessionId: event.realtimeSessionId,
          version: activeFanout.active.version,
          sendNotification,
        });
        break;
      case "input_audio_speech_started":
      case "response_created":
      case "response_cancelled":
      case "response_done":
      case "conversation_item_done":
      case "noop_requested":
        break;
    }
  }

  async #closeFanout(
    threadId: string,
    activeFanout: ActiveRealtimeFanout,
    sendNotification: AgenCRealtimeNotificationSender | undefined,
  ): Promise<void> {
    if (activeFanout.closed) return;
    activeFanout.closed = true;
    if (this.#activeFanouts.get(threadId) === activeFanout) {
      this.#activeFanouts.delete(threadId);
    }
    await this.#send(sendNotification, {
      method: "thread/realtime/closed",
      params: {
        threadId,
        reason: activeFanout.closeReason,
      },
    });
  }

  async #send(
    sendNotification: AgenCRealtimeNotificationSender | undefined,
    notification: Omit<AgenCDaemonNotification, "jsonrpc">,
  ): Promise<void> {
    if (sendNotification === undefined) return;
    await sendNotification({
      jsonrpc: JSON_RPC_VERSION,
      ...notification,
    } as AgenCDaemonNotification);
  }

  async #requireThread(threadId: string): Promise<AgenCRealtimeThreadBinding> {
    const registered = this.#registeredThreads.get(threadId);
    if (registered !== undefined) return registered;
    const resolved = await this.#resolveThread?.(threadId);
    if (resolved !== undefined && resolved !== null) return resolved;
    throw new AgenCDaemonAgentLifecycleError(
      "AGENT_NOT_FOUND",
      `thread ${threadId} does not support realtime conversation`,
    );
  }
}

function normalizeRealtimeStartTransport(
  transport: ThreadRealtimeStartParams["transport"],
): RealtimeTransportSelection {
  if (transport === undefined || transport === null) {
    return { type: "websocket" };
  }
  if (transport.type === "websocket") {
    return { type: "websocket" };
  }
  return { type: "webrtc", sdp: transport.sdp };
}

function handoffItemPayload(handoff: {
  readonly handoffId: string;
  readonly itemId: string;
  readonly inputTranscript: string;
  readonly activeTranscript: readonly {
    readonly role: string;
    readonly text: string;
  }[];
}): RealtimeConversationItemPayload {
  return {
    type: "handoff_request",
    handoffId: handoff.handoffId,
    itemId: handoff.itemId,
    inputTranscript: handoff.inputTranscript,
    activeTranscript: handoff.activeTranscript.map((entry) => ({
      role: entry.role,
      text: entry.text,
    })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
