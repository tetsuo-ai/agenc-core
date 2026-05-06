import { describe, expect, test } from "vitest";
import { AsyncQueue } from "../utils/async-queue.js";
import {
  buildRealtimeSessionConfig,
  RealtimeConversationManager,
  type RealtimeAudioFrame,
  type RealtimeEvent,
  type RealtimeTransportRequest,
  type RealtimeWriter,
} from "../conversation/realtime/conversation.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import { AgenCRealtimeRpcService } from "./realtime.js";
import {
  AGENC_REALTIME_CALL_MULTIPART_BOUNDARY,
  AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE,
  AgenCRealtimeCallClient,
  decodeRealtimeCallIdFromLocation,
  realtimeCallMultipartBody,
} from "./realtime-transport.js";

describe("AgenC daemon realtime JSON-RPC surface", () => {
  test("dispatches realtime start, append, stop, and listVoices", async () => {
    const realtime = new AgenCRealtimeRpcService();
    const binding = createRealtimeBinding({
      callClient: createCallClient({
        body: "answer-sdp",
        location: "/v1/realtime/calls/rtc_dispatch?source=unit",
      }),
    });
    realtime.registerThread(binding.thread);

    const notifications: JsonObject[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: createAgentManagerStub(),
      realtime,
    });
    const connection = dispatcher.createConnection({
      sendNotification: (notification) => notifications.push(notification),
    });
    await initialize(connection);

    const start = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      method: "thread/realtime/start",
      params: {
        threadId: "thread_1",
        transport: { type: "webrtc", sdp: "offer-sdp" },
        realtimeSessionId: "rt_thread_1",
        outputModality: "audio",
        version: "v2",
        voice: "marin",
      },
    });

    expect(start).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      result: { callId: "rtc_dispatch" },
    });
    expect(binding.transportRequests[0]).toMatchObject({
      callerSdp: "offer-sdp",
      providerCallId: "rtc_dispatch",
      providerSdp: "answer-sdp",
      requestedSessionId: "rt_thread_1",
    });
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/started",
          params: {
            threadId: "thread_1",
            realtimeSessionId: "rt_thread_1",
            version: "v2",
          },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/sdp",
          params: { threadId: "thread_1", sdp: "answer-sdp" },
        },
      ]),
    );

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "audio",
      method: "thread/realtime/appendAudio",
      params: {
        threadId: "thread_1",
        audio: {
          data: "AAAA",
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 2,
          itemId: "audio_item_1",
        },
      },
    });
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "text",
      method: "thread/realtime/appendText",
      params: { threadId: "thread_1", text: "continue" },
    });

    await waitFor(() => binding.writer.audioFrames.length === 1, "audio sent");
    await waitFor(() => binding.writer.textItems.length === 1, "text sent");
    expect(binding.writer.audioFrames[0]).toMatchObject({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: 2,
      itemId: "audio_item_1",
    });
    expect(binding.writer.textItems).toEqual(["[USER] continue"]);

    const voices = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "voices",
      method: "thread/realtime/listVoices",
    });
    expect(voices).toMatchObject({
      result: {
        voices: {
          defaultV1: "cove",
          defaultV2: "marin",
          v1: expect.arrayContaining(["juniper", "cove"]),
          v2: expect.arrayContaining(["alloy", "marin"]),
        },
      },
    });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "stop",
      method: "thread/realtime/stop",
      params: { threadId: "thread_1" },
    });
    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === "thread/realtime/closed" &&
            (notification.params as JsonObject).reason === "requested",
        ),
      "closed notification",
    );
  });

  test("fans realtime conversation events out as server notifications", async () => {
    const realtime = new AgenCRealtimeRpcService();
    const binding = createRealtimeBinding();
    realtime.registerThread(binding.thread);
    const notifications: JsonObject[] = [];

    await realtime.start(
      {
        threadId: "thread_1",
        outputModality: "audio",
        version: "v2",
      },
      { sendNotification: (notification) => notifications.push(notification) },
    );

    binding.events.send({
      type: "audio_out",
      frame: {
        data: "BBBB",
        sampleRate: 24000,
        numChannels: 1,
        samplesPerChannel: 2,
      },
    });
    binding.events.send({ type: "input_transcript_delta", delta: "hel" });
    binding.events.send({ type: "output_transcript_done", text: "hello" });
    binding.events.send({
      type: "conversation_item_added",
      item: { type: "message", role: "assistant" },
    });
    binding.events.send({ type: "error", message: "provider failed" });
    binding.events.close();

    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === "thread/realtime/closed" &&
            (notification.params as JsonObject).reason === "error",
        ),
      "fanout closed",
    );
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/outputAudio/delta",
          params: {
            threadId: "thread_1",
            audio: {
              data: "BBBB",
              sampleRate: 24000,
              numChannels: 1,
              samplesPerChannel: 2,
            },
          },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/transcript/delta",
          params: { threadId: "thread_1", role: "user", delta: "hel" },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/transcript/done",
          params: { threadId: "thread_1", role: "assistant", text: "hello" },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/itemAdded",
          params: {
            threadId: "thread_1",
            item: { type: "message", role: "assistant" },
          },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/error",
          params: { threadId: "thread_1", message: "provider failed" },
        },
      ]),
    );
  });

  test("builds realtime call transport requests for provider and backend APIs", async () => {
    const providerCalls: FetchCall[] = [];
    const providerClient = new AgenCRealtimeCallClient({
      baseUrl: "https://api.openai.com/v1",
      fetch: async (url, init) => {
        providerCalls.push({ url, init });
        return fakeResponse({
          body: "provider-answer",
          location: "/v1/realtime/calls/rtc_provider?trace=1",
        });
      },
    });
    const session = buildRealtimeSessionConfig({
      conversationId: "thread_1",
      realtimeSessionId: "rt_hidden",
      outputModality: "audio",
      prompt: "Talk to the user.",
      voice: "marin",
    });

    await expect(
      providerClient.createWithSession("offer-sdp", session),
    ).resolves.toEqual({
      callId: "rtc_provider",
      sdp: "provider-answer",
    });
    expect(providerCalls[0]).toMatchObject({
      url: "https://api.openai.com/v1/realtime/calls",
      init: {
        headers: {
          "content-type": AGENC_REALTIME_CALL_MULTIPART_CONTENT_TYPE,
        },
      },
    });
    expect(providerCalls[0]!.init.body).toContain(
      `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}`,
    );
    expect(providerCalls[0]!.init.body).toContain('name="sdp"');
    expect(providerCalls[0]!.init.body).toContain('name="session"');
    expect(providerCalls[0]!.init.body).not.toContain("rt_hidden");

    const backendCalls: FetchCall[] = [];
    const backendClient = new AgenCRealtimeCallClient({
      baseUrl: "http://127.0.0.1:18888/backend-api",
      fetch: async (url, init) => {
        backendCalls.push({ url, init });
        return fakeResponse({
          body: "backend-answer",
          location: "/backend-api/realtime/calls/rtc_backend",
        });
      },
    });

    await expect(
      backendClient.createWithSession("offer-sdp", session),
    ).resolves.toEqual({
      callId: "rtc_backend",
      sdp: "backend-answer",
    });
    expect(backendCalls[0]).toMatchObject({
      url: "http://127.0.0.1:18888/backend-api/realtime/calls",
      init: {
        headers: {
          "content-type": "application/json",
        },
      },
    });
    const backendBody = JSON.parse(backendCalls[0]!.init.body) as JsonObject;
    expect(backendBody).toMatchObject({
      sdp: "offer-sdp",
      session: {
        type: "realtime",
        audio: { output: { voice: "marin" } },
      },
    });
    expect(backendBody.session as JsonObject).not.toHaveProperty("id");

    expect(
      realtimeCallMultipartBody("sdp", { type: "realtime" }).endsWith(
        `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}--\r\n`,
      ),
    ).toBe(true);
    expect(
      decodeRealtimeCallIdFromLocation(
        "https://api.openai.com/v1/realtime/calls/rtc_path?x=1",
      ),
    ).toBe("rtc_path");
    expect(() => decodeRealtimeCallIdFromLocation("/calls/not-a-call")).toThrow(
      "does not contain a call id",
    );
  });
});

interface FetchCall {
  readonly url: string;
  readonly init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

function createRealtimeBinding(
  options: {
    readonly callClient?: AgenCRealtimeCallClient;
  } = {},
) {
  const events = new AsyncQueue<RealtimeEvent>();
  const transportRequests: RealtimeTransportRequest[] = [];
  const writer = createRealtimeWriter();
  const conversation = new RealtimeConversationManager();
  return {
    events,
    transportRequests,
    writer,
    thread: {
      threadId: "thread_1",
      conversation,
      callClient: options.callClient,
      connectTransport: (request: RealtimeTransportRequest) => {
        transportRequests.push(request);
        return {
          writer,
          providerSdp: request.providerSdp,
          nextEvent: () => events.recv(),
          close: () => events.close(),
        };
      },
    },
  };
}

function createRealtimeWriter(): RealtimeWriter & {
  readonly audioFrames: RealtimeAudioFrame[];
  readonly textItems: string[];
} {
  const audioFrames: RealtimeAudioFrame[] = [];
  const textItems: string[] = [];
  return {
    audioFrames,
    textItems,
    sendAudioFrame: (frame) => {
      audioFrames.push(frame);
    },
    sendConversationItemCreate: (text) => {
      textItems.push(text);
    },
    sendConversationFunctionCallOutput: () => {},
    sendResponseCreate: () => {},
    sendPayload: () => {},
  };
}

function createCallClient(options: {
  readonly body: string;
  readonly location: string;
}): AgenCRealtimeCallClient {
  return new AgenCRealtimeCallClient({
    baseUrl: "https://api.openai.com/v1",
    fetch: async () => fakeResponse(options),
  });
}

function fakeResponse(options: {
  readonly status?: number;
  readonly body: string;
  readonly location: string;
}) {
  return {
    status: options.status ?? 201,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "location" ? options.location : null,
    },
    text: async () => options.body,
  };
}

function createAgentManagerStub() {
  const unused = async () => {
    throw new Error("agent manager was not expected in realtime tests");
  };
  return {
    approveTool: unused,
    attachAgent: unused,
    cancelTool: unused,
    createAgent: unused,
    denyTool: unused,
    getAgentLogs: unused,
    listAgents: unused,
    respondToElicitation: unused,
    stopAgent: unused,
    streamAgentMessage: unused,
  };
}

async function initialize(connection: {
  dispatch(message: JsonObject): Promise<JsonObject>;
}): Promise<void> {
  await connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: "initialize",
    method: "initialize",
    params: { protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION },
  });
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
