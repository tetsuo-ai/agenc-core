import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import {
  planResponsesWebSocketInput,
  responsesWebSocketCreateFrame,
  responsesWebSocketFixedPart,
  type ResponsesWebSocketChain,
} from "../../../../src/llm/providers/openai/responses-websocket.js";
import { LLMStreamTruncatedError } from "../../../../src/llm/errors.js";
import type { LLMChatOptions, LLMMessage, LLMResponse, LLMTool } from "../../../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";

const MODEL = "gpt-6-luna";
// Synthetic items in the shape OpenAI streams; never real ciphertext.
const REASONING = {
  type: "reasoning",
  id: "rs_0001",
  summary: [],
  encrypted_content: "gAAAAABsynthetic-websocket==",
};
const CALL = {
  type: "function_call",
  id: "fc_0001",
  call_id: "call_1",
  name: "read",
  arguments: '{"path":"a"}',
};
const COMMENTARY = {
  type: "message",
  id: "msg_0001",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Reading a.", annotations: [] }],
};
const TOOLS: LLMTool[] = [{
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
}];
const OPTIONS: LLMChatOptions = { tools: TOOLS, systemPrompt: "You are a test agent." };

type Frame = Record<string, unknown>;
type Reply = (frame: Frame, socket: WebSocket, index: number) => void;

/** A local endpoint that speaks both transports on `/v1/responses`. */
class MockResponsesEndpoint {
  readonly frames: Frame[] = [];
  readonly upgrades: IncomingMessage[] = [];
  readonly httpBodies: string[] = [];
  readonly sockets: WebSocket[] = [];
  /** Refuse the upgrade with this HTTP status. */
  refuseUpgrade: number | undefined;
  reply: Reply = (_frame, socket, index) => sendAll(socket, toolTurn(`resp_${index + 1}`));
  httpEvents: () => Frame[] = () => answerTurn("resp_http");

  private readonly http: Server;
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.http = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.httpBodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(this.httpEvents()
          .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""));
      });
    });
    this.http.on("upgrade", (request, socket, head) => {
      this.upgrades.push(request);
      if (this.refuseUpgrade !== undefined || request.url !== "/v1/responses") {
        socket.end(`HTTP/1.1 ${this.refuseUpgrade ?? 404} Refused\r\nConnection: close\r\n\r\n`);
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => {
        this.sockets.push(client);
        client.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as Frame;
          this.frames.push(frame);
          this.reply(frame, client, this.frames.length - 1);
        });
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/v1`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.wss.close();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

function sendAll(socket: WebSocket, events: readonly Frame[]): void {
  for (const event of events) socket.send(JSON.stringify(event));
}

function completed(id: string, output: unknown[]): Frame {
  return {
    type: "response.completed",
    response: {
      id, status: "completed", model: MODEL, output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  };
}

function toolTurn(id: string, output: unknown[] = [REASONING, COMMENTARY, CALL]): Frame[] {
  return [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_item.done", item: REASONING },
    { type: "response.output_text.delta", delta: "Reading a." },
    { type: "response.output_item.done", item: COMMENTARY },
    { type: "response.output_item.done", item: CALL },
    completed(id, output),
  ];
}

function answerTurn(id: string): Frame[] {
  const message = { ...COMMENTARY, id: "msg_0002", content: [{ type: "output_text", text: "done", annotations: [] }] };
  return [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.output_item.done", item: message },
    completed(id, [message]),
  ];
}

function inScope<T>(operation: () => Promise<T>): Promise<T> {
  // A provider scope turns encrypted reasoning replay on, as in a session.
  return runWithStartupProviderSelection({ provider: "openai", model: MODEL, environment: {} }, operation);
}

function stream(
  provider: OpenAIProvider,
  messages: LLMMessage[],
  options: LLMChatOptions = OPTIONS,
): Promise<LLMResponse> {
  return inScope(() => provider.chatStream(messages, () => {}, options));
}

function historyAfter(first: LLMResponse, toolOutput = "A"): LLMMessage[] {
  return [
    { role: "user", content: "read a" },
    {
      role: "assistant",
      content: first.content,
      toolCalls: first.toolCalls,
      ...(first.providerReasoningContent !== undefined
        ? {
          providerReasoningContent: first.providerReasoningContent,
          providerReasoningProvenance: first.providerReasoningProvenance,
        }
        : {}),
    },
    { role: "tool", toolCallId: "call_1", content: toolOutput },
  ];
}

const USER: LLMMessage[] = [{ role: "user", content: "read a" }];
const TOOL_OUTPUT = { type: "function_call_output", call_id: "call_1", output: "A" };

let endpoint: MockResponsesEndpoint | undefined;
const providers: OpenAIProvider[] = [];

async function start(): Promise<{ endpoint: MockResponsesEndpoint; baseURL: string }> {
  endpoint = new MockResponsesEndpoint();
  return { endpoint, baseURL: await endpoint.listen() };
}

function openai(baseURL: string, config: Partial<ConstructorParameters<typeof OpenAIProvider>[0]> = {}): OpenAIProvider {
  const provider = new OpenAIProvider({
    apiKey: "sk-test", model: MODEL, baseURL, responsesTransport: "websocket", ...config,
  });
  providers.push(provider);
  return provider;
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  await endpoint?.close();
  endpoint = undefined;
});

describe("planResponsesWebSocketInput", () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "read a" }] };
  const body = (input: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: MODEL, input, stream: true, store: false, instructions: "You are a test agent.",
    tools: [{ type: "function", name: "read" }], ...extra,
  });
  const chain = (output: Record<string, unknown>[] = [REASONING, COMMENTARY, CALL]): ResponsesWebSocketChain => ({
    responseId: "resp_1",
    fixed: responsesWebSocketFixedPart(body([user])),
    input: [JSON.stringify(user)],
    output,
  });
  // AgenC replays text, then reasoning, then calls; the service stored its own order.
  const replay = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading a." }] },
    { type: "reasoning", id: "rs_0001", summary: [], encrypted_content: REASONING.encrypted_content },
    { type: "function_call", id: "fc_0001", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
  ];

  test("sends only the items after the replay of the previous response", () => {
    const next = body([user, ...replay, TOOL_OUTPUT]);
    expect(planResponsesWebSocketInput(chain(), next)).toEqual([TOOL_OUTPUT]);
    expect(responsesWebSocketCreateFrame(next, chain(), [TOOL_OUTPUT])).toEqual({
      type: "response.create", model: MODEL, store: false, instructions: "You are a test agent.",
      tools: [{ type: "function", name: "read" }], input: [TOOL_OUTPUT], previous_response_id: "resp_1",
    });
    // A full frame is the HTTP body without `stream`.
    expect(responsesWebSocketCreateFrame(next)).toEqual({ type: "response.create", ...next, stream: undefined });
    expect("stream" in responsesWebSocketCreateFrame(next)).toBe(false);
  });

  test("accepts a replay without reasoning and arguments that differ only in JSON spacing", () => {
    const spaced = { ...replay[2]!, arguments: '{ "path": "a" }' };
    expect(planResponsesWebSocketInput(chain(), body([user, replay[0], spaced, TOOL_OUTPUT]))).toEqual([TOOL_OUTPUT]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another model", body([user, ...replay, TOOL_OUTPUT], { model: "gpt-6.1-sol" })],
    ["changed instructions", body([user, ...replay, TOOL_OUTPUT], { instructions: "Changed." })],
    ["changed tools", body([user, ...replay, TOOL_OUTPUT], { tools: [] })],
    ["another effort", body([user, ...replay, TOOL_OUTPUT], { reasoning: { effort: "high" } })],
    ["a compacted history", body([{ ...user, content: [{ type: "input_text", text: "summary" }] }, TOOL_OUTPUT])],
    ["an inserted first item", body([{ type: "message", role: "system", content: [] }, user, ...replay, TOOL_OUTPUT])],
    ["no new item", body([user, ...replay])],
    ["a replay without the call", body([user, replay[0], replay[1], TOOL_OUTPUT])],
    ["other call arguments", body([user, replay[0], { ...replay[2]!, arguments: '{"path":"b"}' }, TOOL_OUTPUT])],
    ["another call name", body([user, replay[0], { ...replay[2]!, name: "write" }, TOOL_OUTPUT])],
    ["edited assistant text", body([user, { ...replay[0]!, content: [{ type: "output_text", text: "Edited." }] }, replay[2], TOOL_OUTPUT])],
    ["dropped assistant text", body([user, replay[1], replay[2], TOOL_OUTPUT])],
    ["a reasoning item the response did not issue", body([user, replay[0], { ...replay[1]!, id: "rs_other" }, replay[2], TOOL_OUTPUT])],
  ])("plans no incremental input for %s", (_label, next) => {
    expect(planResponsesWebSocketInput(chain(), next)).toBeUndefined();
  });

  test("plans no incremental input after an output item it cannot compare", () => {
    const withSearch = chain([REASONING, { type: "web_search_call", id: "ws_1" }, COMMENTARY, CALL]);
    expect(planResponsesWebSocketInput(withSearch, body([user, ...replay, TOOL_OUTPUT]))).toBeUndefined();
  });
});

describe("OpenAIProvider Responses over WebSocket", () => {
  test("sends the full request first, then only new input with previous_response_id, on one socket", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) =>
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_2"));
    const provider = openai(baseURL);

    const first = await stream(provider, USER);
    const second = await stream(provider, historyAfter(first));

    expect(first.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: '{"path":"a"}' }]);
    expect(first.content).toBe("Reading a.");
    expect(first.finishReason).toBe("tool_calls");
    expect(first.usage.promptTokens).toBe(10);
    expect(second.content).toBe("done");
    expect(second.finishReason).toBe("stop");

    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.upgrades[0]!.url).toBe("/v1/responses");
    expect(endpoint.upgrades[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(endpoint.httpBodies).toHaveLength(0);

    const [full, incremental] = endpoint.frames as [Frame, Frame];
    expect(full.type).toBe("response.create");
    expect("stream" in full).toBe(false);
    expect(full.previous_response_id).toBeUndefined();
    expect(full.store).toBe(false);
    expect((full.input as unknown[]).at(-1)).toEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "read a" }],
    });
    expect(incremental.previous_response_id).toBe("resp_1");
    expect(incremental.input).toEqual([TOOL_OUTPUT]);
    // Everything but the input travels again: instructions are not carried over.
    const { input: _fullInput, ...fullRest } = full;
    const { input: _nextInput, previous_response_id: _previous, ...nextRest } = incremental;
    expect(nextRest).toEqual(fullRest);
  });

  test("returns what the HTTP transport returns for the same events", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.httpEvents = () => toolTurn("resp_1");
    const overSocket = await stream(openai(baseURL), USER);
    const overHttp = await stream(openai(baseURL, { responsesTransport: "http" }), USER);

    expect(overSocket).toEqual(overHttp);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(1);
    // The socket frame is the HTTP body without `stream`, plus the frame type.
    const { type: _type, ...frameBody } = endpoint.frames[0]!;
    expect({ ...frameBody, stream: true }).toEqual(JSON.parse(endpoint.httpBodies[0]!));
  });

  test("continues from streamed items when the completion carries no output (ChatGPT backend shape)", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) =>
      sendAll(socket, index === 0 ? toolTurn("resp_1", []) : answerTurn("resp_2"));
    const provider = openai(baseURL);
    await stream(provider, historyAfter(await stream(provider, USER)));

    expect(endpoint.frames[1]!.previous_response_id).toBe("resp_1");
    expect(endpoint.frames[1]!.input).toEqual([TOOL_OUTPUT]);
  });

  test.each<[string, (history: LLMMessage[]) => LLMMessage[], LLMChatOptions]>([
    ["changed instructions", (history) => history, { ...OPTIONS, systemPrompt: "Changed prompt." }],
    ["changed tools", (history) => history, { ...OPTIONS, tools: [] }],
    ["another model", (history) => history, { ...OPTIONS, model: "gpt-6.1-sol" }],
    ["a compacted history", (history) => [{ role: "user", content: "summary of the work so far" }, ...history.slice(1)], OPTIONS],
    ["an edited tool call", (history) => history.map((message) => message.role === "assistant"
      ? { ...message, toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"b"}' }] }
      : message), OPTIONS],
  ])("sends the full input on the same socket after %s", async (_label, edit, options) => {
    const { endpoint, baseURL } = await start();
    const provider = openai(baseURL);
    const history = edit(historyAfter(await stream(provider, USER)));
    await stream(provider, history, options);

    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(2);
    expect(endpoint.frames[1]!.previous_response_id).toBeUndefined();
    expect((endpoint.frames[1]!.input as unknown[]).length).toBeGreaterThan(1);
  });

  test("falls back to HTTP with the unchanged body when the upgrade is refused, then stops trying", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.refuseUpgrade = 404;
    const provider = openai(baseURL);
    const httpOnly = openai(baseURL, { responsesTransport: "http" });

    const viaFallback = await stream(provider, USER);
    await stream(provider, USER);
    await stream(provider, USER);
    const direct = await stream(httpOnly, USER);

    // Two refused upgrades, then HTTP for the rest of the session.
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.frames).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(4);
    expect(new Set(endpoint.httpBodies).size).toBe(1);
    expect(viaFallback).toEqual(direct);
  });

  test("falls back to HTTP when no server listens for the socket", async () => {
    const { endpoint, baseURL } = await start();
    const provider = openai(baseURL.replace("/v1", "/elsewhere/v1"));
    // Neither transport exists there; the HTTP mock answers any path.
    const response = await stream(provider, USER);
    expect(response.content).toBe("done");
    expect(endpoint.frames).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("answers a refused continuation over HTTP with the full body and stops chaining", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (frame, socket, index) => {
      if (frame.previous_response_id !== undefined) {
        return sendAll(socket, [{
          type: "error", status: 400,
          error: {
            type: "invalid_request_error", code: "previous_response_not_found",
            message: "Previous response with id 'resp_1' not found.", param: "previous_response_id",
          },
        }]);
      }
      sendAll(socket, index === 0 ? toolTurn("resp_1") : toolTurn(`resp_${index + 1}`));
    };
    const provider = openai(baseURL);
    const first = await stream(provider, USER);
    const history = historyAfter(first);

    const second = await stream(provider, history);
    expect(second.content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);
    const httpBody = JSON.parse(endpoint.httpBodies[0]!) as Frame;
    expect(httpBody.previous_response_id).toBeUndefined();
    expect((httpBody.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);
    expect((httpBody.input as unknown[]).length).toBeGreaterThan(1);

    // The socket stays in use, with full input from now on.
    await stream(provider, USER);
    await stream(provider, history);
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(4);
    expect(endpoint.frames[3]!.previous_response_id).toBeUndefined();
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("replaces a connection that reached its age limit and resends the full input", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      if (index === 1) {
        return sendAll(socket, [{
          type: "error", status: 400,
          error: {
            type: "invalid_request_error", code: "websocket_connection_limit_reached",
            message: "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
          },
        }]);
      }
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_2"));
    };
    const provider = openai(baseURL);
    const second = await stream(provider, historyAfter(await stream(provider, USER)));

    expect(second.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frames[1]!.previous_response_id).toBe("resp_1");
    expect(endpoint.frames[2]!.previous_response_id).toBeUndefined();
    expect((endpoint.frames[2]!.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);
  });

  test("reports a socket cut mid-response like a cut SSE stream, then reconnects with the full input", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      if (index === 1) {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_cut" } }));
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "par" }), () => socket.terminate());
        return;
      }
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_3"));
    };
    const provider = openai(baseURL);
    const history = historyAfter(await stream(provider, USER));

    await expect(stream(provider, history)).rejects.toBeInstanceOf(LLMStreamTruncatedError);
    const retried = await stream(provider, history);

    expect(retried.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frames[2]!.previous_response_id).toBeUndefined();
  });

  test("a socket closed before the response starts goes to HTTP, or is reported to a single-attempt caller", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) => socket.terminate();

    const retried = await stream(openai(baseURL), USER);
    expect(retried.content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);

    await expect(stream(openai(baseURL), USER, { ...OPTIONS, singleWireAttempt: true }))
      .rejects.toBeInstanceOf(LLMStreamTruncatedError);
    // The frame may have run: no second request.
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("closes the socket on abort and opens a new one for the next call", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      if (index === 0) {
        return sendAll(socket, [{ type: "response.created", response: { id: "resp_slow" } }]);
      }
      sendAll(socket, answerTurn("resp_2"));
    };
    const provider = openai(baseURL);
    const controller = new AbortController();
    const pending = stream(provider, USER, { ...OPTIONS, signal: controller.signal });
    await expect.poll(() => endpoint.frames.length).toBe(1);
    const serverSide = endpoint.sockets[0]!;
    const closed = new Promise<void>((resolve) => serverSide.once("close", () => resolve()));
    controller.abort();

    await expect(pending).rejects.toThrow();
    await closed;
    const next = await stream(provider, USER);
    expect(next.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("ends a silent response at the stream idle timeout", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) =>
      sendAll(socket, [{ type: "response.created", response: { id: "resp_silent" } }]);
    const provider = openai(baseURL, { timeoutMs: 150 });

    await expect(stream(provider, USER)).rejects.toThrow();
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("sends a call that arrives while the socket is busy over HTTP", async () => {
    const { endpoint, baseURL } = await start();
    let release: (() => void) | undefined;
    endpoint.reply = (_frame, socket) => {
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
      release = () => sendAll(socket, answerTurn("resp_1").slice(1));
    };
    const provider = openai(baseURL);
    const first = stream(provider, USER);
    await expect.poll(() => release !== undefined).toBe(true);

    const parallel = await stream(provider, [{ role: "user", content: "title?" }]);
    expect(parallel.content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);
    release!();
    expect((await first).content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(1);
  });

  test("keeps HTTP as the default and leaves every other provider on HTTP, byte for byte", async () => {
    const { endpoint, baseURL } = await start();
    const defaults = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, baseURL });
    await stream(defaults, USER);
    await stream(openai(baseURL, { responsesTransport: "http" }), USER);
    expect(endpoint.upgrades).toHaveLength(0);
    expect(endpoint.httpBodies[1]).toBe(endpoint.httpBodies[0]);

    // The same adapter under another provider name ignores the setting.
    for (const transport of ["websocket", undefined] as const) {
      const other = new OpenAIProvider({
        apiKey: "sk-test", model: "deepseek-v4.1-flash", baseURL, providerName: "deepseek",
        apiKeyEnvLabel: "DEEPSEEK_API_KEY", useResponsesApi: true,
        ...(transport !== undefined ? { responsesTransport: transport } : {}),
      });
      await inScope(() => other.chatStream(USER, () => {}, OPTIONS));
    }
    expect(endpoint.upgrades).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(4);
    expect(endpoint.httpBodies[3]).toBe(endpoint.httpBodies[2]);
  });
});
