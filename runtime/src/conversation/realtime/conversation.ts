/**
 * Ports upstream runtime `core/src/realtime_conversation.rs` onto AgenC's
 * TypeScript conversation primitives.
 *
 * Shape difference from upstream:
 *   - Concrete network construction is injected. This file owns the realtime
 *     phase machine, queues, handoff state, event handling, and session config
 *     shape that later daemon and transport items attach to.
 */

import { AsyncLock } from "../../utils/async-lock.js";
import { AsyncQueue } from "../../utils/async-queue.js";
import { BehaviorSubject } from "../../utils/behavior-subject.js";
import {
  buildRealtimeStartupContextFromSession,
  type RealtimeStartupContextOptions,
  type RealtimeStartupContextSessionLike,
} from "./context.js";

const AUDIO_IN_QUEUE_CAPACITY = 256;
const USER_TEXT_IN_QUEUE_CAPACITY = 64;
const HANDOFF_OUT_QUEUE_CAPACITY = 64;
const OUTPUT_EVENTS_QUEUE_CAPACITY = 256;
const CLOSE_TASK_DRAIN_TIMEOUT_MS = 50;
const CONTROL_QUEUE_CAPACITY =
  AUDIO_IN_QUEUE_CAPACITY + USER_TEXT_IN_QUEUE_CAPACITY + HANDOFF_OUT_QUEUE_CAPACITY + 1;
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-1.5";
export const REALTIME_USER_TEXT_PREFIX = "[USER] ";
export const REALTIME_BACKEND_TEXT_PREFIX = "[BACKEND] ";

const REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT =
  "Background agent finished. Use the preceding [BACKEND] messages as the result.";
const REALTIME_V2_STEER_ACKNOWLEDGEMENT =
  "This was sent to steer the previous background agent task.";
const REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";

export type RealtimeConversationPhase = "idle" | "connecting" | "active" | "closing";
export type RealtimeSessionVersion = "v1" | "v2";
export type RealtimeSessionMode = "conversational" | "transcription";
export type RealtimeOutputModality = "audio" | "text";
export type RealtimeTransportSelection =
  | { readonly type: "websocket" }
  | { readonly type: "webrtc"; readonly sdp: string };
type RealtimeConversationItemJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly RealtimeConversationItemJsonValue[]
  | { readonly [key: string]: RealtimeConversationItemJsonValue };
export type RealtimeConversationItemPayload = {
  readonly [key: string]: RealtimeConversationItemJsonValue;
};

export type RealtimeVoice =
  | "alloy"
  | "arbor"
  | "ash"
  | "ballad"
  | "breeze"
  | "cedar"
  | "coral"
  | "cove"
  | "echo"
  | "ember"
  | "juniper"
  | "maple"
  | "marin"
  | "sage"
  | "shimmer"
  | "sol"
  | "spruce"
  | "vale"
  | "verse";

const REALTIME_V1_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const satisfies readonly RealtimeVoice[];

const REALTIME_V2_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const satisfies readonly RealtimeVoice[];

export interface RealtimeVoicesList {
  readonly v1: readonly RealtimeVoice[];
  readonly v2: readonly RealtimeVoice[];
  readonly defaultV1: RealtimeVoice;
  readonly defaultV2: RealtimeVoice;
}

export interface RealtimeAudioFrame {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly samplesPerChannel?: number;
  readonly itemId?: string;
}

export interface RealtimeSessionConfig {
  readonly instructions: string;
  readonly model: string;
  readonly sessionId: string;
  readonly version: RealtimeSessionVersion;
  readonly sessionMode: RealtimeSessionMode;
  readonly outputModality: RealtimeOutputModality;
  readonly voice: RealtimeVoice;
}

export interface BuildRealtimeSessionConfigOptions {
  readonly conversationId: string;
  readonly prompt?: string | null;
  readonly backendPrompt?: string | null;
  readonly startupContext?: string | null;
  readonly realtimeSessionId?: string | null;
  readonly outputModality: RealtimeOutputModality;
  readonly voice?: RealtimeVoice | null;
  readonly configuredVoice?: RealtimeVoice | null;
  readonly version?: RealtimeSessionVersion;
  readonly sessionMode?: RealtimeSessionMode;
  readonly model?: string | null;
}

export interface BuildRealtimeSessionConfigFromSessionOptions
  extends Omit<
    BuildRealtimeSessionConfigOptions,
    "conversationId" | "startupContext"
  > {
  readonly session: RealtimeStartupContextSessionLike;
  readonly startupContext?: string | null;
  readonly startupContextOptions?: Omit<
    RealtimeStartupContextOptions,
    "history" | "cwd" | "conversationId"
  >;
}

export interface RealtimeTransportRequest {
  readonly transport: RealtimeTransportSelection;
  readonly sessionConfig: RealtimeSessionConfig;
  readonly callerSdp?: string;
  readonly requestedSessionId: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RealtimeTransportConnection {
  readonly writer: RealtimeWriter;
  readonly providerSdp?: string;
  readonly nextEvent: () => Promise<RealtimeEvent | null>;
  readonly close: () => Promise<void> | void;
}

export interface RealtimeWriter {
  sendAudioFrame(frame: RealtimeAudioFrame): Promise<void> | void;
  sendConversationItemCreate(text: string): Promise<void> | void;
  sendConversationFunctionCallOutput(
    handoffId: string,
    outputText: string,
  ): Promise<void> | void;
  sendResponseCreate(): Promise<void> | void;
  sendPayload(payload: string): Promise<void> | void;
}

export type RealtimeEvent =
  | {
      readonly type: "session_updated";
      readonly realtimeSessionId: string;
      readonly instructions?: string;
    }
  | {
      readonly type: "input_audio_speech_started";
      readonly itemId?: string;
    }
  | { readonly type: "input_transcript_delta"; readonly delta: string }
  | { readonly type: "input_transcript_done"; readonly text: string }
  | { readonly type: "output_transcript_delta"; readonly delta: string }
  | { readonly type: "output_transcript_done"; readonly text: string }
  | { readonly type: "audio_out"; readonly frame: RealtimeAudioFrame }
  | { readonly type: "response_created"; readonly responseId?: string }
  | { readonly type: "response_cancelled"; readonly responseId?: string }
  | { readonly type: "response_done"; readonly responseId?: string }
  | {
      readonly type: "conversation_item_added";
      readonly item: RealtimeConversationItemPayload;
    }
  | { readonly type: "conversation_item_done"; readonly itemId: string }
  | { readonly type: "handoff_requested"; readonly handoff: RealtimeHandoffRequested }
  | { readonly type: "noop_requested"; readonly callId: string; readonly itemId: string }
  | { readonly type: "error"; readonly message: string };

export interface RealtimeTranscriptEntry {
  readonly role: string;
  readonly text: string;
}

export interface RealtimeHandoffRequested {
  readonly handoffId: string;
  readonly itemId: string;
  readonly inputTranscript: string;
  readonly activeTranscript: readonly RealtimeTranscriptEntry[];
}

export interface RealtimeActiveHandle {
  readonly id: number;
  readonly version: RealtimeSessionVersion;
  readonly sessionId: string;
}

export interface RealtimeStartOptions {
  readonly sessionConfig: RealtimeSessionConfig;
  readonly transport?: RealtimeTransportSelection;
  readonly headers?: Readonly<Record<string, string>>;
  readonly connectTransport: (
    request: RealtimeTransportRequest,
  ) => Promise<RealtimeTransportConnection> | RealtimeTransportConnection;
  readonly routeRealtimeTextInput?: (text: string) => Promise<void> | void;
}

export interface RealtimeStartOutput {
  readonly active: RealtimeActiveHandle;
  readonly providerSdp?: string;
}

export interface RealtimeRunningState {
  readonly active: RealtimeActiveHandle;
  readonly phase: RealtimeConversationPhase;
}

export interface RealtimeConversation {
  readonly phase: BehaviorSubject<RealtimeConversationPhase>;
  runningState(): Promise<RealtimeRunningState | undefined>;
  isRunningV2(): Promise<boolean>;
  start(options: RealtimeStartOptions): Promise<RealtimeStartOutput>;
  registerFanout(
    active: RealtimeActiveHandle,
    consumer: (events: AsyncIterable<RealtimeEvent>) => Promise<void> | void,
  ): Promise<boolean>;
  finishIfActive(active: RealtimeActiveHandle): Promise<void>;
  audioIn(frame: RealtimeAudioFrame): Promise<void>;
  textIn(text: string): Promise<void>;
  handoffOut(outputText: string): Promise<void>;
  handoffComplete(): Promise<void>;
  activeHandoffId(): Promise<string | null>;
  clearActiveHandoff(): Promise<void>;
  shutdown(): Promise<void>;
}

type HandoffOutput =
  | { readonly type: "progress"; readonly handoffId: string; readonly outputText: string }
  | { readonly type: "final"; readonly handoffId: string; readonly outputText: string };

type ControlEvent =
  | { readonly type: "user_text"; readonly text: string }
  | { readonly type: "handoff_output"; readonly output: HandoffOutput }
  | { readonly type: "audio"; readonly frame: RealtimeAudioFrame }
  | { readonly type: "server_event"; readonly event: RealtimeEvent }
  | { readonly type: "transport_closed" }
  | { readonly type: "transport_error"; readonly message: string };

interface HandoffMemory {
  activeHandoffId: string | null;
  lastOutputText: string | null;
}

interface OutputAudioState {
  itemId: string;
  audioEndMs: number;
}

interface ConversationState {
  active: RealtimeActiveHandle;
  version: RealtimeSessionVersion;
  connection: RealtimeTransportConnection;
  writer: RealtimeWriter;
  audioQueue: AsyncQueue<RealtimeAudioFrame>;
  userTextQueue: AsyncQueue<string>;
  handoffOutputQueue: AsyncQueue<HandoffOutput>;
  controlQueue: AsyncQueue<ControlEvent>;
  outputEventsQueue: AsyncQueue<RealtimeEvent>;
  handoff: AsyncLock<HandoffMemory>;
  responseCreateQueue: RealtimeResponseCreateQueue;
  routeRealtimeTextInput?: (text: string) => Promise<void> | void;
  activeFlag: boolean;
  closeReason: RealtimeConversationClosedReason;
  inputTask: Promise<void>;
  pumpTasks: Promise<void>[];
  fanoutTask: Promise<void> | null;
}

type RealtimeConversationClosedReason = "requested" | "transport_closed" | "error";

export class RealtimeConversationManager implements RealtimeConversation {
  readonly phase = new BehaviorSubject<RealtimeConversationPhase>("idle");
  private readonly state = new AsyncLock<ConversationState | null>(null);
  private readonly lifecycle = new AsyncLock<null>(null);
  private nextActiveId = 1;

  async runningState(): Promise<RealtimeRunningState | undefined> {
    return this.state.with((state) =>
      state?.activeFlag === true
        ? { active: state.active, phase: this.phase.value }
        : undefined,
    );
  }

  async isRunningV2(): Promise<boolean> {
    const running = await this.runningState();
    return running?.active.version === "v2";
  }

  async start(options: RealtimeStartOptions): Promise<RealtimeStartOutput> {
    return this.lifecycle.with(() => this.startLocked(options));
  }

  private async startLocked(
    options: RealtimeStartOptions,
  ): Promise<RealtimeStartOutput> {
    const previous = await this.state.swap(null);
    if (previous !== null) {
      await this.closeState(previous, "requested", true);
    }

    this.phase.next("connecting");
    const transport = resolveRealtimeTransportSelection(options.transport);
    const request: RealtimeTransportRequest = {
      transport,
      sessionConfig: options.sessionConfig,
      requestedSessionId: options.sessionConfig.sessionId,
      ...(transport.type === "webrtc" ? { callerSdp: transport.sdp } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    };

    let connection: RealtimeTransportConnection;
    try {
      connection = await options.connectTransport(request);
    } catch (error) {
      this.phase.next("idle");
      throw error;
    }

    const active: RealtimeActiveHandle = {
      id: this.nextActiveId,
      version: options.sessionConfig.version,
      sessionId: options.sessionConfig.sessionId,
    };
    this.nextActiveId += 1;

    const state: ConversationState = {
      active,
      version: options.sessionConfig.version,
      connection,
      writer: connection.writer,
      audioQueue: new AsyncQueue<RealtimeAudioFrame>({
        maxDepth: AUDIO_IN_QUEUE_CAPACITY,
      }),
      userTextQueue: new AsyncQueue<string>({
        maxDepth: USER_TEXT_IN_QUEUE_CAPACITY,
      }),
      handoffOutputQueue: new AsyncQueue<HandoffOutput>({
        maxDepth: HANDOFF_OUT_QUEUE_CAPACITY,
      }),
      controlQueue: new AsyncQueue<ControlEvent>({
        maxDepth: CONTROL_QUEUE_CAPACITY,
      }),
      outputEventsQueue: new AsyncQueue<RealtimeEvent>({
        maxDepth: OUTPUT_EVENTS_QUEUE_CAPACITY,
      }),
      handoff: new AsyncLock<HandoffMemory>({
        activeHandoffId: null,
        lastOutputText: null,
      }),
      responseCreateQueue: new RealtimeResponseCreateQueue(),
      ...(options.routeRealtimeTextInput !== undefined
        ? { routeRealtimeTextInput: options.routeRealtimeTextInput }
        : {}),
      activeFlag: true,
      closeReason: "transport_closed",
      inputTask: Promise.resolve(),
      pumpTasks: [],
      fanoutTask: null,
    };
    await this.state.swap(state);
    this.phase.next("active");
    state.pumpTasks = this.spawnPumps(state);
    state.inputTask = this.runInputLoop(state);
    return { active, providerSdp: connection.providerSdp };
  }

  async registerFanout(
    active: RealtimeActiveHandle,
    consumer: (events: AsyncIterable<RealtimeEvent>) => Promise<void> | void,
  ): Promise<boolean> {
    return this.state.with((state) => {
      if (!this.stateMatches(state, active)) return false;
      if (state.fanoutTask !== null) return false;
      const fanoutTask = Promise.resolve()
        .then(() => consumer(state.outputEventsQueue.stream()))
        .then(
          () => this.handleFanoutEnd(active),
          () => this.handleFanoutEnd(active),
        );
      state.fanoutTask = fanoutTask;
      return true;
    });
  }

  async finishIfActive(active: RealtimeActiveHandle): Promise<void> {
    const state = await this.takeMatchingState(active);
    if (state !== null) {
      await this.closeState(state, "transport_closed", true);
    }
  }

  async audioIn(frame: RealtimeAudioFrame): Promise<void> {
    const state = await this.currentActiveState();
    if (state === null) throw new Error("conversation is not running");
    const accepted = state.audioQueue.send(frame);
    if (!accepted && state.audioQueue.isClosed) {
      throw new Error("conversation is not running");
    }
  }

  async textIn(text: string): Promise<void> {
    const state = await this.currentActiveState();
    if (state === null) throw new Error("conversation is not running");
    const queued = await state.userTextQueue.sendBlocking(
      prefixRealtimeText(text, REALTIME_USER_TEXT_PREFIX, state.version),
    );
    if (!queued) throw new Error("conversation is not running");
  }

  async handoffOut(outputText: string): Promise<void> {
    const state = await this.currentActiveState();
    if (state === null) throw new Error("conversation is not running");
    const output = await state.handoff.with<HandoffOutput | null>((memory) => {
      if (memory.activeHandoffId === null) return null;
      const text = prefixRealtimeText(
        outputText,
        REALTIME_BACKEND_TEXT_PREFIX,
        state.version,
      );
      memory.lastOutputText = text;
      return {
        type: "progress",
        handoffId: memory.activeHandoffId,
        outputText: text,
      };
    });
    if (output === null) return;
    const queued = await state.handoffOutputQueue.sendBlocking(output);
    if (!queued) throw new Error("conversation is not running");
  }

  async handoffComplete(): Promise<void> {
    const state = await this.currentActiveState();
    if (state === null || state.version === "v1") return;
    const output = await state.handoff.with<HandoffOutput | null>((memory) => {
      if (memory.activeHandoffId === null || memory.lastOutputText === null) {
        return null;
      }
      return {
        type: "final",
        handoffId: memory.activeHandoffId,
        outputText: memory.lastOutputText,
      };
    });
    if (output === null) return;
    const queued = await state.handoffOutputQueue.sendBlocking(output);
    if (!queued) throw new Error("conversation is not running");
  }

  async activeHandoffId(): Promise<string | null> {
    const state = await this.currentActiveState();
    if (state === null) return null;
    return state.handoff.with((memory) => memory.activeHandoffId);
  }

  async clearActiveHandoff(): Promise<void> {
    const state = await this.currentActiveState();
    if (state === null) return;
    await state.handoff.with((memory) => {
      memory.activeHandoffId = null;
      memory.lastOutputText = null;
    });
  }

  async shutdown(): Promise<void> {
    await this.lifecycle.with(async () => {
      const state = await this.state.swap(null);
      if (state !== null) {
        await this.closeState(state, "requested", true);
      }
    });
  }

  private spawnPumps(state: ConversationState): Promise<void>[] {
    return [
      this.pumpSource(state, state.userTextQueue, (text) => ({
        type: "user_text",
        text,
      })),
      this.pumpSource(state, state.handoffOutputQueue, (output) => ({
        type: "handoff_output",
        output,
      })),
      this.pumpSource(state, state.audioQueue, (frame) => ({ type: "audio", frame })),
      this.pumpTransportEvents(state),
    ];
  }

  private async pumpSource<T>(
    state: ConversationState,
    queue: AsyncQueue<T>,
    map: (item: T) => ControlEvent,
  ): Promise<void> {
    for await (const item of queue.stream()) {
      if (!state.activeFlag) return;
      const accepted = await state.controlQueue.sendBlocking(map(item));
      if (!accepted) return;
    }
  }

  private async pumpTransportEvents(state: ConversationState): Promise<void> {
    while (state.activeFlag) {
      try {
        const event = await state.connection.nextEvent();
        if (event === null) {
          await state.controlQueue.sendBlocking({ type: "transport_closed" });
          return;
        }
        const accepted = await state.controlQueue.sendBlocking({
          type: "server_event",
          event,
        });
        if (!accepted) return;
      } catch (error) {
        await state.controlQueue.sendBlocking({
          type: "transport_error",
          message: errorMessage(error),
        });
        return;
      }
    }
  }

  private async runInputLoop(state: ConversationState): Promise<void> {
    let outputAudioState: OutputAudioState | null = null;
    while (state.activeFlag) {
      const event = await state.controlQueue.recv();
      if (event === null) return;
      try {
        switch (event.type) {
          case "user_text":
            await this.handleUserTextInput(state, event.text);
            break;
          case "handoff_output":
            await this.handleHandoffOutput(state, event.output);
            break;
          case "audio":
            await this.handleUserAudioInput(state, event.frame);
            break;
          case "server_event":
            outputAudioState = await this.handleRealtimeServerEvent(
              state,
              event.event,
              outputAudioState,
            );
            break;
          case "transport_closed":
            await this.endFromInputLoop(state, "transport_closed");
            return;
          case "transport_error":
            await this.emitRealtimeEvent(state, {
              type: "error",
              message: event.message,
            });
            await this.endFromInputLoop(state, "error");
            return;
        }
      } catch (error) {
        await this.emitRealtimeEvent(state, {
          type: "error",
          message: errorMessage(error),
        });
        await this.endFromInputLoop(state, "error");
        return;
      }
    }
  }

  private async handleUserTextInput(
    state: ConversationState,
    text: string,
  ): Promise<void> {
    await state.writer.sendConversationItemCreate(text);
  }

  private async handleUserAudioInput(
    state: ConversationState,
    frame: RealtimeAudioFrame,
  ): Promise<void> {
    await state.writer.sendAudioFrame(frame);
  }

  private async handleHandoffOutput(
    state: ConversationState,
    output: HandoffOutput,
  ): Promise<void> {
    if (state.version === "v1") {
      await state.writer.sendConversationFunctionCallOutput(
        output.handoffId,
        output.outputText,
      );
      return;
    }

    if (output.type === "progress") {
      const active = await state.handoff.with((memory) => memory.activeHandoffId);
      if (active !== output.handoffId) return;
      await state.writer.sendConversationItemCreate(output.outputText);
      return;
    }

    await state.writer.sendConversationFunctionCallOutput(
      output.handoffId,
      REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT,
    );
    await state.responseCreateQueue.requestCreate(state.writer);
  }

  private async handleRealtimeServerEvent(
    state: ConversationState,
    event: RealtimeEvent,
    outputAudioState: OutputAudioState | null,
  ): Promise<OutputAudioState | null> {
    let nextOutputAudioState = outputAudioState;
    let endReason: RealtimeConversationClosedReason | null = null;

    switch (event.type) {
      case "audio_out":
        if (state.version === "v2") {
          nextOutputAudioState = updateOutputAudioState(
            nextOutputAudioState,
            event.frame,
          );
        }
        break;
      case "input_audio_speech_started":
        if (state.version === "v2" && nextOutputAudioState !== null) {
          if (
            event.itemId === undefined ||
            event.itemId === nextOutputAudioState.itemId
          ) {
            await state.writer.sendPayload(
              JSON.stringify({
                type: "conversation.item.truncate",
                item_id: nextOutputAudioState.itemId,
                content_index: 0,
                audio_end_ms: nextOutputAudioState.audioEndMs,
              }),
            );
            nextOutputAudioState = null;
          }
        }
        break;
      case "response_created":
        if (state.version === "v2") state.responseCreateQueue.markStarted();
        break;
      case "response_cancelled":
      case "response_done":
        nextOutputAudioState = null;
        if (state.version === "v2") {
          await state.responseCreateQueue.markFinished(state.writer);
        }
        break;
      case "handoff_requested":
        nextOutputAudioState = null;
        await this.handleHandoffRequested(state, event.handoff);
        break;
      case "noop_requested":
        nextOutputAudioState = null;
        if (state.version === "v2") {
          await state.writer.sendConversationFunctionCallOutput(event.callId, "");
        }
        break;
      case "error":
        endReason = "error";
        break;
      case "session_updated":
      case "input_transcript_delta":
      case "input_transcript_done":
      case "output_transcript_delta":
      case "output_transcript_done":
      case "conversation_item_added":
      case "conversation_item_done":
        break;
    }

    await this.emitRealtimeEvent(state, event);
    if (endReason !== null) {
      await this.endFromInputLoop(state, endReason);
    }
    return nextOutputAudioState;
  }

  private async handleHandoffRequested(
    state: ConversationState,
    handoff: RealtimeHandoffRequested,
  ): Promise<void> {
    const routedText = realtimeDelegationFromHandoff(handoff);
    if (routedText !== null) {
      await state.routeRealtimeTextInput?.(routedText);
    }

    if (state.version === "v1") {
      await state.handoff.with((memory) => {
        memory.lastOutputText = null;
        memory.activeHandoffId = handoff.handoffId;
      });
      return;
    }

    const active = await state.handoff.with((memory) => memory.activeHandoffId);
    if (active !== null) {
      await state.writer.sendConversationFunctionCallOutput(
        handoff.handoffId,
        REALTIME_V2_STEER_ACKNOWLEDGEMENT,
      );
      await state.responseCreateQueue.requestCreate(state.writer);
      return;
    }

    await state.handoff.with((memory) => {
      memory.lastOutputText = null;
      memory.activeHandoffId = handoff.handoffId;
    });
  }

  private async emitRealtimeEvent(
    state: ConversationState,
    event: RealtimeEvent,
  ): Promise<void> {
    if (
      state.fanoutTask === null &&
      state.outputEventsQueue.size >= OUTPUT_EVENTS_QUEUE_CAPACITY
    ) {
      await this.endFromInputLoop(state, "transport_closed");
      return;
    }
    const accepted = await state.outputEventsQueue.sendBlocking(event);
    if (!accepted) {
      await this.endFromInputLoop(state, state.closeReason);
    }
  }

  private async handleFanoutEnd(active: RealtimeActiveHandle): Promise<void> {
    const state = await this.takeMatchingState(active);
    if (state !== null && state.activeFlag) {
      await this.closeState(state, "transport_closed", false);
    }
  }

  private async endFromInputLoop(
    state: ConversationState,
    reason: RealtimeConversationClosedReason,
  ): Promise<void> {
    if (!state.activeFlag) return;
    state.closeReason = reason;
    const claimed = await this.state.update((current) => {
      if (current === state) {
        state.activeFlag = false;
        return { next: null, result: true };
      }
      return { next: current, result: false };
    });
    if (!claimed) return;
    this.phase.next("closing");
    this.closeQueues(state);
    try {
      await this.closeConnection(state);
    } finally {
      this.phase.next("idle");
    }
  }

  private async closeState(
    state: ConversationState,
    reason: RealtimeConversationClosedReason,
    waitForTasks: boolean,
  ): Promise<void> {
    if (!state.activeFlag && !waitForTasks) return;
    this.phase.next("closing");
    state.closeReason = reason;
    state.activeFlag = false;
    this.closeQueues(state);
    try {
      await this.closeConnection(state);
    } finally {
      if (waitForTasks) {
        await this.waitForCloseTasks(state);
      }
      this.phase.next("idle");
    }
  }

  private async closeConnection(state: ConversationState): Promise<void> {
    try {
      await state.connection.close();
    } catch {
      return;
    }
  }

  private async waitForCloseTasks(state: ConversationState): Promise<void> {
    const tasks = [
      ...state.pumpTasks,
      state.inputTask,
      ...(state.fanoutTask === null ? [] : [state.fanoutTask]),
    ];
    const settled = Promise.allSettled(tasks);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TASK_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private closeQueues(state: ConversationState): void {
    state.audioQueue.close();
    state.userTextQueue.close();
    state.handoffOutputQueue.close();
    state.controlQueue.close();
    state.outputEventsQueue.close();
  }

  private async currentActiveState(): Promise<ConversationState | null> {
    return this.state.with((state) => (state?.activeFlag === true ? state : null));
  }

  private async takeMatchingState(
    active: RealtimeActiveHandle,
  ): Promise<ConversationState | null> {
    return this.state.update((state) => {
      if (this.stateMatches(state, active)) {
        return { next: null, result: state };
      }
      return { next: state, result: null };
    });
  }

  private stateMatches(
    state: ConversationState | null,
    active: RealtimeActiveHandle,
  ): state is ConversationState {
    return state?.activeFlag === true && state.active.id === active.id;
  }
}

class RealtimeResponseCreateQueue {
  private activeDefaultResponse = false;
  private pendingCreate = false;

  async requestCreate(writer: RealtimeWriter): Promise<void> {
    if (this.activeDefaultResponse) {
      this.pendingCreate = true;
      return;
    }
    await this.sendCreateNow(writer);
  }

  markStarted(): void {
    this.activeDefaultResponse = true;
  }

  async markFinished(writer: RealtimeWriter): Promise<void> {
    this.activeDefaultResponse = false;
    if (!this.pendingCreate) return;
    this.pendingCreate = false;
    await this.sendCreateNow(writer);
  }

  private async sendCreateNow(writer: RealtimeWriter): Promise<void> {
    try {
      await writer.sendResponseCreate();
      this.activeDefaultResponse = true;
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith(REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
        this.activeDefaultResponse = true;
        this.pendingCreate = true;
        return;
      }
      throw error;
    }
  }
}

export function buildRealtimeSessionConfig(
  options: BuildRealtimeSessionConfigOptions,
): RealtimeSessionConfig {
  const version = options.version ?? "v2";
  const prompt = prepareRealtimeInstructions(
    options.prompt,
    options.backendPrompt ?? "",
    options.startupContext ?? "",
  );
  if (version === "v1" && options.outputModality === "text") {
    throw new Error("text realtime output modality requires realtime v2");
  }
  const voice =
    options.voice ??
    options.configuredVoice ??
    defaultRealtimeVoice(version);
  validateRealtimeVoice(version, voice);
  return {
    instructions: prompt,
    model: options.model ?? DEFAULT_REALTIME_MODEL,
    sessionId: options.realtimeSessionId ?? options.conversationId,
    version,
    sessionMode: options.sessionMode ?? "conversational",
    outputModality: options.outputModality,
    voice,
  };
}

export async function buildRealtimeSessionConfigFromSession(
  options: BuildRealtimeSessionConfigFromSessionOptions,
): Promise<RealtimeSessionConfig> {
  const {
    session,
    startupContextOptions,
    startupContext,
    ...configOptions
  } = options;
  const conversationId = session.conversationId ?? options.realtimeSessionId;
  if (
    conversationId === undefined ||
    conversationId === null ||
    conversationId.length === 0
  ) {
    throw new Error("realtime session config requires a conversation id");
  }
  const resolvedStartupContext =
    startupContext !== undefined
      ? startupContext
      : await buildRealtimeStartupContextFromSession(
          session,
          startupContextOptions ?? {},
        );
  return buildRealtimeSessionConfig({
    ...configOptions,
    conversationId,
    startupContext: resolvedStartupContext,
  });
}

export function prepareRealtimeInstructions(
  prompt: string | null | undefined,
  backendPrompt: string | null,
  startupContext: string | null,
): string {
  const preparedPrompt = prompt === undefined ? backendPrompt ?? "" : prompt ?? "";
  const preparedContext = startupContext ?? "";
  if (preparedPrompt.length === 0) return preparedContext;
  if (preparedContext.length === 0) return preparedPrompt;
  return `${preparedPrompt}\n\n${preparedContext}`;
}

export function resolveRealtimeTransportSelection(
  transport?: RealtimeTransportSelection,
): RealtimeTransportSelection {
  return transport ?? { type: "websocket" };
}

export function builtinRealtimeVoices(): RealtimeVoicesList {
  return {
    v1: REALTIME_V1_VOICES,
    v2: REALTIME_V2_VOICES,
    defaultV1: "cove",
    defaultV2: "marin",
  };
}

export function defaultRealtimeVoice(version: RealtimeSessionVersion): RealtimeVoice {
  const voices = builtinRealtimeVoices();
  return version === "v1" ? voices.defaultV1 : voices.defaultV2;
}

export function validateRealtimeVoice(
  version: RealtimeSessionVersion,
  voice: RealtimeVoice,
): void {
  const voices = builtinRealtimeVoices();
  const allowed = version === "v1" ? voices.v1 : voices.v2;
  if (allowed.includes(voice)) return;
  throw new Error(
    `realtime voice \`${voice}\` is not supported for ${version}; supported voices: ${allowed.join(", ")}`,
  );
}

export function prefixRealtimeV2Text(text: string, prefix: string): string {
  return prefixRealtimeText(text, prefix, "v2");
}

export function wrapRealtimeDelegationInput(
  input: string,
  transcriptDelta?: string | null,
): string {
  const escapedInput = escapeXmlText(input);
  if (transcriptDelta !== undefined && transcriptDelta !== null && transcriptDelta.length > 0) {
    return (
      "<realtime_delegation>\n" +
      `  <input>${escapedInput}</input>\n` +
      `  <transcript_delta>${escapeXmlText(transcriptDelta)}</transcript_delta>\n` +
      "</realtime_delegation>"
    );
  }
  return (
    "<realtime_delegation>\n" +
    `  <input>${escapedInput}</input>\n` +
    "</realtime_delegation>"
  );
}

export function audioDurationMs(frame: RealtimeAudioFrame): number {
  const samplesPerChannel =
    frame.samplesPerChannel ?? decodedSamplesPerChannel(frame);
  const sampleRate = positiveIntegerMetadata(frame.sampleRate);
  if (samplesPerChannel === null || sampleRate === null) return 0;
  if (!Number.isFinite(samplesPerChannel) || samplesPerChannel <= 0) return 0;
  return Math.floor((samplesPerChannel * 1_000) / sampleRate);
}

function prefixRealtimeText(
  text: string,
  prefix: string,
  version: RealtimeSessionVersion,
): string {
  if (version !== "v2" || text.length === 0 || text.startsWith(prefix)) {
    return text;
  }
  return `${prefix}${text}`;
}

function updateOutputAudioState(
  current: OutputAudioState | null,
  frame: RealtimeAudioFrame,
): OutputAudioState | null {
  if (frame.itemId === undefined) return current;
  const duration = audioDurationMs(frame);
  if (duration === 0) return current;
  if (current !== null && current.itemId === frame.itemId) {
    return { itemId: current.itemId, audioEndMs: current.audioEndMs + duration };
  }
  return { itemId: frame.itemId, audioEndMs: duration };
}

function realtimeDelegationFromHandoff(
  handoff: RealtimeHandoffRequested,
): string | null {
  const transcriptDelta = realtimeTranscriptDeltaFromHandoff(handoff);
  const input =
    handoff.inputTranscript.length > 0
      ? handoff.inputTranscript
      : transcriptDelta;
  if (input === null || input.length === 0) return null;
  return wrapRealtimeDelegationInput(input, transcriptDelta);
}

function realtimeTranscriptDeltaFromHandoff(
  handoff: RealtimeHandoffRequested,
): string | null {
  const activeTranscript = handoff.activeTranscript
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join("\n");
  return activeTranscript.length > 0 ? activeTranscript : null;
}

function decodedSamplesPerChannel(frame: RealtimeAudioFrame): number | null {
  try {
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.length === 0) return null;
    const channels = positiveIntegerMetadata(frame.numChannels);
    if (channels === null) return null;
    const samples = Math.floor(bytes.length / 2 / channels);
    return samples > 0 ? samples : null;
  } catch {
    return null;
  }
}

function positiveIntegerMetadata(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
}

function escapeXmlText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function errorMessage(error: any): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
