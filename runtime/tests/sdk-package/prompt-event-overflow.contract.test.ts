/**
 * Socket-backed prompt runs (`AgencClient.runPrompt`) must never discard
 * buffered events silently (#2090). The subprocess transport shares the same
 * queue; its coverage lives in `subprocess-transport.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  createAgencClient,
  MAX_BUFFERED_PROMPT_EVENTS,
  type AgencClient,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencPromptEvent,
  type AgencTransport,
  type JsonObject,
} from "../../../packages/agenc-sdk/src/index";

function success<Method extends AgencDaemonMethod>(
  request: AgencDaemonRequest<Method>,
  result: unknown,
): AgencDaemonResponse<Method> {
  return { jsonrpc: "2.0", id: request.id, result } as AgencDaemonResponse<Method>;
}

class PromptTransport implements AgencTransport {
  client?: AgencClient;
  readonly sends: Array<{
    readonly request: AgencDaemonRequest<"message.send">;
    resolve(): void;
  }> = [];

  async request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>> {
    if (request.method === "initialize") {
      return success(request, {
        type: "initialized",
        protocolVersion: "1.13.0",
        protocol: { version: "1.13.0" },
        capabilities: { "daemon.methods": { "session.transcript.v2": true } },
      });
    }
    if (request.method === "session.attach") {
      return success(request, {
        attachmentId: "attachment_1",
        sessionId: String((request.params as JsonObject).sessionId),
      });
    }
    if (request.method === "message.send") {
      return new Promise((resolve) => {
        this.sends.push({
          request: request as AgencDaemonRequest<"message.send">,
          resolve: () =>
            resolve(
              success(request, {
                messageId: String((request.params as JsonObject).clientMessageId),
                acceptedAt: "2026-08-17T00:00:00.000Z",
                disposition: "started",
                turnId: "turn_1",
              }) as AgencDaemonResponse<Method>,
            ),
        });
      });
    }
    throw new Error(`unexpected method: ${request.method}`);
  }

  emit(message: JsonObject): void {
    this.client?.dispatchNotification(message);
  }

  async waitForSend(): Promise<PromptTransport["sends"][number]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const send = this.sends[0];
      if (send !== undefined) return send;
      await Promise.resolve();
    }
    throw new Error("message.send was not observed");
  }
}

async function initializedClient(transport: PromptTransport): Promise<AgencClient> {
  const client = createAgencClient({ transport, clientId: "overflow-test-client" });
  transport.client = client;
  await client.initialize();
  return client;
}

const sessionId = "session_1";
const turnId = "turn_1";

function userMessage(clientMessageId: string, content: string): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.session_event",
    params: {
      sessionId,
      eventId: `user_${clientMessageId}`,
      event: {
        id: `user_${clientMessageId}`,
        type: "user_message",
        payload: { message: content, messageId: clientMessageId },
      },
    },
  };
}

function turnStarted(): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.agent_status",
    params: { sessionId, eventId: "started", status: "running", runStatus: "running", turnId },
  };
}

function terminal(): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.agent_status",
    params: { sessionId, eventId: "terminal", status: "idle", runStatus: "completed", turnId },
  };
}

function text(sequence: number): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.message_chunk",
    params: { sessionId, eventId: `delta_${sequence}`, sequence, turnId, delta: `d${sequence} ` },
  };
}

/** Events a run pushes besides its text deltas: user echo, started, terminal. */
const NON_TEXT_EVENTS = 3;

async function startRun(client: AgencClient, transport: PromptTransport) {
  const run = client.runPrompt(sessionId, "go", {
    clientMessageId: "overflow",
    includeUsage: false,
  });
  const send = await transport.waitForSend();
  transport.emit(userMessage("overflow", "go"));
  transport.emit(turnStarted());
  return { run, send };
}

const gaps = (events: readonly AgencPromptEvent[]) =>
  events.filter((event) => event.type === "gap");

describe("agenc-sdk socket prompt event overflow", () => {
  it("keeps the exact stream shape and order below the cap", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const { run, send } = await startRun(client, transport);
    const textCount = MAX_BUFFERED_PROMPT_EVENTS - NON_TEXT_EVENTS;
    for (let i = 1; i <= textCount; i += 1) transport.emit(text(i));
    transport.emit(terminal());
    send.resolve();
    await run.result();

    const drained: AgencPromptEvent[] = [];
    for await (const event of run) drained.push(event);

    expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS);
    expect(gaps(drained)).toEqual([]);
    expect(drained[0]).toMatchObject({ type: "session_event" });
    expect(drained[1]).toMatchObject({ type: "status", runStatus: "running" });
    expect(drained.slice(2, -1).map((event) => event.eventId)).toEqual(
      Array.from({ length: textCount }, (_, i) => `delta_${i + 1}`),
    );
    expect(drained.at(-1)).toMatchObject({ type: "status", runStatus: "completed" });
    await client.close();
  });

  it("surfaces a non-evictable local-overflow gap to a result-first consumer", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const { run, send } = await startRun(client, transport);
    const textCount = 1_500;
    for (let i = 1; i <= textCount; i += 1) transport.emit(text(i));
    transport.emit(terminal());
    send.resolve();
    await expect(run.result()).resolves.toMatchObject({ stopReason: "completed" });

    const drained: AgencPromptEvent[] = [];
    for await (const event of run) drained.push(event);

    const lost = textCount + NON_TEXT_EVENTS - MAX_BUFFERED_PROMPT_EVENTS;
    // A 1,500-event run must never look like a complete 1,000-event stream.
    expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    expect(drained[0]).toEqual({
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      sessionId,
      // user echo + started + deltas 1..(lost - 2) were discarded
      firstAvailableSequence: lost - 1,
      retiredCount: lost,
    });
    expect(drained[1]).toMatchObject({ type: "text", eventId: `delta_${lost - 1}` });
    expect(drained.at(-1)).toMatchObject({ type: "status", runStatus: "completed" });
    expect(gaps(drained)).toHaveLength(1);
    await client.close();
  });

  it("keeps memory bounded and the loss exact for a consumer that never drains during the run", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const { run, send } = await startRun(client, transport);
    const textCount = 20_000;
    for (let i = 1; i <= textCount; i += 1) transport.emit(text(i));
    transport.emit(terminal());
    send.resolve();
    await run.result();

    const drained: AgencPromptEvent[] = [];
    for await (const event of run) drained.push(event);
    expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    expect(drained[0]).toMatchObject({
      type: "gap",
      reason: "local_overflow",
      retiredCount: textCount + NON_TEXT_EVENTS - MAX_BUFFERED_PROMPT_EVENTS,
    });
    await client.close();
  });

  it("places the gap where a slow consumer actually lost events", async () => {
    const transport = new PromptTransport();
    const client = await initializedClient(transport);
    const { run, send } = await startRun(client, transport);
    const iterator = run[Symbol.asyncIterator]();

    for (let i = 1; i <= 10; i += 1) transport.emit(text(i));
    const consumedFirst: AgencPromptEvent[] = [];
    for (let i = 0; i < 3; i += 1) {
      consumedFirst.push((await iterator.next()).value as AgencPromptEvent);
    }
    expect(consumedFirst.map((event) => event.type)).toEqual(["session_event", "status", "text"]);
    expect(consumedFirst[2]).toMatchObject({ sequence: 1 });

    // 9 deltas buffered; 1,200 more plus the terminal overflow the cap by 210.
    for (let i = 11; i <= 1_210; i += 1) transport.emit(text(i));
    transport.emit(terminal());
    send.resolve();
    await run.result();

    const rest: AgencPromptEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest[0]).toEqual({
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      sessionId,
      afterSequence: 1,
      firstAvailableSequence: 212,
      retiredCount: 210,
    });
    expect(rest[1]).toMatchObject({ eventId: "delta_212" });
    expect(rest.at(-1)).toMatchObject({ type: "status", runStatus: "completed" });
    expect(rest).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    await client.close();
  });
});
