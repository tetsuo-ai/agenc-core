/**
 * AgenC realtime WebRTC call negotiation helpers.
 *
 * The daemon method surface owns only the HTTP SDP call-create leg here. The
 * returned call id is handed to the injected realtime transport connector so it
 * can join the sideband stream without coupling this file to a websocket stack.
 */

import type { JsonObject, JsonValue } from "./protocol/index.js";
import type {
  RealtimeOutputModality,
  RealtimeSessionConfig,
  RealtimeSessionMode,
  RealtimeVoice,
} from "../conversation/realtime/conversation.js";

export const AGENC_REALTIME_CALL_MULTIPART_BOUNDARY =
  "codex-realtime-call-boundary" as const; // branding-scan: allow wire-defined realtime multipart boundary
export const AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE =
  `multipart/form-data; boundary=${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}` as const;

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

export interface AgenCRealtimeCallClientOptions {
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: AgenCRealtimeFetch;
}

export class AgenCRealtimeCallClient {
  readonly #baseUrl: string;
  readonly #defaultHeaders: Readonly<Record<string, string>>;
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
    const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
      method: "POST",
      headers: {
        ...this.#defaultHeaders,
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
    const session = realtimeSessionConfigToProviderJson(sessionConfig);
    if (usesBackendRealtimeCallShape(this.#baseUrl)) {
      const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
        method: "POST",
        headers: {
          ...this.#defaultHeaders,
          ...extraHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sdp, session }),
      });
      return decodeRealtimeCallResponse(response);
    }

    const response = await this.#fetch(realtimeCallUrl(this.#baseUrl), {
      method: "POST",
      headers: {
        ...this.#defaultHeaders,
        ...extraHeaders,
        "content-type": AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE,
      },
      body: realtimeCallMultipartBody(sdp, session),
    });
    return decodeRealtimeCallResponse(response);
  }
}

export function realtimeCallMultipartBody(
  sdp: string,
  session: JsonObject,
): string {
  const encodedSession = JSON.stringify(session);
  return (
    `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="sdp"\r\n' +
    "Content-Type: application/sdp\r\n" +
    "\r\n" +
    sdp +
    "\r\n" +
    `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="session"\r\n' +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    encodedSession +
    "\r\n" +
    `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}--\r\n`
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

export function realtimeCallUrl(baseUrl: string): string {
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

export function realtimeVoiceToJsonValue(voice: RealtimeVoice): JsonValue {
  return voice;
}

export function realtimeSessionModeToJsonValue(
  sessionMode: RealtimeSessionMode,
): JsonValue {
  return sessionMode;
}
