import { EventEmitter } from "node:events";
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
import {
  AgenCRealtimeRpcService,
  REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC,
  TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
} from "./realtime.js";
import {
  AGENC_REALTIME_CALL_MULTIPART_BOUNDARY,
  AgenCRealtimeCallClient,
  AgenCRealtimeWebSocketTransportConnector,
  type AgenCRealtimeWebSocketLike,
  decodeRealtimeCallIdFromLocation,
  realtimeCallSessionConfigToProviderJson,
  realtimeCallMultipartContentType,
  realtimeCallMultipartBody,
  realtimeSessionConfigToProviderJson,
  realtimeWebSocketUrl,
} from "./realtime-transport.js";

describe("AgenC daemon realtime JSON-RPC surface", () => {
  test("fails realtime start closed without a durable execution admission contract", async () => {
    const realtime = new AgenCRealtimeRpcService();
    const binding = createRealtimeBinding();
    realtime.registerThread(binding.thread);
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: createAgentManagerStub(),
      realtime,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "unadmitted-realtime",
        method: "thread/realtime/start",
        params: { threadId: "thread_1", outputModality: "audio" },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: REALTIME_EXECUTION_ADMISSION_DIAGNOSTIC,
        data: { code: "EXECUTION_ADMISSION_REQUIRED" },
      },
    });
    expect(binding.transportRequests).toHaveLength(0);
  });

  test("dispatches realtime start, append, stop, and listVoices", async () => {
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    const binding = createRealtimeBinding({
      callClient: createCallClient({
        body: "answer-sdp",
        location: "/v1/realtime/calls/rtc_dispatch?source=unit",
      }),
    });
    realtime.registerThread(binding.thread);

    const notifications: JsonObject[] = [];
    const ordering: string[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: createAgentManagerStub(),
      realtime,
    });
    const connection = dispatcher.createConnection({
      sendNotification: (notification) => {
        ordering.push(`notification:${String(notification.method)}`);
        notifications.push(notification);
      },
    });
    await initialize(connection);

    const missingOutputModality = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-start",
      method: "thread/realtime/start",
      params: { threadId: "thread_1" },
    });
    expect(missingOutputModality).toMatchObject({
      error: {
        code: -32602,
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    const invalidVoice = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-voice",
      method: "thread/realtime/start",
      params: {
        threadId: "thread_1",
        outputModality: "audio",
        voice: "bad",
      },
    });
    expect(invalidVoice).toMatchObject({
      error: {
        code: -32602,
        data: { code: "INVALID_ARGUMENT" },
      },
    });

    const start = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      method: "thread/realtime/start",
      params: {
        threadId: "thread_1",
        transport: { type: "webrtc", sdp: "offer-sdp" },
        realtimeSessionId: "rt_thread_1",
        outputModality: "audio",
        voice: "marin",
      },
    });
    ordering.push("response:start");

    expect(start).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      result: {},
    });
    await waitFor(
      () => binding.transportRequests.length === 1,
      "provider transport request",
    );
    expect(binding.transportRequests[0]).toMatchObject({
      callerSdp: "offer-sdp",
      providerCallId: "rtc_dispatch",
      providerSdp: "answer-sdp",
      requestedSessionId: "rt_thread_1",
    });
    binding.events.send({
      type: "session_updated",
      realtimeSessionId: "rt_provider_1",
    });
    await waitFor(
      () =>
        notifications.some(
          (notification) => notification.method === "thread/realtime/started",
        ) &&
        notifications.some(
          (notification) => notification.method === "thread/realtime/sdp",
        ),
      "post-start notifications",
    );
    expect(ordering.indexOf("response:start")).toBeLessThan(
      ordering.indexOf("notification:thread/realtime/started"),
    );
    expect(ordering.indexOf("response:start")).toBeLessThan(
      ordering.indexOf("notification:thread/realtime/sdp"),
    );
    expect(
      ordering.indexOf("notification:thread/realtime/started"),
    ).toBeLessThan(ordering.indexOf("notification:thread/realtime/sdp"));
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/started",
          params: {
            threadId: "thread_1",
            realtimeSessionId: "rt_provider_1",
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
      id: "audio-null-metadata",
      method: "thread/realtime/appendAudio",
      params: {
        threadId: "thread_1",
        audio: {
          data: "BBBB",
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: null,
          itemId: null,
        },
      },
    });

    const missingAudio = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-audio",
      method: "thread/realtime/appendAudio",
      params: { threadId: "thread_1" },
    });
    expect(missingAudio).toMatchObject({
      error: {
        code: -32602,
        data: { code: "INVALID_ARGUMENT" },
      },
    });

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "text",
      method: "thread/realtime/appendText",
      params: { threadId: "thread_1", text: "continue" },
    });

    await waitFor(() => binding.writer.audioFrames.length === 2, "audio sent");
    await waitFor(() => binding.writer.textItems.length === 1, "text sent");
    expect(binding.writer.audioFrames[0]).toMatchObject({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: 2,
      itemId: "audio_item_1",
    });
    expect(binding.writer.audioFrames[1]).toEqual({
      data: "BBBB",
      sampleRate: 24000,
      numChannels: 1,
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
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    const binding = createRealtimeBinding();
    realtime.registerThread(binding.thread);
    const notifications: JsonObject[] = [];

    await realtime.start(
      {
        threadId: "thread_1",
        outputModality: "audio",
      },
      { sendNotification: (notification) => notifications.push(notification) },
    );

    binding.events.send({
      type: "session_updated",
      realtimeSessionId: "rt_provider_fanout",
    });
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
    binding.events.send({ type: "output_transcript_delta", delta: "lo" });
    binding.events.send({ type: "input_transcript_done", text: "hello" });
    binding.events.send({ type: "output_transcript_done", text: "hello" });
    binding.events.send({
      type: "conversation_item_added",
      item: { type: "message", role: "assistant" },
    });
    binding.events.send({
      type: "handoff_requested",
      handoff: {
        handoffId: "handoff_1",
        itemId: "item_1",
        inputTranscript: "please continue",
        activeTranscript: [{ role: "assistant", text: "working" }],
      },
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
          method: "thread/realtime/started",
          params: {
            threadId: "thread_1",
            realtimeSessionId: "rt_provider_fanout",
            version: "v2",
          },
        },
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
          method: "thread/realtime/transcript/delta",
          params: { threadId: "thread_1", role: "assistant", delta: "lo" },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "thread/realtime/transcript/done",
          params: { threadId: "thread_1", role: "user", text: "hello" },
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
          method: "thread/realtime/itemAdded",
          params: {
            threadId: "thread_1",
            item: {
              type: "handoff_request",
              handoffId: "handoff_1",
              itemId: "item_1",
              inputTranscript: "please continue",
              activeTranscript: [{ role: "assistant", text: "working" }],
            },
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

  test("cleans up started realtime conversation when notification delivery fails", async () => {
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    const binding = createRealtimeBinding();
    realtime.registerThread(binding.thread);

    await expect(
      realtime.start(
        {
          threadId: "thread_1",
          outputModality: "audio",
        },
        {
          sendNotification: () => {
            throw new Error("client disconnected");
          },
        },
      ),
    ).resolves.toEqual({});
    binding.events.send({
      type: "session_updated",
      realtimeSessionId: "rt_provider_disconnect",
    });
    await waitFor(
      () => binding.events.isClosed,
      "post-start notification failure cleanup",
    );
    await expect(binding.thread.conversation.runningState()).resolves.toBe(
      undefined,
    );
    expect(binding.events.isClosed).toBe(true);
  });

  test("surfaces async WebRTC startup failures as realtime error notifications", async () => {
    const realtime = new AgenCRealtimeRpcService({
      unadmittedStartOverride: TEST_ONLY_ALLOW_UNADMITTED_REALTIME_START,
    });
    const binding = createRealtimeBinding({
      callClient: new AgenCRealtimeCallClient({
        baseUrl: "https://api.openai.com/v1",
        fetch: async () =>
          fakeResponse({
            status: 500,
            body: "provider unavailable",
            location: "/v1/realtime/calls/rtc_failed",
          }),
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

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        method: "thread/realtime/start",
        params: {
          threadId: "thread_1",
          transport: { type: "webrtc", sdp: "offer-sdp" },
          outputModality: "audio",
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      result: {},
    });
    await waitFor(
      () =>
        notifications.some(
          (notification) =>
            notification.method === "thread/realtime/error" &&
            String((notification.params as JsonObject).message).includes(
              "HTTP 500: provider unavailable",
            ),
        ),
      "async startup error notification",
    );
    expect(binding.transportRequests).toHaveLength(0);
  });

  test("builds realtime call transport requests for provider and backend APIs", async () => {
    const providerCalls: FetchCall[] = [];
    const providerClient = new AgenCRealtimeCallClient({
      baseUrl: "https://api.openai.com/v1",
      defaultHeaders: async (config) => ({
        authorization: `Bearer ${config?.sessionId ?? "missing"}`,
      }),
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
          authorization: "Bearer rt_hidden",
        },
      },
    });
    const providerContentType = providerCalls[0]!.init.headers["content-type"];
    expect(providerContentType).toMatch(
      /^multipart\/form-data; boundary=agenc-realtime-/,
    );
    const providerBoundary = providerContentType.replace(
      "multipart/form-data; boundary=",
      "",
    );
    expect(providerBoundary).not.toBe(AGENC_REALTIME_CALL_MULTIPART_BOUNDARY);
    expect(providerCalls[0]!.init.body).toContain(`--${providerBoundary}`);
    expect(providerCalls[0]!.init.body).toContain('name="sdp"');
    expect(providerCalls[0]!.init.body).toContain('name="session"');
    expect(providerCalls[0]!.init.body).toContain('"model":"gpt-realtime-1.5"');
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
        model: "gpt-realtime-1.5",
        audio: { output: { voice: "marin" } },
      },
    });
    expect(backendBody.session as JsonObject).not.toHaveProperty("id");
    expect(
      realtimeCallSessionConfigToProviderJson(
        buildRealtimeSessionConfig({
          conversationId: "thread_1",
          outputModality: "audio",
          version: "v1",
          voice: "cove",
        }),
      ),
    ).toMatchObject({ type: "quicksilver", model: "gpt-realtime-1.5" });
    expect(
      realtimeCallSessionConfigToProviderJson(
        buildRealtimeSessionConfig({
          conversationId: "thread_1",
          outputModality: "text",
          sessionMode: "transcription",
        }),
      ),
    ).toMatchObject({ type: "transcription", model: "gpt-realtime-1.5" });

    const failingClient = new AgenCRealtimeCallClient({
      baseUrl: "https://api.openai.com/v1",
      fetch: async () =>
        fakeResponse({
          status: 500,
          body: "provider unavailable",
          location: "/v1/realtime/calls/rtc_failed",
        }),
    });
    await expect(failingClient.create("offer-sdp")).rejects.toThrow(
      "HTTP 500: provider unavailable",
    );

    const missingLocationClient = new AgenCRealtimeCallClient({
      baseUrl: "https://api.openai.com/v1",
      fetch: async () =>
        fakeResponse({
          body: "answer-without-location",
          location: null,
        }),
    });
    await expect(
      missingLocationClient.createWithSession("offer-sdp", session),
    ).rejects.toThrow("realtime call response missing Location");

    expect(realtimeCallMultipartContentType("boundary_1")).toBe(
      "multipart/form-data; boundary=boundary_1",
    );
    expect(realtimeCallMultipartBody("sdp", { type: "realtime" })).toBe(
      `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="sdp"\r\n' +
        "Content-Type: application/sdp\r\n" +
        "\r\n" +
        "sdp\r\n" +
        `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="session"\r\n' +
        "Content-Type: application/json\r\n" +
        "\r\n" +
        '{"type":"realtime"}\r\n' +
        `--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}--\r\n`,
    );
    expect(() =>
      realtimeCallMultipartBody(
        `sdp\r\n--${AGENC_REALTIME_CALL_MULTIPART_BOUNDARY}`,
        { type: "realtime" },
      ),
    ).toThrow("realtime multipart sdp contains boundary marker");
    expect(
      realtimeSessionConfigToProviderJson(
        buildRealtimeSessionConfig({
          conversationId: "thread_1",
          outputModality: "audio",
          version: "v1",
          voice: "cove",
        }),
      ),
    ).toEqual({
      type: "quicksilver",
      model: "gpt-realtime-1.5",
      instructions: expect.any(String),
      audio: {
        input: { format: { type: "audio/pcm", rate: 24_000 } },
        output: { voice: "cove" },
      },
    });
    expect(
      realtimeSessionConfigToProviderJson(
        buildRealtimeSessionConfig({
          conversationId: "thread_1",
          outputModality: "text",
          sessionMode: "transcription",
        }),
      ),
    ).toEqual({
      type: "transcription",
      model: "gpt-realtime-1.5",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
      },
    });
    expect(
      decodeRealtimeCallIdFromLocation(
        "https://api.openai.com/v1/realtime/calls/rtc_path?x=1",
      ),
    ).toBe("rtc_path");
    expect(() => decodeRealtimeCallIdFromLocation("/calls/not-a-call")).toThrow(
      "does not contain a call id",
    );
  });

  test("builds websocket URLs and drives the provider websocket transport", async () => {
    const v1Session = buildRealtimeSessionConfig({
      conversationId: "thread_ws_v1",
      outputModality: "audio",
      version: "v1",
      voice: "cove",
    });
    const v2Session = buildRealtimeSessionConfig({
      conversationId: "thread_ws_v2",
      outputModality: "audio",
      voice: "marin",
      prompt: "Talk to the user.",
    });
    const transcriptionSession = buildRealtimeSessionConfig({
      conversationId: "thread_ws_tx",
      outputModality: "text",
      sessionMode: "transcription",
    });
    expect(realtimeWebSocketUrl("https://api.openai.com/v1", v1Session)).toBe(
      "wss://api.openai.com/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5",
    );
    expect(
      realtimeWebSocketUrl(
        "https://127.0.0.1:9443/v1/realtime?foo=bar",
        v2Session,
      ),
    ).toBe("wss://127.0.0.1:9443/v1/realtime?foo=bar&model=gpt-realtime-1.5");
    expect(
      realtimeWebSocketUrl("https://127.0.0.1:9443", transcriptionSession),
    ).toBe("wss://127.0.0.1:9443/v1/realtime");
    expect(
      realtimeWebSocketUrl("https://api.openai.com/v1", v2Session, "rtc_test"),
    ).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_test");

    let socket: FakeRealtimeWebSocket | undefined;
    const connections: Array<{
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    const connector = new AgenCRealtimeWebSocketTransportConnector({
      baseUrl: "https://api.openai.com/v1",
      defaultHeaders: async (config) => ({
        authorization: `Bearer ${config?.sessionId ?? "missing"}`,
      }),
      websocketFactory: (url, options) => {
        connections.push({ url, headers: options.headers });
        socket = new FakeRealtimeWebSocket();
        return socket;
      },
    });

    const pendingConnection = connector.connect({
      transport: { type: "websocket" },
      sessionConfig: v2Session,
      requestedSessionId: "thread_ws_v2",
    });
    await waitFor(() => socket !== undefined, "websocket factory");
    socket!.open();
    const connection = await pendingConnection;
    expect(connections).toEqual([
      {
        url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5",
        headers: {
          authorization: "Bearer thread_ws_v2",
          "x-session-id": "thread_ws_v2",
        },
      },
    ]);

    const sessionUpdate = JSON.parse(socket!.sent[0] ?? "{}") as JsonObject;
    expect(sessionUpdate).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "Talk to the user.",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            noise_reduction: { type: "near_field" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: "marin",
          },
        },
      },
    });
    expect(sessionUpdate.session as JsonObject).not.toHaveProperty("model");

    await connection.writer.sendAudioFrame({
      data: "AAAA",
      sampleRate: 24_000,
      numChannels: 1,
    });
    await connection.writer.sendConversationItemCreate("hello");
    await connection.writer.sendConversationFunctionCallOutput(
      "call_1",
      "done",
    );
    await connection.writer.sendResponseCreate();
    expect(socket!.sent.slice(1).map((payload) => JSON.parse(payload))).toEqual(
      [
        { type: "input_audio_buffer.append", audio: "AAAA" },
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "call_1",
            output: "done",
          },
        },
        { type: "response.create" },
      ],
    );

    socket!.message({
      type: "session.updated",
      session: { id: "rt_ws", instructions: "Ready." },
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "session_updated",
      realtimeSessionId: "rt_ws",
      instructions: "Ready.",
    });
    socket!.message({
      type: "response.output_audio.delta",
      delta: "BBBB",
      item_id: "item_audio",
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "audio_out",
      frame: {
        data: "BBBB",
        sampleRate: 24_000,
        numChannels: 1,
        itemId: "item_audio",
      },
    });
    socket!.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "please ",
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "input_transcript_delta",
      delta: "please ",
    });
    socket!.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "please compile",
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "input_transcript_done",
      text: "please compile",
    });
    socket!.message({
      type: "response.created",
      response: { id: "response_1" },
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "response_created",
      responseId: "response_1",
    });
    socket!.message({
      type: "response.output_text.delta",
      delta: "On it.",
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "output_transcript_delta",
      delta: "On it.",
    });
    socket!.message({
      type: "conversation.item.done",
      item: {
        id: "item_call",
        type: "function_call",
        name: "background_agent",
        call_id: "call_1",
        arguments: "",
      },
    });
    await expect(connection.nextEvent()).resolves.toEqual({
      type: "handoff_requested",
      handoff: {
        handoffId: "call_1",
        itemId: "item_call",
        inputTranscript: "",
        activeTranscript: [
          { role: "user", text: "please compile" },
          { role: "assistant", text: "On it." },
        ],
      },
    });

    await connection.close();
    await expect(connection.nextEvent()).resolves.toBeNull();

    const pendingClosedConnection = connector.connect({
      transport: { type: "websocket" },
      sessionConfig: v2Session,
      requestedSessionId: "thread_ws_v2_closed",
    });
    await waitFor(
      () => socket !== undefined && socket.readyState === 0,
      "pre-open websocket factory",
    );
    socket!.close();
    await expect(pendingClosedConnection).rejects.toThrow("closed before open");

    const pendingSendFailure = connector.connect({
      transport: { type: "websocket" },
      sessionConfig: v2Session,
      requestedSessionId: "thread_ws_v2_send_failure",
    });
    await waitFor(
      () => socket !== undefined && socket.readyState === 0,
      "send-failure websocket factory",
    );
    socket!.failNextSend = new Error("socket write failed");
    socket!.open();
    await expect(pendingSendFailure).rejects.toThrow("socket write failed");
    expect(socket!.readyState).toBe(3);
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

class FakeRealtimeWebSocket
  extends EventEmitter
  implements AgenCRealtimeWebSocketLike
{
  readyState = 0;
  failNextSend: Error | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(payload: JsonObject): void {
    this.emit("message", JSON.stringify(payload), false);
  }

  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(payload);
    if (this.failNextSend !== null) {
      const error = this.failNextSend;
      this.failNextSend = null;
      callback?.(error);
      return;
    }
    callback?.();
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
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
  readonly location: string | null;
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
