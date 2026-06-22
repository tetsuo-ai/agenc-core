/**
 * AgenC realtime WebRTC call negotiation helpers.
 *
 * The daemon method surface owns only the HTTP SDP call-create leg here. The
 * returned call id is handed to the injected realtime transport connector so it
 * can join the sideband stream without coupling this file to a websocket stack.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { JsonObject, JsonValue } from "./protocol/index.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { isRecord } from "../utils/record.js";
import type {
  RealtimeAudioFrame,
  RealtimeConversationItemPayload,
  RealtimeEvent,
  RealtimeOutputModality,
  RealtimeSessionConfig,
  RealtimeTransportConnection,
  RealtimeTransportRequest,
  RealtimeWriter,
} from "../conversation/realtime/conversation.js";

export const AGENC_REALTIME_CALL_MULTIPART_BOUNDARY =
  "agenc-realtime-call-boundary" as const;
export const AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE =
  `multipart/form-data; boundary=${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}` as const;
// Donor uses a fixed multipart boundary. AgenC generates a per-request boundary
// for call creation so caller SDP cannot inject a multipart part boundary.
const DEFAULT_AUDIO_SAMPLE_RATE = 24_000;
/**
 * Upper bound on buffered, not-yet-consumed inbound realtime events. The
 * websocket message handler pushes into an AsyncQueue drained one event at a
 * time by the call client; without a cap a stalled consumer lets the queue
 * grow without limit. Generous enough that a healthy consumer never trips it.
 */
export const MAX_REALTIME_EVENT_QUEUE_DEPTH = 10_000;
const DEFAULT_AUDIO_CHANNELS = 1;
const BACKGROUND_AGENT_TOOL_NAME = "background_agent";
const SILENCE_TOOL_NAME = "remain_silent";
const AGENT_FINAL_MESSAGE_PREFIX = '"Agent Final Message":\n\n';
const TOOL_ARGUMENT_KEYS = [
  "input_transcript",
  "input",
  "text",
  "prompt",
  "query",
] as const;

interface MutableRealtimeTranscriptEntry {
  role: string;
  text: string;
}

export interface AgenCRealtimeCallResponse {
  readonly sdp: string;
  readonly callId: string;
}

export interface AgenCRealtimeHttpResponse {
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export type AgenCRealtimeFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<AgenCRealtimeHttpResponse>;

export type AgenCRealtimeHeadersProvider =
  | Readonly<Record<string, string>>
  | ((
      sessionConfig?: RealtimeSessionConfig,
    ) =>
      | Readonly<Record<string, string>>
      | Promise<Readonly<Record<string, string>>>);

export interface AgenCRealtimeCallClientOptions {
  readonly baseUrl: string;
  readonly defaultHeaders?: AgenCRealtimeHeadersProvider;
  readonly fetch?: AgenCRealtimeFetch;
}

export class AgenCRealtimeCallClient {
  readonly #baseUrl: string;
  readonly #defaultHeaders: AgenCRealtimeHeadersProvider;
  readonly #fetch: AgenCRealtimeFetch;

  constructor(options: AgenCRealtimeCallClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#fetch = options.fetch ?? defaultRealtimeFetch();
  }

  async create(
    sdp: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<AgenCRealtimeCallResponse> {
    const defaultHeaders = await resolveRealtimeHeaders(this.#defaultHeaders);
    const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...extraHeaders,
        "content-type": "application/sdp",
      },
      body: sdp,
    });
    return decodeRealtimeCallResponse(response);
  }

  async createWithSession(
    sdp: string,
    sessionConfig: RealtimeSessionConfig,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<AgenCRealtimeCallResponse> {
    const session = realtimeCallSessionConfigToProviderJson(sessionConfig);
    const defaultHeaders = await resolveRealtimeHeaders(
      this.#defaultHeaders,
      sessionConfig,
    );
    if (usesBackendRealtimeCallShape(this.#baseUrl)) {
      const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
        method: "POST",
        headers: {
          ...defaultHeaders,
          ...extraHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sdp, session }),
      });
      return decodeRealtimeCallResponse(response);
    }

    const boundary = randomRealtimeMultipartBoundary();
    const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
      method: "POST",
      headers: {
        ...defaultHeaders,
        ...extraHeaders,
        "content-type": realtimeCallMultipartContentType(boundary),
      },
      body: realtimeCallMultipartBody(sdp, session, boundary),
    });
    return decodeRealtimeCallResponse(response);
  }
}

export interface AgenCRealtimeWebSocketOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export interface AgenCRealtimeWebSocketLike {
  readonly readyState?: number;
  on(event: "open", listener: () => void): this;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): this;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  off?(
    event: "open" | "message" | "close" | "error",
    listener: (...args: any[]) => void,
  ): this;
  send(payload: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export type AgenCRealtimeWebSocketFactory = (
  url: string,
  options: AgenCRealtimeWebSocketOptions,
) => AgenCRealtimeWebSocketLike;

export interface AgenCRealtimeWebSocketTransportOptions {
  readonly baseUrl: string;
  readonly defaultHeaders?: AgenCRealtimeHeadersProvider;
  readonly websocketFactory?: AgenCRealtimeWebSocketFactory;
}

export class AgenCRealtimeWebSocketTransportConnector {
  readonly #baseUrl: string;
  readonly #defaultHeaders: AgenCRealtimeHeadersProvider;
  readonly #websocketFactory: AgenCRealtimeWebSocketFactory;

  constructor(options: AgenCRealtimeWebSocketTransportOptions) {
    this.#baseUrl = options.baseUrl;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.#websocketFactory =
      options.websocketFactory ?? defaultRealtimeWebSocketFactory();
  }

  async connect(
    request: RealtimeTransportRequest,
  ): Promise<RealtimeTransportConnection> {
    const headers = {
      ...(await resolveRealtimeHeaders(
        this.#defaultHeaders,
        request.sessionConfig,
      )),
      ...(request.headers ?? {}),
      "x-session-id": request.sessionConfig.sessionId,
    };
    const socket = this.#websocketFactory(
      realtimeWebSocketUrl(
        this.#baseUrl,
        request.sessionConfig,
        request.providerCallId,
      ),
      { headers },
    );
    // Bound the inbound event queue so a stalled consumer cannot let the
    // websocket producer accumulate frames without limit. A consumer that
    // falls this far behind on a realtime call is effectively dead; capping
    // here converts an unbounded heap leak into a bounded buffer.
    const events = new AsyncQueue<RealtimeEvent>({
      maxDepth: MAX_REALTIME_EVENT_QUEUE_DEPTH,
    });
    const version = request.sessionConfig.version;
    const transcriptAccumulator = new AgenCRealtimeTranscriptAccumulator();
    socket.on("message", (data, isBinary) => {
      const payload = realtimeWebSocketDataToString(data, isBinary);
      if (payload === null) {
        events.send({
          type: "error",
          message: "unexpected binary realtime websocket event",
        });
        return;
      }
      const event = parseRealtimeWebSocketEvent(payload, version);
      if (event !== null) events.send(transcriptAccumulator.apply(event));
    });
    socket.on("error", (error) => {
      events.send({
        type: "error",
        message: `realtime websocket error: ${errorMessage(error)}`,
      });
      events.close();
    });
    socket.on("close", () => {
      events.close();
    });

    await waitForRealtimeWebSocketOpen(socket);
    const writer = new AgenCRealtimeWebSocketWriter(socket, version);
    try {
      await writer.sendPayload(
        JSON.stringify({
          type: "session.update",
          session: realtimeSessionUpdateToProviderJson(request.sessionConfig),
        }),
      );
    } catch (error) {
      events.close();
      await writer.close().catch(() => {});
      throw error;
    }

    return {
      writer,
      nextEvent: () => events.recv(),
      close: async () => {
        events.close();
        await writer.close();
      },
    };
  }
}

export function realtimeCallMultipartContentType(boundary: string): string {
  return `multipart/form-data; boundary=${boundary}`;
}

function randomRealtimeMultipartBoundary(): string {
  return `agenc-realtime-${randomUUID()}`;
}

export function realtimeCallMultipartBody(
  sdp: string,
  session: JsonObject,
  boundary: string = AGENC_REALTIME_CALL_MULTIPART_BOUNDARY,
): string {
  const encodedSession = JSON.stringify(session);
  assertRealtimeMultipartBoundarySafe(boundary, sdp, "sdp");
  assertRealtimeMultipartBoundarySafe(boundary, encodedSession, "session");
  return (
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="sdp"\r\n' +
    "Content-Type: application/sdp\r\n" +
    "\r\n" +
    sdp +
    "\r\n" +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="session"\r\n' +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    encodedSession +
    "\r\n" +
    `--${boundary}--\r\n`
  );
}

export function realtimeSessionConfigToProviderJson(
  config: RealtimeSessionConfig,
): JsonObject {
  if (config.version === "v1") {
    return {
      type: "quicksilver",
      model: config.model,
      instructions: config.instructions,
      audio: {
        input: {
          format: realtimePcmFormat(),
        },
        output: {
          voice: config.voice,
        },
      },
    };
  }
  if (config.sessionMode === "transcription") {
    return {
      type: "transcription",
      model: config.model,
      audio: {
        input: {
          format: realtimePcmFormat(),
          transcription: realtimeInputTranscription(),
        },
      },
    };
  }
  return {
    type: "realtime",
    model: config.model,
    instructions: config.instructions,
    output_modalities: [providerOutputModality(config.outputModality)],
    audio: {
      input: {
        format: realtimePcmFormat(),
        noise_reduction: { type: "near_field" },
        transcription: realtimeInputTranscription(),
        turn_detection: {
          type: "server_vad",
          interrupt_response: true,
          create_response: true,
          silence_duration_ms: 500,
        },
      },
      output: {
        format: realtimePcmFormat(),
        voice: config.voice,
      },
    },
    tools: [backgroundAgentTool(), silenceTool()],
    tool_choice: "auto",
  };
}

export function realtimeCallSessionConfigToProviderJson(
  config: RealtimeSessionConfig,
): JsonObject {
  // Donor call-create uses session_update_session_json(...), then removes only
  // the provider-generated id; the configured model remains in this body.
  return realtimeSessionConfigToProviderJson(config);
}

function realtimeSessionUpdateToProviderJson(
  config: RealtimeSessionConfig,
): JsonObject {
  const { model: _model, ...session } =
    realtimeSessionConfigToProviderJson(config);
  return session;
}

function realtimeCallUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname;
  if (path === "" || path === "/") {
    url.pathname = "/v1/realtime/calls";
  } else if (path.endsWith("/realtime/calls")) {
    url.pathname = path;
  } else if (path.endsWith("/realtime/")) {
    url.pathname = `${path.slice(0, -1)}/calls`;
  } else if (path.endsWith("/realtime")) {
    url.pathname = `${path}/calls`;
  } else if (path.endsWith("/v1/")) {
    url.pathname = `${path}realtime/calls`;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/realtime/calls`;
  } else {
    url.pathname = `${path.replace(/\/+$/, "")}/realtime/calls`;
  }
  url.search = "";
  return url.toString();
}

export function realtimeWebSocketUrl(
  baseUrl: string,
  sessionConfig: RealtimeSessionConfig,
  providerCallId?: string,
): string {
  const url = new URL(baseUrl);
  normalizeRealtimeWebSocketPath(url);
  switch (url.protocol) {
    case "http:":
      url.protocol = "ws:";
      break;
    case "https:":
      url.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new Error(
        `unsupported realtime api_url scheme: ${url.protocol.slice(0, -1)}`,
      );
  }

  const query = url.searchParams;
  if (providerCallId !== undefined) {
    query.delete("intent");
    query.delete("model");
    query.set("call_id", providerCallId);
    return url.toString();
  }

  query.delete("call_id");
  if (sessionConfig.version === "v1") {
    query.set("intent", "quicksilver");
    query.set("model", sessionConfig.model);
    return url.toString();
  }

  query.delete("intent");
  if (sessionConfig.sessionMode === "conversational") {
    query.set("model", sessionConfig.model);
  } else {
    query.delete("model");
  }
  return url.toString();
}

export function decodeRealtimeCallIdFromLocation(location: string): string {
  const path = location.split("?")[0] ?? location;
  const callId = path
    .split("/")
    .reverse()
    .find((segment) => segment.startsWith("rtc_") && segment.length > 4);
  if (callId === undefined) {
    throw new Error(
      `realtime call Location does not contain a call id: ${location}`,
    );
  }
  return callId;
}

async function decodeRealtimeCallResponse(
  response: AgenCRealtimeHttpResponse,
): Promise<AgenCRealtimeCallResponse> {
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `realtime call request failed: HTTP ${response.status}: ${body}`,
    );
  }
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error("realtime call response missing Location");
  }
  return {
    sdp: body,
    callId: decodeRealtimeCallIdFromLocation(location),
  };
}

function defaultRealtimeFetch(): AgenCRealtimeFetch {
  const fetch = globalThis.fetch as
    | undefined
    | ((
        url: string,
        init: {
          readonly method: "POST";
          readonly headers: Readonly<Record<string, string>>;
          readonly body: string;
        },
      ) => Promise<AgenCRealtimeHttpResponse>);
  if (fetch === undefined) {
    throw new Error("global fetch is unavailable for realtime calls");
  }
  return fetch;
}

function usesBackendRealtimeCallShape(baseUrl: string): boolean {
  return baseUrl.includes("/backend-api");
}

function providerOutputModality(
  outputModality: RealtimeOutputModality,
): "audio" | "text" {
  return outputModality;
}

function realtimePcmFormat(): JsonObject {
  return {
    type: "audio/pcm",
    rate: 24_000,
  };
}

function realtimeInputTranscription(): JsonObject {
  return {
    model: "gpt-4o-mini-transcribe",
  };
}

function backgroundAgentTool(): JsonObject {
  return {
    type: "function",
    name: "background_agent",
    description:
      "Send a user request to the background agent. Use this as the default action. Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. If the background agent is idle, this starts a new task and returns the final result to the user. If the background agent is already working on a task, this sends the request as guidance to steer that previous task. If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user request to delegate to the background agent.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  };
}

function silenceTool(): JsonObject {
  return {
    type: "function",
    name: "remain_silent",
    description:
      "Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. This tool has no user-visible effect.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

class AgenCRealtimeWebSocketWriter implements RealtimeWriter {
  readonly #socket: AgenCRealtimeWebSocketLike;
  readonly #version: RealtimeSessionConfig["version"];
  #closed = false;

  constructor(
    socket: AgenCRealtimeWebSocketLike,
    version: RealtimeSessionConfig["version"],
  ) {
    this.#socket = socket;
    this.#version = version;
  }

  sendAudioFrame(frame: RealtimeAudioFrame): Promise<void> {
    return this.sendPayload(
      JSON.stringify({ type: "input_audio_buffer.append", audio: frame.data }),
    );
  }

  sendConversationItemCreate(text: string): Promise<void> {
    return this.sendPayload(
      JSON.stringify({
        type: "conversation.item.create",
        item:
          this.#version === "v1"
            ? {
                type: "message",
                role: "user",
                content: [{ type: "text", text }],
              }
            : {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
              },
      }),
    );
  }

  sendConversationFunctionCallOutput(
    handoffId: string,
    outputText: string,
  ): Promise<void> {
    if (this.#version === "v1") {
      return this.sendPayload(
        JSON.stringify({
          type: "conversation.handoff.append",
          handoff_id: handoffId,
          output_text: `${AGENT_FINAL_MESSAGE_PREFIX}${outputText}`,
        }),
      );
    }

    return this.sendPayload(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: handoffId,
          output: outputText,
        },
      }),
    );
  }

  sendResponseCreate(): Promise<void> {
    return this.sendPayload(JSON.stringify({ type: "response.create" }));
  }

  sendPayload(payload: string): Promise<void> {
    if (this.#closed) {
      throw new Error("realtime websocket connection is closed");
    }
    return new Promise<void>((resolve, reject) => {
      this.#socket.send(payload, (error) => {
        if (error !== undefined) {
          reject(
            new Error(`failed to send realtime request: ${error.message}`),
          );
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
  }
}

/**
 * Upper bound on retained realtime transcript entries. Mirrors
 * MAX_BUFFERED_AGENT_EVENTS in background-agent-runner.ts: a long-lived
 * realtime call streams unbounded deltas, so the accumulator must drop the
 * oldest entries with a head-splice rather than grow without limit.
 */
export const MAX_REALTIME_TRANSCRIPT_ENTRIES = 1_000;

export class AgenCRealtimeTranscriptAccumulator {
  readonly #entries: MutableRealtimeTranscriptEntry[] = [];
  #lastHandoffEntryCount = 0;
  #newInputEntry = false;
  #newOutputEntry = false;

  /**
   * Drops the oldest entries in-place until `#entries` is within
   * {@link MAX_REALTIME_TRANSCRIPT_ENTRIES}. `#lastHandoffEntryCount` is an
   * absolute index into `#entries`, so it must be shifted by however many
   * leading entries were removed to keep the "since last handoff" slice in
   * `handoff_requested` pointing at the correct boundary (never negative).
   */
  #boundEntries(): void {
    const overflow = this.#entries.length - MAX_REALTIME_TRANSCRIPT_ENTRIES;
    if (overflow <= 0) return;
    this.#entries.splice(0, overflow);
    this.#lastHandoffEntryCount = Math.max(
      0,
      this.#lastHandoffEntryCount - overflow,
    );
  }

  apply(event: RealtimeEvent): RealtimeEvent {
    switch (event.type) {
      case "input_audio_speech_started":
        this.#newInputEntry = true;
        return event;
      case "input_transcript_delta":
        appendTranscriptDelta(
          this.#entries,
          "user",
          event.delta,
          this.#newInputEntry,
        );
        this.#newInputEntry = false;
        this.#boundEntries();
        return event;
      case "output_transcript_delta":
        appendTranscriptDelta(
          this.#entries,
          "assistant",
          event.delta,
          this.#newOutputEntry,
        );
        this.#newOutputEntry = false;
        this.#boundEntries();
        return event;
      case "input_transcript_done":
        applyTranscriptDone(
          this.#entries,
          "user",
          event.text,
          this.#newInputEntry,
        );
        this.#newInputEntry = false;
        this.#boundEntries();
        return event;
      case "output_transcript_done":
        applyTranscriptDone(
          this.#entries,
          "assistant",
          event.text,
          this.#newOutputEntry,
        );
        this.#newOutputEntry = false;
        this.#boundEntries();
        return event;
      case "handoff_requested": {
        appendHandoffInput(this.#entries, event.handoff.inputTranscript);
        this.#boundEntries();
        const activeTranscript = this.#entries.slice(
          this.#lastHandoffEntryCount,
        );
        this.#lastHandoffEntryCount = this.#entries.length;
        this.#newInputEntry = true;
        this.#newOutputEntry = true;
        return {
          type: "handoff_requested",
          handoff: {
            ...event.handoff,
            activeTranscript,
          },
        };
      }
      case "response_created":
        this.#newOutputEntry = true;
        return event;
      default:
        return event;
    }
  }
}

function defaultRealtimeWebSocketFactory(): AgenCRealtimeWebSocketFactory {
  return (url, options) => new WebSocket(url, { headers: options.headers });
}

async function resolveRealtimeHeaders(
  provider: AgenCRealtimeHeadersProvider,
  sessionConfig?: RealtimeSessionConfig,
): Promise<Readonly<Record<string, string>>> {
  if (typeof provider === "function") return provider(sessionConfig);
  return provider;
}

function assertRealtimeMultipartBoundarySafe(
  boundary: string,
  value: string,
  partName: string,
): void {
  if (value.includes(`--${boundary}`)) {
    throw new Error(`realtime multipart ${partName} contains boundary marker`);
  }
}

function normalizeRealtimeWebSocketPath(url: URL): void {
  const path = url.pathname;
  if (path === "" || path === "/") {
    url.pathname = "/v1/realtime";
  } else if (path.endsWith("/realtime")) {
    url.pathname = path;
  } else if (path.endsWith("/realtime/")) {
    url.pathname = path.slice(0, -1);
  } else if (path.endsWith("/v1/")) {
    url.pathname = `${path}realtime`;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/realtime`;
  }
}

function realtimeWebSocketDataToString(
  data: unknown,
  isBinary?: boolean,
): string | null {
  if (typeof data === "string") return data;
  if (isBinary === true) return null;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString("utf8");
  }
  return null;
}

function waitForRealtimeWebSocketOpen(
  socket: AgenCRealtimeWebSocketLike,
): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off?.("open", onOpen);
      socket.off?.("error", onError);
      socket.off?.("close", onClose);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };
    const onOpen = (): void => settle();
    const onError = (error: unknown): void =>
      settle(
        new Error(
          `failed to connect realtime websocket: ${errorMessage(error)}`,
        ),
      );
    const onClose = (code?: number, reason?: unknown): void => {
      const suffix =
        code === undefined
          ? ""
          : `: code=${code}${formatRealtimeCloseReason(reason)}`;
      settle(
        new Error(
          `failed to connect realtime websocket: closed before open${suffix}`,
        ),
      );
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function parseRealtimeWebSocketEvent(
  payload: string,
  version: RealtimeSessionConfig["version"],
): RealtimeEvent | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(payload) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  const messageType = jsonString(parsed.type);
  if (messageType === null) return null;
  return version === "v1"
    ? parseRealtimeWebSocketEventV1(parsed, messageType)
    : parseRealtimeWebSocketEventV2(parsed, messageType);
}

function parseRealtimeWebSocketEventV1(
  parsed: JsonObject,
  messageType: string,
): RealtimeEvent | null {
  switch (messageType) {
    case "session.updated":
      return parseSessionUpdatedEvent(parsed);
    case "conversation.output_audio.delta":
      return parseV1OutputAudioDeltaEvent(parsed);
    case "conversation.input_transcript.delta":
    case "conversation.item.input_audio_transcription.delta":
      return parseTranscriptDeltaEvent(parsed, "input_transcript_delta");
    case "conversation.item.input_audio_transcription.completed":
      return parseTranscriptDoneEvent(
        parsed,
        "transcript",
        "input_transcript_done",
      );
    case "conversation.output_transcript.delta":
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      return parseTranscriptDeltaEvent(parsed, "output_transcript_delta");
    case "response.output_audio_transcript.done":
      return parseTranscriptDoneEvent(
        parsed,
        "transcript",
        "output_transcript_done",
      );
    case "conversation.item.added":
      return parseConversationItemAddedEvent(parsed);
    case "conversation.item.done":
      return parseConversationItemDoneEvent(parsed);
    case "conversation.handoff.requested":
      return parseV1HandoffRequestedEvent(parsed);
    case "error":
      return parseErrorEvent(parsed);
    default:
      return null;
  }
}

function parseRealtimeWebSocketEventV2(
  parsed: JsonObject,
  messageType: string,
): RealtimeEvent | null {
  switch (messageType) {
    case "session.updated":
      return parseSessionUpdatedEvent(parsed);
    case "response.output_audio.delta":
    case "response.audio.delta":
      return parseV2OutputAudioDeltaEvent(parsed);
    case "conversation.item.input_audio_transcription.delta":
      return parseTranscriptDeltaEvent(parsed, "input_transcript_delta");
    case "conversation.item.input_audio_transcription.completed":
      return parseTranscriptDoneEvent(
        parsed,
        "transcript",
        "input_transcript_done",
      );
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      return parseTranscriptDeltaEvent(parsed, "output_transcript_delta");
    case "response.output_text.done":
      return parseTranscriptDoneEvent(parsed, "text", "output_transcript_done");
    case "response.output_audio_transcript.done":
      return parseTranscriptDoneEvent(
        parsed,
        "transcript",
        "output_transcript_done",
      );
    case "input_audio_buffer.speech_started":
      return {
        type: "input_audio_speech_started",
        ...(jsonString(parsed.item_id) !== null
          ? { itemId: jsonString(parsed.item_id) ?? undefined }
          : {}),
      };
    case "conversation.item.added":
    case "conversation.item.created":
      return parseConversationItemAddedEvent(parsed);
    case "conversation.item.done":
      return parseV2ConversationItemDoneEvent(parsed);
    case "response.created":
      return {
        type: "response_created",
        ...(parseResponseEventResponseId(parsed) !== undefined
          ? { responseId: parseResponseEventResponseId(parsed) }
          : {}),
      };
    case "response.cancelled":
      return {
        type: "response_cancelled",
        ...(parseResponseEventResponseId(parsed) !== undefined
          ? { responseId: parseResponseEventResponseId(parsed) }
          : {}),
      };
    case "response.done":
      return {
        type: "response_done",
        ...(parseResponseEventResponseId(parsed) !== undefined
          ? { responseId: parseResponseEventResponseId(parsed) }
          : {}),
      };
    case "error":
      return parseErrorEvent(parsed);
    default:
      return null;
  }
}

function parseSessionUpdatedEvent(parsed: JsonObject): RealtimeEvent | null {
  const session = parsed.session;
  if (!isJsonObject(session)) return null;
  const realtimeSessionId = jsonString(session.id);
  if (realtimeSessionId === null) return null;
  const instructions = jsonString(session.instructions);
  return {
    type: "session_updated",
    realtimeSessionId,
    ...(instructions !== null ? { instructions } : {}),
  };
}

function parseV1OutputAudioDeltaEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const data = jsonString(parsed.delta) ?? jsonString(parsed.data);
  const sampleRate = positiveInteger(parsed.sample_rate);
  const numChannels = positiveInteger(parsed.channels ?? parsed.num_channels);
  if (data === null || sampleRate === null || numChannels === null) return null;
  return {
    type: "audio_out",
    frame: {
      data,
      sampleRate,
      numChannels,
      ...(positiveInteger(parsed.samples_per_channel) !== null
        ? {
            samplesPerChannel:
              positiveInteger(parsed.samples_per_channel) ?? undefined,
          }
        : {}),
    },
  };
}

function parseV2OutputAudioDeltaEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const data = jsonString(parsed.delta);
  if (data === null) return null;
  const itemId = jsonString(parsed.item_id);
  const samplesPerChannel = positiveInteger(parsed.samples_per_channel);
  return {
    type: "audio_out",
    frame: {
      data,
      sampleRate:
        positiveInteger(parsed.sample_rate) ?? DEFAULT_AUDIO_SAMPLE_RATE,
      numChannels:
        positiveInteger(parsed.channels ?? parsed.num_channels) ??
        DEFAULT_AUDIO_CHANNELS,
      ...(samplesPerChannel !== null ? { samplesPerChannel } : {}),
      ...(itemId !== null ? { itemId } : {}),
    },
  };
}

function parseTranscriptDeltaEvent(
  parsed: JsonObject,
  type: "input_transcript_delta" | "output_transcript_delta",
): RealtimeEvent | null {
  const delta = jsonString(parsed.delta);
  return delta === null ? null : { type, delta };
}

function parseTranscriptDoneEvent(
  parsed: JsonObject,
  field: string,
  type: "input_transcript_done" | "output_transcript_done",
): RealtimeEvent | null {
  const text = jsonString(parsed[field]);
  return text === null ? null : { type, text };
}

function parseConversationItemAddedEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const item = parsed.item;
  if (!isJsonObject(item)) return null;
  return {
    type: "conversation_item_added",
    item: item as RealtimeConversationItemPayload,
  };
}

function parseConversationItemDoneEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const item = parsed.item;
  if (!isJsonObject(item)) return null;
  const itemId = jsonString(item.id);
  return itemId === null ? null : { type: "conversation_item_done", itemId };
}

function parseV2ConversationItemDoneEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const item = parsed.item;
  if (!isJsonObject(item)) return null;
  const handoff = parseHandoffRequestedEvent(item);
  if (handoff !== null) return handoff;
  const noop = parseNoopRequestedEvent(item);
  if (noop !== null) return noop;
  const itemId = jsonString(item.id);
  return itemId === null ? null : { type: "conversation_item_done", itemId };
}

function parseV1HandoffRequestedEvent(
  parsed: JsonObject,
): RealtimeEvent | null {
  const handoffId = jsonString(parsed.handoff_id);
  const itemId = jsonString(parsed.item_id);
  const inputTranscript = jsonString(parsed.input_transcript);
  if (handoffId === null || itemId === null || inputTranscript === null) {
    return null;
  }
  return {
    type: "handoff_requested",
    handoff: {
      handoffId,
      itemId,
      inputTranscript,
      activeTranscript: [],
    },
  };
}

function parseHandoffRequestedEvent(item: JsonObject): RealtimeEvent | null {
  if (
    jsonString(item.type) !== "function_call" ||
    jsonString(item.name) !== BACKGROUND_AGENT_TOOL_NAME
  ) {
    return null;
  }
  const callId = jsonString(item.call_id) ?? jsonString(item.id);
  if (callId === null) return null;
  return {
    type: "handoff_requested",
    handoff: {
      handoffId: callId,
      itemId: jsonString(item.id) ?? callId,
      inputTranscript: extractInputTranscript(jsonString(item.arguments) ?? ""),
      activeTranscript: [],
    },
  };
}

function parseNoopRequestedEvent(item: JsonObject): RealtimeEvent | null {
  if (
    jsonString(item.type) !== "function_call" ||
    jsonString(item.name) !== SILENCE_TOOL_NAME
  ) {
    return null;
  }
  const callId = jsonString(item.call_id) ?? jsonString(item.id);
  if (callId === null) return null;
  return {
    type: "noop_requested",
    callId,
    itemId: jsonString(item.id) ?? callId,
  };
}

function parseResponseEventResponseId(parsed: JsonObject): string | undefined {
  const response = parsed.response;
  if (isJsonObject(response)) {
    const responseId = jsonString(response.id);
    if (responseId !== null) return responseId;
  }
  return jsonString(parsed.response_id) ?? undefined;
}

function parseErrorEvent(parsed: JsonObject): RealtimeEvent | null {
  const message = jsonString(parsed.message);
  if (message !== null) return { type: "error", message };
  const error = parsed.error;
  if (isJsonObject(error)) {
    const nestedMessage = jsonString(error.message);
    if (nestedMessage !== null)
      return { type: "error", message: nestedMessage };
  }
  if (error !== undefined)
    return { type: "error", message: JSON.stringify(error) };
  return null;
}

function extractInputTranscript(argumentsText: string): string {
  if (argumentsText.length === 0) return "";
  try {
    const parsed = JSON.parse(argumentsText) as JsonValue;
    if (isJsonObject(parsed)) {
      for (const key of TOOL_ARGUMENT_KEYS) {
        const value = jsonString(parsed[key]);
        if (value !== null && value.trim().length > 0) return value.trim();
      }
    }
  } catch {
    return argumentsText;
  }
  return argumentsText;
}

function appendTranscriptDelta(
  entries: MutableRealtimeTranscriptEntry[],
  role: string,
  delta: string,
  forceNew: boolean,
): void {
  if (delta.length === 0) return;
  const last = entries.at(-1);
  if (!forceNew && last !== undefined && last.role === role) {
    last.text += delta;
    return;
  }
  entries.push({ role, text: delta });
}

function applyTranscriptDone(
  entries: MutableRealtimeTranscriptEntry[],
  role: string,
  text: string,
  forceNew: boolean,
): void {
  if (text.length === 0) return;
  const last = entries.at(-1);
  if (!forceNew && last !== undefined && last.role === role) {
    last.text = text;
    return;
  }
  entries.push({ role, text });
}

function appendHandoffInput(
  entries: MutableRealtimeTranscriptEntry[],
  input: string,
): void {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    containsTranscriptEntry(entries, "user", trimmed)
  ) {
    return;
  }
  entries.push({ role: "user", text: trimmed });
}

function containsTranscriptEntry(
  entries: readonly MutableRealtimeTranscriptEntry[],
  role: string,
  text: string,
): boolean {
  return entries.some(
    (entry) => entry.role === role && entry.text.trim() === text.trim(),
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

function jsonString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function positiveInteger(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRealtimeCloseReason(reason: unknown): string {
  const text = Buffer.isBuffer(reason)
    ? reason.toString("utf8")
    : reason === undefined
      ? ""
      : String(reason);
  return text.length === 0 ? "" : ` reason=${text}`;
}
