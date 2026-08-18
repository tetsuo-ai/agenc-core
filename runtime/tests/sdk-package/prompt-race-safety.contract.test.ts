import { describe, expect, it } from "vitest";

import {
  AgencCapabilityUnavailableError,
  AgencDuplicateSubmissionIncompleteError,
  AgencPromptRunInProgressError,
  createAgencClient,
  type AgencClient,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencPromptEvent,
  type AgencTransport,
  type JsonObject,
} from "../../../packages/agenc-sdk/src/index";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function success<Method extends AgencDaemonMethod>(
  request: AgencDaemonRequest<Method>,
  result: unknown,
): AgencDaemonResponse<Method> {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result,
  } as AgencDaemonResponse<Method>;
}

class PromptTransport implements AgencTransport {
  readonly requests: AgencDaemonRequest[] = [];
  readonly sends: Array<{
    readonly request: AgencDaemonRequest<"message.send">;
    readonly response: Deferred<AgencDaemonResponse<"message.send">>;
  }> = [];
  client?: AgencClient;
  initializeVersion = "1.2.0";
  initializeFailures = 0;
  duplicateIncomplete = false;

  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    this.requests.push(request as AgencDaemonRequest);
    if (request.method === "initialize") {
      if (this.initializeFailures > 0) {
        this.initializeFailures -= 1;
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "unsupported protocol",
            data: {
              code: "PROTOCOL_VERSION_UNSUPPORTED",
              serverVersion: this.initializeVersion,
            },
          },
        } as AgencDaemonResponse<Method>;
      }
      return success(request, {
        type: "initialized",
        protocolVersion: this.initializeVersion,
        protocol: { version: this.initializeVersion },
        capabilities: {
          "daemon.methods": {
            "session.transcript.v2": this.initializeVersion === "1.2.0",
          },
        },
      });
    }
    if (request.method === "session.attach") {
      return success(request, {
        attachmentId: "attachment_1",
        sessionId: String((request.params as JsonObject).sessionId),
      });
    }
    if (request.method === "message.send") {
      if (this.duplicateIncomplete) {
        return success(request, {
          messageId: String((request.params as JsonObject).clientMessageId),
          acceptedAt: "2026-08-17T00:00:00.000Z",
          disposition: "duplicate",
          duplicateState: "incomplete",
          turnId: "turn_crashed",
        });
      }
      const response = deferred<AgencDaemonResponse<"message.send">>();
      this.sends.push({
        request: request as AgencDaemonRequest<"message.send">,
        response,
      });
      return (await response.promise) as AgencDaemonResponse<Method>;
    }
    if (request.method === "session.cancelTurn") {
      return success(request, {
        sessionId: String((request.params as JsonObject).sessionId),
        cancelled: true,
      });
    }
    if (request.method === "session.transcript.v2") {
      return success(request, {
        schemaVersion: 2,
        sessionId: "session_1",
        runId: "run_1",
        historyEpoch: "history:run_1:initial",
        asOfSequence: 0,
        messages: [],
      });
    }
    throw new Error(`unexpected method: ${request.method}`);
  }

  emit(message: JsonObject): void {
    this.client?.dispatchNotification(message);
  }
}

async function initializedClient(
  transport: PromptTransport,
): Promise<AgencClient> {
  const client = createAgencClient({
    transport,
    clientId: "race-test-client",
  });
  transport.client = client;
  await client.initialize();
  return client;
}

function userMessage(clientMessageId: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.session_event",
    params: {
      sessionId: "session_1",
      eventId: `user_${clientMessageId}`,
      event: {
        id: `user_${clientMessageId}`,
        type: "user_message",
        payload: { message: clientMessageId, messageId: clientMessageId },
      },
    },
  };
}

function turnStarted(turnId: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.agent_status",
    params: {
      sessionId: "session_1",
      eventId: `started_${turnId}`,
      status: "running",
      runStatus: "running",
      turnId,
    },
  };
}

function terminal(turnId: string, message?: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.agent_status",
    params: {
      sessionId: "session_1",
      eventId: `terminal_${turnId}_${message ?? "none"}`,
      status: "idle",
      runStatus: "completed",
      turnId,
      ...(message !== undefined ? { message } : {}),
    },
  };
}

function text(turnId: string, delta: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.message_chunk",
    params: {
      sessionId: "session_1",
      eventId: `delta_${turnId}_${Math.random().toString(36)}`,
      turnId,
      delta,
    },
  };
}

function committed(turnId: string, value: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.session_event",
    params: {
      sessionId: "session_1",
      eventId: `committed_${turnId}`,
      turnId,
      event: {
        id: `committed_${turnId}`,
        type: "agent_message",
        payload: { message: value },
      },
    },
  };
}

async function waitForSend(
  transport: PromptTransport,
  index: number,
): Promise<PromptTransport["sends"][number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const send = transport.sends[index];
    if (send !== undefined) return send;
    await Promise.resolve();
  }
  throw new Error(`message.send ${String(index)} was not observed`);
}

function resolveSend(
  send: PromptTransport["sends"][number],
  turnId: string,
): void {
  const clientMessageId = String(
    (send.request.params as JsonObject).clientMessageId,
  );
  send.response.resolve(
    success(send.request, {
      messageId: clientMessageId,
      acceptedAt: "2026-08-17T00:00:00.000Z",
      disposition: "started",
      turnId,
      terminal: { code: 0 },
    }),
  );
}

describe("agenc-sdk prompt race safety", () => {
  it.each(["1.0.0", "1.1.0"])(
    "downgrades capability discovery to an older %s daemon",
    async (version) => {
      const transport = new PromptTransport();
      transport.initializeVersion = version;
      transport.initializeFailures = 1;
      const client = await initializedClient(transport);

      const initializes = transport.requests.filter(
        (request) => request.method === "initialize",
      );
      expect(initializes).toHaveLength(2);
      expect(initializes.map((request) => request.params)).toEqual([
        expect.objectContaining({ protocol: { version: "1.2.0" } }),
        expect.objectContaining({ protocol: { version } }),
      ]);
      expect(client.negotiatedProtocolVersion).toBe(version);
      expect(client.serverProtocolVersion).toBe(version);
      expect(client.serverCapabilities).toBeDefined();
    },
  );

  it("recognizes an older daemon that accepts a higher-minor initialize", async () => {
    const transport = new PromptTransport();
    transport.initializeVersion = "1.1.0";
    const client = await initializedClient(transport);

    expect(
      transport.requests.filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(client.negotiatedProtocolVersion).toBe("1.1.0");
    expect(client.serverProtocolVersion).toBe("1.1.0");
  });

  it("reserves synchronously, binds on its durable user marker, and ignores an older terminal", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);

    const runA = client.runPrompt("session_1", "A", {
      clientMessageId: "message_A",
      includeUsage: false,
    });
    expect(() =>
      client.runPrompt("session_1", "B-too-soon", {
        clientMessageId: "message_B_early",
      }),
    ).toThrow(AgencPromptRunInProgressError);

    const sendA = await waitForSend(transport, 0);
    transport.emit(userMessage("message_A"));
    transport.emit(turnStarted("turn_A"));
    transport.emit(terminal("turn_A", "answer A"));
    resolveSend(sendA, "turn_A");
    await expect(runA.result()).resolves.toMatchObject({
      finalMessage: "answer A",
    });

    const runB = client.runPrompt("session_1", "B", {
      clientMessageId: "message_B",
      includeUsage: false,
    });
    const events: AgencPromptEvent[] = [];
    const consumeB = (async () => {
      for await (const event of runB) events.push(event);
    })();
    const sendB = await waitForSend(transport, 1);

    transport.emit(terminal("turn_A", "stale answer A"));
    const stillPending = await Promise.race([
      runB.result().then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), 10)),
    ]);
    expect(stillPending).toBe(true);

    transport.emit(userMessage("message_B"));
    transport.emit(turnStarted("turn_B"));
    transport.emit(text("turn_B", "ha"));
    transport.emit(text("turn_B", "ha"));
    transport.emit(committed("turn_B", "haha"));
    transport.emit(terminal("turn_B"));
    resolveSend(sendB, "turn_B");

    await consumeB;
    await expect(runB.result()).resolves.toMatchObject({
      finalMessage: "haha",
    });
    expect(
      events
        .filter(
          (event): event is Extract<AgencPromptEvent, { type: "text" }> =>
            event.type === "text",
        )
        .map((event) => event.delta),
    ).toEqual(["ha", "ha"]);
    expect(
      events.filter((event) => event.type === "message_committed"),
    ).toEqual([expect.objectContaining({ text: "haha" })]);
  });

  it("never sends or cancels when an AbortSignal is already aborted", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const controller = new AbortController();
    controller.abort("never dispatch");

    const run = client.runPrompt("session_1", "do not send", {
      clientMessageId: "message_aborted",
      signal: controller.signal,
    });
    await expect(run.accepted).rejects.toMatchObject({ name: "AbortError" });
    expect(
      transport.requests.filter(
        (request) =>
          request.method === "message.send" ||
          request.method === "session.cancelTurn",
      ),
    ).toEqual([]);
  });

  it("defers post-dispatch abort until its own turn id is bound", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const controller = new AbortController();
    const run = client.runPrompt("session_1", "cancel me", {
      clientMessageId: "message_cancel",
      signal: controller.signal,
      includeUsage: false,
    });
    const send = await waitForSend(transport, 0);

    controller.abort("stop this turn");
    expect(
      transport.requests.filter(
        (request) => request.method === "session.cancelTurn",
      ),
    ).toEqual([]);

    transport.emit(userMessage("message_cancel"));
    expect(
      transport.requests.filter(
        (request) => request.method === "session.cancelTurn",
      ),
    ).toEqual([]);
    transport.emit(turnStarted("turn_cancel"));
    await Promise.resolve();
    expect(
      transport.requests.find(
        (request) => request.method === "session.cancelTurn",
      )?.params,
    ).toMatchObject({
      sessionId: "session_1",
      expectedTurnId: "turn_cancel",
      reason: "stop this turn",
    });

    transport.emit(terminal("turn_cancel"));
    resolveSend(send, "turn_cancel");
    await run.result();
  });

  it("never issues an unscoped prompt cancellation on a legacy daemon", async () => {
    const transport = new PromptTransport();
    transport.initializeVersion = "1.1.0";
    transport.initializeFailures = 1;
    const client = await initializedClient(transport);
    const controller = new AbortController();
    const run = client.runPrompt("session_1", "legacy cancel", {
      clientMessageId: "message_legacy_cancel",
      signal: controller.signal,
      includeUsage: false,
    });
    const send = await waitForSend(transport, 0);

    controller.abort("legacy stop");
    expect(
      transport.requests.filter(
        (request) => request.method === "session.cancelTurn",
      ),
    ).toHaveLength(0);
    transport.emit(userMessage("message_legacy_cancel"));
    transport.emit(turnStarted("turn_legacy_cancel"));
    await Promise.resolve();
    expect(
      transport.requests.filter(
        (request) => request.method === "session.cancelTurn",
      ),
    ).toEqual([]);

    transport.emit(terminal("turn_legacy_cancel"));
    resolveSend(send, "turn_legacy_cancel");
    await run.result();
  });

  it("fails closed before send when strict admission is unavailable", async () => {
    const transport = new PromptTransport();
    transport.initializeVersion = "1.1.0";
    transport.initializeFailures = 1;
    const client = await initializedClient(transport);
    const run = client.runPrompt("session_1", "must reject overlap", {
      clientMessageId: "message_strict_legacy",
      ifBusy: "reject",
    });

    await expect(run.accepted).rejects.toBeInstanceOf(
      AgencCapabilityUnavailableError,
    );
    await expect(run.result()).rejects.toBeInstanceOf(
      AgencCapabilityUnavailableError,
    );
    expect(
      transport.requests.filter(
        (request) =>
          request.method === "session.attach" ||
          request.method === "message.send",
      ),
    ).toEqual([]);
  });

  it("fails closed when a duplicate has no durable terminal proof", async () => {
    const transport = new PromptTransport();
    transport.duplicateIncomplete = true;
    const client = await initializedClient(transport);
    const run = client.runPrompt("session_1", "retry", {
      clientMessageId: "message_crashed",
      includeUsage: false,
    });

    await expect(run.accepted).rejects.toBeInstanceOf(
      AgencDuplicateSubmissionIncompleteError,
    );
    await expect(run.result()).rejects.toBeInstanceOf(
      AgencDuplicateSubmissionIncompleteError,
    );
  });

  it("uses the identity-bearing send result when the terminal notification is lost", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const run = client.runPrompt("session_1", "finish from result", {
      clientMessageId: "message_terminal_fallback",
      includeUsage: false,
    });
    const send = await waitForSend(transport, 0);

    transport.emit(userMessage("message_terminal_fallback"));
    transport.emit(turnStarted("turn_terminal_fallback"));
    transport.emit(text("turn_terminal_fallback", "answer"));
    transport.emit(committed("turn_terminal_fallback", "answer"));
    resolveSend(send, "turn_terminal_fallback");

    await expect(run.result()).resolves.toMatchObject({
      stopReason: "completed",
      finalMessage: "answer",
    });
  });
});
