import { describe, expect, test, vi } from "vitest";
import { AsyncQueue } from "../../utils/async-queue.js";
import {
  buildRealtimeSessionConfig,
  buildRealtimeSessionConfigFromSession,
  DEFAULT_REALTIME_MODEL,
  RealtimeConversationManager,
  audioDurationMs,
  builtinRealtimeVoices,
  prefixRealtimeV2Text,
  resolveRealtimeTransportSelection,
  validateRealtimeVoice,
  wrapRealtimeDelegationInput,
  type RealtimeAudioFrame,
  type RealtimeEvent,
  type RealtimeSessionConfig,
  type RealtimeTransportConnection,
  type RealtimeTransportRequest,
  type RealtimeWriter,
} from "./conversation.js";

class FakeWriter implements RealtimeWriter {
  readonly audioFrames: RealtimeAudioFrame[] = [];
  readonly itemTexts: string[] = [];
  readonly functionOutputs: Array<{ handoffId: string; outputText: string }> = [];
  readonly payloads: string[] = [];
  responseCreateCount = 0;
  responseCreateError: Error | null = null;
  audioGate: Promise<void> | null = null;

  async sendAudioFrame(frame: RealtimeAudioFrame): Promise<void> {
    this.audioFrames.push(frame);
    if (this.audioGate !== null) await this.audioGate;
  }

  sendConversationItemCreate(text: string): void {
    this.itemTexts.push(text);
  }

  sendConversationFunctionCallOutput(
    handoffId: string,
    outputText: string,
  ): void {
    this.functionOutputs.push({ handoffId, outputText });
  }

  sendResponseCreate(): void {
    this.responseCreateCount += 1;
    if (this.responseCreateError !== null) throw this.responseCreateError;
  }

  sendPayload(payload: string): void {
    this.payloads.push(payload);
  }
}

class FakeConnection implements RealtimeTransportConnection {
  readonly events = new AsyncQueue<RealtimeEvent>();
  closeCount = 0;

  constructor(readonly writer: FakeWriter, readonly providerSdp?: string) {}

  nextEvent(): Promise<RealtimeEvent | null> {
    return this.events.recv();
  }

  close(): void {
    this.closeCount += 1;
    this.events.close();
  }

  emit(event: RealtimeEvent): boolean {
    return this.events.send(event);
  }
}

class HeldReadConnection implements RealtimeTransportConnection {
  readonly writer = new FakeWriter();
  closeCount = 0;

  nextEvent(): Promise<RealtimeEvent | null> {
    return new Promise<RealtimeEvent | null>(() => undefined);
  }

  close(): void {
    this.closeCount += 1;
  }
}

class ClosedReadConnection implements RealtimeTransportConnection {
  readonly writer = new FakeWriter();
  closeCount = 0;

  nextEvent(): Promise<RealtimeEvent | null> {
    return Promise.resolve(null);
  }

  close(): void {
    this.closeCount += 1;
  }
}

class RejectingReadConnection implements RealtimeTransportConnection {
  readonly writer = new FakeWriter();
  closeCount = 0;

  nextEvent(): Promise<RealtimeEvent | null> {
    return Promise.reject(new Error("read failed"));
  }

  close(): void {
    this.closeCount += 1;
  }
}

class RejectingCloseConnection extends FakeConnection {
  close(): void {
    this.closeCount += 1;
    this.events.close();
    throw new Error("close failed");
  }
}

function sessionConfig(
  version: RealtimeSessionConfig["version"] = "v2",
): RealtimeSessionConfig {
  return buildRealtimeSessionConfig({
    conversationId: "thread-1",
    outputModality: "audio",
    version,
    startupContext: "<startup_context>hi</startup_context>",
    backendPrompt: "backend",
  });
}

async function startManager(
  version: RealtimeSessionConfig["version"] = "v2",
  opts: {
    readonly routeRealtimeTextInput?: (text: string) => void;
    readonly writer?: FakeWriter;
    readonly providerSdp?: string;
  } = {},
): Promise<{
  manager: RealtimeConversationManager;
  writer: FakeWriter;
  connection: FakeConnection;
  active: Awaited<ReturnType<RealtimeConversationManager["start"]>>["active"];
}> {
  const manager = new RealtimeConversationManager();
  const writer = opts.writer ?? new FakeWriter();
  const connection = new FakeConnection(writer, opts.providerSdp);
  const output = await manager.start({
    sessionConfig: sessionConfig(version),
    ...(opts.routeRealtimeTextInput !== undefined
      ? { routeRealtimeTextInput: opts.routeRealtimeTextInput }
      : {}),
    connectTransport: () => connection,
  });
  return { manager, writer, connection, active: output.active };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: Error | null = null;
  for (let index = 0; index < 80; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError ?? new Error("assertion did not pass");
}

async function expectCompletesWithin<T>(
  promise: Promise<T>,
  timeoutMs = 500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("operation did not complete"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

describe("RealtimeConversationManager", () => {
  test("starts, reports running state, and shuts down", async () => {
    const { manager, connection, active } = await startManager("v2", {
      providerSdp: "answer-sdp",
    });

    expect(manager.phase.value).toBe("active");
    await expect(manager.runningState()).resolves.toMatchObject({
      active,
      phase: "active",
    });
    await expect(manager.isRunningV2()).resolves.toBe(true);

    await manager.shutdown();

    expect(connection.closeCount).toBe(1);
    expect(manager.phase.value).toBe("idle");
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("starting a new session closes the previous connection", async () => {
    const manager = new RealtimeConversationManager();
    const first = new FakeConnection(new FakeWriter());
    const second = new FakeConnection(new FakeWriter());

    await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => first,
    });
    const secondStart = await manager.start({
      sessionConfig: { ...sessionConfig("v2"), sessionId: "thread-2" },
      connectTransport: () => second,
    });

    expect(first.closeCount).toBe(1);
    await expect(manager.runningState()).resolves.toMatchObject({
      active: secondStart.active,
    });
  });

  test("transport connection failure leaves the manager idle", async () => {
    const manager = new RealtimeConversationManager();

    await expect(
      manager.start({
        sessionConfig: sessionConfig("v2"),
        connectTransport: () => {
          throw new Error("connect failed");
        },
      }),
    ).rejects.toThrow("connect failed");

    expect(manager.phase.value).toBe("idle");
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("immediate transport EOF during start does not publish a stale session", async () => {
    const manager = new RealtimeConversationManager();
    const connection = new ClosedReadConnection();
    const started = await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => connection,
    });

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });

    expect(connection.closeCount).toBe(1);
    await expect(manager.registerFanout(started.active, () => undefined)).resolves.toBe(
      false,
    );
    expect(manager.phase.value).toBe("idle");
  });

  test("immediate transport read errors during start do not publish a stale session", async () => {
    const manager = new RealtimeConversationManager();
    const connection = new RejectingReadConnection();
    await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => connection,
    });

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });

    expect(connection.closeCount).toBe(1);
    expect(manager.phase.value).toBe("idle");
  });

  test("overlapping starts serialize connection and close the replaced transport", async () => {
    const manager = new RealtimeConversationManager();
    const first = new FakeConnection(new FakeWriter());
    const second = new FakeConnection(new FakeWriter());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const connectTransport = vi.fn(async () => {
      if (connectTransport.mock.calls.length === 1) {
        await firstGate;
        return first;
      }
      return second;
    });

    const firstStart = manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport,
    });
    await waitFor(() => {
      expect(connectTransport).toHaveBeenCalledTimes(1);
    });
    const secondStart = manager.start({
      sessionConfig: { ...sessionConfig("v2"), sessionId: "thread-2" },
      connectTransport,
    });
    await Promise.resolve();
    expect(connectTransport).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstStart;
    const secondStarted = await secondStart;

    expect(connectTransport).toHaveBeenCalledTimes(2);
    expect(first.closeCount).toBe(1);
    await expect(manager.runningState()).resolves.toMatchObject({
      active: secondStarted.active,
    });

    await manager.shutdown();
  });

  test("close failures still finalize explicit shutdown", async () => {
    const manager = new RealtimeConversationManager();
    const connection = new RejectingCloseConnection(new FakeWriter());
    await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => connection,
    });

    await expect(manager.shutdown()).resolves.toBeUndefined();

    expect(connection.closeCount).toBe(1);
    expect(manager.phase.value).toBe("idle");
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("close failures still finalize server-side termination", async () => {
    const manager = new RealtimeConversationManager();
    const connection = new RejectingCloseConnection(new FakeWriter());
    await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => connection,
    });

    connection.emit({ type: "error", message: "stream failed" });

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
    expect(connection.closeCount).toBe(1);
    expect(manager.phase.value).toBe("idle");
  });

  test("rejects text and audio when no session is active", async () => {
    const manager = new RealtimeConversationManager();

    await expect(manager.textIn("hello")).rejects.toThrow("conversation is not running");
    await expect(
      manager.audioIn({ data: "", sampleRate: 24_000, numChannels: 1 }),
    ).rejects.toThrow("conversation is not running");
  });

  test("prefixes V2 text input and backend handoff output", async () => {
    const { manager, writer, connection } = await startManager("v2");

    await manager.textIn("hello");
    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "h1",
        itemId: "item-1",
        inputTranscript: "delegate",
        activeTranscript: [],
      },
    });
    await waitFor(async () => {
      await expect(manager.activeHandoffId()).resolves.toBe("h1");
    });
    await manager.handoffOut("result");

    await waitFor(() => {
      expect(writer.itemTexts).toContain("[USER] hello");
      expect(writer.itemTexts).toContain("[BACKEND] result");
    });
  });

  test("sends V1 handoff output as function-call output", async () => {
    const { manager, writer, connection } = await startManager("v1");

    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "v1-handoff",
        itemId: "item-1",
        inputTranscript: "delegate",
        activeTranscript: [],
      },
    });
    await waitFor(async () => {
      await expect(manager.activeHandoffId()).resolves.toBe("v1-handoff");
    });
    await manager.handoffOut("done");

    await waitFor(() => {
      expect(writer.functionOutputs).toEqual([
        { handoffId: "v1-handoff", outputText: "done" },
      ]);
    });
  });

  test("handles V2 final handoff, steering, and queued response create", async () => {
    const { manager, writer, connection } = await startManager("v2");

    connection.emit({ type: "response_created", responseId: "r1" });
    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "h1",
        itemId: "item-1",
        inputTranscript: "delegate",
        activeTranscript: [],
      },
    });
    await waitFor(async () => {
      await expect(manager.activeHandoffId()).resolves.toBe("h1");
    });

    await manager.handoffOut("progress");
    await manager.handoffComplete();
    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "h2",
        itemId: "item-2",
        inputTranscript: "steer",
        activeTranscript: [],
      },
    });

    await waitFor(() => {
      expect(writer.functionOutputs).toContainEqual({
        handoffId: "h1",
        outputText:
          "Background agent finished. Use the preceding [BACKEND] messages as the result.",
      });
      expect(writer.functionOutputs).toContainEqual({
        handoffId: "h2",
        outputText:
          "This was sent to steer the previous background agent task.",
      });
    });
    expect(writer.responseCreateCount).toBe(0);

    connection.emit({ type: "response_done", responseId: "r1" });
    await waitFor(() => {
      expect(writer.responseCreateCount).toBe(1);
    });
  });

  test("response-create failures emit one error event", async () => {
    const { manager, writer, connection, active } = await startManager("v2");
    const events: RealtimeEvent[] = [];
    await manager.registerFanout(active, async (stream) => {
      for await (const event of stream) events.push(event);
    });

    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "h1",
        itemId: "item-1",
        inputTranscript: "delegate",
        activeTranscript: [],
      },
    });
    await waitFor(async () => {
      await expect(manager.activeHandoffId()).resolves.toBe("h1");
    });

    writer.responseCreateError = new Error("create failed");
    await manager.handoffOut("done");
    await manager.handoffComplete();

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", message: "create failed" },
    ]);
  });

  test("acknowledges realtime no-op and truncates matching output audio", async () => {
    const { writer, connection } = await startManager("v2");

    connection.emit({
      type: "audio_out",
      frame: {
        data: Buffer.alloc(48_000).toString("base64"),
        sampleRate: 24_000,
        numChannels: 1,
        itemId: "audio-1",
      },
    });
    connection.emit({ type: "input_audio_speech_started", itemId: "audio-1" });
    connection.emit({
      type: "noop_requested",
      callId: "noop-1",
      itemId: "item-1",
    });

    await waitFor(() => {
      expect(writer.payloads).toHaveLength(1);
      expect(JSON.parse(writer.payloads[0] ?? "{}")).toMatchObject({
        type: "conversation.item.truncate",
        item_id: "audio-1",
        audio_end_ms: 1_000,
      });
      expect(writer.functionOutputs).toContainEqual({
        handoffId: "noop-1",
        outputText: "",
      });
    });
  });

  test("keeps output audio state when speech starts for a different item", async () => {
    const { writer, connection } = await startManager("v2");

    connection.emit({
      type: "audio_out",
      frame: {
        data: Buffer.alloc(48_000).toString("base64"),
        sampleRate: 24_000,
        numChannels: 1,
        itemId: "audio-1",
      },
    });
    connection.emit({ type: "input_audio_speech_started", itemId: "audio-2" });
    connection.emit({ type: "input_audio_speech_started", itemId: "audio-1" });

    await waitFor(() => {
      expect(writer.payloads).toHaveLength(1);
      expect(JSON.parse(writer.payloads[0] ?? "{}")).toMatchObject({
        type: "conversation.item.truncate",
        item_id: "audio-1",
        audio_end_ms: 1_000,
      });
    });
  });

  test("routes delegation text and escapes XML-sensitive characters", async () => {
    const routed: string[] = [];
    const { connection } = await startManager("v2", {
      routeRealtimeTextInput: (text) => {
        routed.push(text);
      },
    });

    connection.emit({
      type: "handoff_requested",
      handoff: {
        handoffId: "h1",
        itemId: "item-1",
        inputTranscript: "use <tag> & more",
        activeTranscript: [{ role: "user", text: "delta > text" }],
      },
    });

    await waitFor(() => {
      expect(routed[0]).toContain("<input>use &lt;tag&gt; &amp; more</input>");
      expect(routed[0]).toContain(
        "<transcript_delta>user: delta &gt; text</transcript_delta>",
      );
    });
  });

  test("fanout receives events and an error event ends the session", async () => {
    const { manager, connection, active } = await startManager("v2");
    const events: RealtimeEvent[] = [];
    await manager.registerFanout(active, async (stream) => {
      for await (const event of stream) events.push(event);
    });

    connection.emit({ type: "error", message: "stream failed" });

    await waitFor(async () => {
      expect(events).toContainEqual({ type: "error", message: "stream failed" });
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
  });

  test("server-side termination publishes closing before idle", async () => {
    const { manager, connection } = await startManager("v2");
    const phases: string[] = [];
    const unsubscribe = manager.phase.subscribe((phase) => {
      phases.push(phase);
    });

    connection.emit({ type: "error", message: "stream failed" });

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
    unsubscribe();

    expect(phases).toEqual(expect.arrayContaining(["active", "closing", "idle"]));
    expect(phases.indexOf("closing")).toBeLessThan(phases.lastIndexOf("idle"));
  });

  test("closed fanout and active finish close only the matching session", async () => {
    const { manager, connection, active } = await startManager("v2");
    await manager.registerFanout(active, () => undefined);

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
    expect(connection.closeCount).toBe(1);

    const second = await startManager("v2");
    await second.manager.finishIfActive({ ...active, id: active.id + 99 });
    await expect(second.manager.runningState()).resolves.toBeDefined();
    await second.manager.finishIfActive(second.active);
    await expect(second.manager.runningState()).resolves.toBeUndefined();
  });

  test("rejects duplicate fanout registration for an active session", async () => {
    const { manager, active } = await startManager("v2");

    await expect(
      manager.registerFanout(
        active,
        () => new Promise<void>(() => undefined),
      ),
    ).resolves.toBe(true);
    await expect(manager.registerFanout(active, () => undefined)).resolves.toBe(
      false,
    );

    await expectCompletesWithin(manager.shutdown());
  });

  test("pending transport reads unblock when shutdown closes the connection", async () => {
    const { manager, connection } = await startManager("v2");
    await manager.shutdown();

    expect(connection.closeCount).toBe(1);
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("shutdown returns with a non-returning fanout consumer", async () => {
    const { manager, connection, active } = await startManager("v2");
    await manager.registerFanout(
      active,
      () => new Promise<void>(() => undefined),
    );

    await expectCompletesWithin(manager.shutdown());

    expect(connection.closeCount).toBe(1);
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("shutdown returns when the transport read remains pending after close", async () => {
    const manager = new RealtimeConversationManager();
    const connection = new HeldReadConnection();
    await manager.start({
      sessionConfig: sessionConfig("v2"),
      connectTransport: () => connection,
    });

    await expectCompletesWithin(manager.shutdown());

    expect(connection.closeCount).toBe(1);
    await expect(manager.runningState()).resolves.toBeUndefined();
  });

  test("audio and output event queues stay bounded under slow consumers", async () => {
    let releaseAudio!: () => void;
    const writer = new FakeWriter();
    writer.audioGate = new Promise((resolve) => {
      releaseAudio = resolve;
    });
    const { manager, connection, active } = await startManager("v2", { writer });
    await manager.registerFanout(active, async (stream) => {
      for await (const event of stream) {
        if (event.type === "error") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    for (let index = 0; index < 700; index += 1) {
      await manager.audioIn({
        data: "",
        sampleRate: 24_000,
        numChannels: 1,
        samplesPerChannel: 1,
      });
    }
    for (let index = 0; index < 300; index += 1) {
      connection.emit({ type: "input_transcript_delta", delta: String(index) });
    }

    releaseAudio();
    await manager.shutdown();
    await expect(manager.runningState()).resolves.toBeUndefined();
    expect(writer.audioFrames.length).toBeLessThanOrEqual(700);
  });

  test("output event overflow closes an active session when no fanout is attached", async () => {
    const { manager, connection } = await startManager("v2");

    for (let index = 0; index < 300; index += 1) {
      connection.emit({
        type: "input_transcript_delta",
        delta: `delta-${index}`,
      });
    }

    await waitFor(async () => {
      await expect(manager.runningState()).resolves.toBeUndefined();
    });
    expect(connection.closeCount).toBe(1);
  });
});

describe("realtime session config and helpers", () => {
  test("builds defaults, composes prompt and startup context, and validates text output", () => {
    const config = buildRealtimeSessionConfig({
      conversationId: "thread-1",
      outputModality: "audio",
      prompt: "prompt",
      startupContext: "context",
    });

    expect(config).toMatchObject({
      instructions: "prompt\n\ncontext",
      model: DEFAULT_REALTIME_MODEL,
      sessionId: "thread-1",
      version: "v2",
      voice: "marin",
    });
    expect(() =>
      buildRealtimeSessionConfig({
        conversationId: "thread-1",
        outputModality: "text",
        version: "v1",
      }),
    ).toThrow("text realtime output modality requires realtime v2");
  });

  test("config backend prompt overrides caller prompt and null prompt clears without config", () => {
    const override = buildRealtimeSessionConfig({
      conversationId: "thread-1",
      outputModality: "audio",
      prompt: "caller prompt",
      backendPrompt: "backend prompt",
      startupContext: "context",
    });
    const configWithNullCaller = buildRealtimeSessionConfig({
      conversationId: "thread-1",
      outputModality: "audio",
      prompt: null,
      backendPrompt: "backend prompt",
      startupContext: "context",
    });
    const caller = buildRealtimeSessionConfig({
      conversationId: "thread-1",
      outputModality: "audio",
      prompt: "caller prompt",
      backendPrompt: "   ",
      startupContext: "context",
    });
    const nullWithoutConfig = buildRealtimeSessionConfig({
      conversationId: "thread-1",
      outputModality: "audio",
      prompt: null,
      startupContext: "context",
    });

    expect(override.instructions).toBe("backend prompt\n\ncontext");
    expect(override.instructions).not.toContain("caller prompt");
    expect(configWithNullCaller.instructions).toBe("backend prompt\n\ncontext");
    expect(caller.instructions).toBe("caller prompt\n\ncontext");
    expect(nullWithoutConfig.instructions).toBe("context");
  });

  test("validates voices and resolves transport selection", () => {
    expect(builtinRealtimeVoices().defaultV1).toBe("cove");
    expect(builtinRealtimeVoices().defaultV2).toBe("marin");
    expect(() => validateRealtimeVoice("v1", "marin")).toThrow(
      "supported voices",
    );
    expect(resolveRealtimeTransportSelection()).toEqual({ type: "websocket" });
    expect(resolveRealtimeTransportSelection({ type: "webrtc", sdp: "offer" })).toEqual({
      type: "webrtc",
      sdp: "offer",
    });
  });

  test("prefixing, delegation wrapping, and audio duration match source behavior", () => {
    expect(prefixRealtimeV2Text("hello", "[USER] ")).toBe("[USER] hello");
    expect(prefixRealtimeV2Text("[USER] hello", "[USER] ")).toBe("[USER] hello");
    expect(wrapRealtimeDelegationInput("<x>", "a & b")).toContain(
      "<input>&lt;x&gt;</input>",
    );
    expect(
      audioDurationMs({
        data: Buffer.alloc(96_000).toString("base64"),
        sampleRate: 24_000,
        numChannels: 2,
      }),
    ).toBe(1_000);
    expect(
      audioDurationMs({
        data: Buffer.alloc(96_000).toString("base64"),
        sampleRate: 0,
        numChannels: 2,
      }),
    ).toBe(0);
    expect(
      audioDurationMs({
        data: Buffer.alloc(96_000).toString("base64"),
        sampleRate: Number.NaN,
        numChannels: 2,
      }),
    ).toBe(0);
    expect(
      audioDurationMs({
        data: Buffer.alloc(96_000).toString("base64"),
        sampleRate: 24_000,
        numChannels: 2,
        samplesPerChannel: -1,
      }),
    ).toBe(0);
    expect(
      audioDurationMs({
        data: "!!!",
        sampleRate: 24_000,
        numChannels: 1,
      }),
    ).toBe(0);
  });

  test("passes transport request shape through start", async () => {
    const manager = new RealtimeConversationManager();
    const writer = new FakeWriter();
    const connection = new FakeConnection(writer, "answer");
    const connectTransport = vi.fn((request: RealtimeTransportRequest) => {
      expect(request.transport).toEqual({ type: "webrtc", sdp: "offer" });
      expect(request.callerSdp).toBe("offer");
      expect(request.requestedSessionId).toBe("thread-1");
      return connection;
    });

    const started = await manager.start({
      sessionConfig: sessionConfig("v2"),
      transport: { type: "webrtc", sdp: "offer" },
      connectTransport,
    });

    expect(started.providerSdp).toBe("answer");
    expect(connectTransport).toHaveBeenCalledTimes(1);
  });

  test("builds session config from live session history", async () => {
    const config = await buildRealtimeSessionConfigFromSession({
      session: {
        conversationId: "thread-from-session",
        state: {
          unsafePeek: () => ({
            sessionConfiguration: { cwd: "/repo" },
            history: [
              { role: "user", content: "session ask" },
              { role: "assistant", content: "session answer" },
            ],
          }),
        },
      },
      outputModality: "audio",
      prompt: "system prompt",
      startupContextOptions: {
        userRoot: null,
        readDirectory: () => null,
      },
    });

    expect(config.sessionId).toBe("thread-from-session");
    expect(config.instructions).toContain("system prompt");
    expect(config.instructions).toContain("session ask");
    expect(config.instructions).toContain("session answer");
  });

  test("loads realtime backend prompt from session config unless option is explicit", async () => {
    const session = {
      conversationId: "thread-from-session",
      config: {
        cwd: "/repo",
        experimental_realtime_ws_backend_prompt: "session config prompt",
      },
      snapshotHistoryMessages: () => [],
    };
    const configOverride = await buildRealtimeSessionConfigFromSession({
      session,
      outputModality: "audio",
      prompt: "caller prompt",
      startupContext: "context",
    });
    const explicitNull = await buildRealtimeSessionConfigFromSession({
      session,
      outputModality: "audio",
      prompt: "caller prompt",
      backendPrompt: null,
      startupContext: "context",
    });
    const explicitBlank = await buildRealtimeSessionConfigFromSession({
      session,
      outputModality: "audio",
      prompt: "caller prompt",
      backendPrompt: "   ",
      startupContext: "context",
    });

    expect(configOverride.instructions).toBe("session config prompt\n\ncontext");
    expect(explicitNull.instructions).toBe("caller prompt\n\ncontext");
    expect(explicitBlank.instructions).toBe("caller prompt\n\ncontext");
  });
});
