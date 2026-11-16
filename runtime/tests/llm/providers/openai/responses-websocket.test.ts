import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import {
  planResponsesWebSocketInput,
  ResponsesWebSocketFallback,
  ResponsesWebSocketSession,
  responsesWebSocketCreateFrame,
  responsesWebSocketFixedPart,
  type ResponsesWebSocketChain,
} from "../../../../src/llm/providers/openai/responses-websocket.js";
import { LLMStreamRetryDeniedError, LLMStreamTruncatedError } from "../../../../src/llm/errors.js";
import type { LLMChatOptions, LLMMessage, LLMResponse, LLMTool } from "../../../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";

import { withPrintProviderPreconnect } from "../../../../src/session/print-provider-preconnect.js";
import { resolveAgentRuntimeOptions } from "../../../../src/session/runtime-options.js";

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
  /** For each frame, the index of the socket that carried it. */
  readonly frameSockets: number[] = [];
  /** Refuse the upgrade with this HTTP status. */
  refuseUpgrade: number | undefined;
  /** Cut the connection of an upgrade request without an answer. */
  cutUpgrade = false;
  /** Answer an upgrade request only after this long. */
  delayUpgradeMs = 0;
  /** Accept sockets but never read from them, so a large client write cannot finish. */
  stopReading = false;
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
      if (this.cutUpgrade) {
        socket.destroy();
        return;
      }
      if (this.refuseUpgrade !== undefined || request.url !== "/v1/responses") {
        socket.end(`HTTP/1.1 ${this.refuseUpgrade ?? 404} Refused\r\nConnection: close\r\n\r\n`);
        return;
      }
      const accept = (): void => this.wss.handleUpgrade(request, socket, head, (client) => {
        this.sockets.push(client);
        if (this.stopReading) (client as unknown as { _socket: { pause(): void } })._socket.pause();
        client.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as Frame;
          this.frames.push(frame);
          this.frameSockets.push(this.sockets.indexOf(client));
          this.reply(frame, client, this.frames.length - 1);
        });
      });
      if (this.delayUpgradeMs > 0) setTimeout(accept, this.delayUpgradeMs);
      else accept();
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
/** What a Light session's main loop passes, and what its start passes. */
const LIGHT: LLMChatOptions = { ...OPTIONS, lightSession: true };
const START = { conversationId: "conv-ws35b", threadId: "thread-ws35b" };
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

  test("plans no incremental input when the replayed assistant text differs only in whitespace", () => {
    const chain: ResponsesWebSocketChain = {
      responseId: "resp_1",
      fixed: responsesWebSocketFixedPart({ model: MODEL, input: [] }),
      input: [JSON.stringify({ type: "message", role: "user", content: [] })],
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "    pass" }] }],
    };
    const request = (text: string) => ({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    expect(planResponsesWebSocketInput(chain, request("    pass"))).toHaveLength(1);
    // The service would keep "    pass" while the history says otherwise.
    expect(planResponsesWebSocketInput(chain, request("pass"))).toBeUndefined();
    expect(planResponsesWebSocketInput(chain, request("    pass\n"))).toBeUndefined();
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
    const warnings: Array<{ cause: string; message: string }> = [];
    const diagnostics: string[] = [];
    const provider = openai(baseURL, {
      emitWarning: (warning) => warnings.push(warning),
      emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic.cause),
    });
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
    // One diagnostic per failed start, one notice when the session stays on HTTP.
    expect(diagnostics).toEqual(["openai_websocket_fallback", "openai_websocket_fallback"]);
    expect(warnings.map((warning) => warning.cause)).toEqual(["openai_websocket_unavailable"]);
    expect(warnings[0]!.message).toContain("continues over HTTP");
  });

  test("falls back to HTTP when the upgrade connection is cut without an answer", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.cutUpgrade = true;
    const response = await stream(openai(baseURL), USER);
    expect(response.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("a frame that stays unanswered goes to HTTP, and a single-attempt caller is told instead", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = () => undefined;
    // The stream idle timeout bounds the wait for the first event.
    const response = await stream(openai(baseURL, { timeoutMs: 150 }), USER);
    expect(response.content).toBe("done");
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(1);

    await expect(stream(openai(baseURL, { timeoutMs: 150 }), USER, { ...OPTIONS, singleWireAttempt: true }))
      .rejects.toBeInstanceOf(LLMStreamTruncatedError);
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("ignores a frame that trails a finished response", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_2"));
      sendAll(socket, [{ type: "error", status: 400, error: { code: "late_noise", message: "after the end" } }]);
    };
    const provider = openai(baseURL);
    const second = await stream(provider, historyAfter(await stream(provider, USER)));

    expect(second.content).toBe("done");
    expect(endpoint.frames[1]!.previous_response_id).toBe("resp_1");
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.upgrades).toHaveLength(1);
  });

  test("a refused request that is not about the continuation keeps later continuations", async () => {
    const { endpoint, baseURL } = await start();
    let refused = false;
    endpoint.reply = (frame, socket, index) => {
      if (frame.previous_response_id !== undefined && !refused) {
        refused = true;
        return sendAll(socket, [{
          type: "error", status: 429,
          error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached." },
        }]);
      }
      sendAll(socket, toolTurn(`resp_${index + 1}`));
    };
    const warnings: string[] = [];
    const provider = openai(baseURL, { emitWarning: (warning) => warnings.push(warning.cause) });
    const history = historyAfter(await stream(provider, USER));

    await stream(provider, history);  // the refused continuation, answered over HTTP
    const again = await stream(provider, USER);
    await stream(provider, historyAfter(again));

    expect(endpoint.httpBodies).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(endpoint.frames.map((frame) => frame.previous_response_id)).toEqual([undefined, "resp_1", undefined, "resp_3"]);
  });

  test("frees the socket when the consumer fails mid-response", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => sendAll(socket, answerTurn(`resp_${index + 1}`));
    const provider = openai(baseURL);
    await expect(inScope(() => provider.chatStream(USER, () => {
      throw new Error("consumer failed");
    }, OPTIONS))).rejects.toThrow("consumer failed");

    const next = await stream(provider, USER);
    expect(next.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("dispose during a response ends it at once", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) =>
      sendAll(socket, [{ type: "response.created", response: { id: "resp_open" } }]);
    const provider = openai(baseURL);
    const pending = stream(provider, USER);
    await expect.poll(() => endpoint.frames.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.dispose();
    await expect(pending).rejects.toBeInstanceOf(LLMStreamTruncatedError);
  });

  test("sends a call with a per-request header over HTTP", async () => {
    const { endpoint, baseURL } = await start();
    const provider = openai(baseURL, { managedRequestId: true });
    await stream(provider, USER, { ...OPTIONS, managedRequestId: "11111111-1111-4111-8111-111111111111" });
    expect(endpoint.upgrades).toHaveLength(0);
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
    const warnings: string[] = [];
    const provider = openai(baseURL, { emitWarning: (warning) => warnings.push(warning.cause) });
    const first = await stream(provider, USER);
    const history = historyAfter(first);

    const second = await stream(provider, history);
    expect(second.content).toBe("done");
    expect(warnings).toEqual(["openai_websocket_full_input"]);
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
    // An aborted signal sends nothing, on a new socket or a warm one.
    await expect(stream(provider, USER, { ...OPTIONS, signal: controller.signal })).rejects.toThrow();
    expect(endpoint.frames).toHaveLength(1);
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

    await expect(stream(provider, USER)).rejects.toThrow(/idle for 150ms|timed out after 150ms/u);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frames).toHaveLength(1);
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

  test("leaves calls outside a Light session and every other provider on HTTP, byte for byte", async () => {
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
      providers.push(other);
      // Another provider has no startup hook, and a marked call opens no socket for it.
      expect(other.prewarmStartup).toBeUndefined();
      await inScope(() => other.chatStream(USER, () => {}, { ...OPTIONS, lightSession: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(endpoint.upgrades).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(4);
    expect(endpoint.httpBodies[3]).toBe(endpoint.httpBodies[2]);
  });
});

describe("OpenAIProvider WebSocket by default for Light sessions, with pre-connect", () => {
  /** The provider as a session gets it: no transport configured. */
  function light(baseURL: string, config: Partial<ConstructorParameters<typeof OpenAIProvider>[0]> = {}): OpenAIProvider {
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, baseURL, ...config });
    providers.push(provider);
    return provider;
  }
  const upgrades = (count: number): Promise<void> => expect.poll(() => endpoint!.sockets.length).toBe(count);

  test("print startup opens the same socket before session setup completes", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) => sendAll(socket, answerTurn("resp_print"));
    const provider = light(baseURL);
    await withPrintProviderPreconnect({
      provider, conversationId: START.conversationId,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true }),
      environment: { AGENC_OPENAI_PRINT_PRECONNECT: "1" },
    }, async () => {
      await upgrades(1);
      expect(endpoint.frames).toHaveLength(0);
      expect(endpoint.httpBodies).toHaveLength(0);
    });
    const first = await stream(provider, USER, LIGHT);
    expect(first.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("opens the socket when a Light session starts and sends the first call on it", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) =>
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_2"));
    const provider = light(baseURL);

    provider.prewarmStartup!({ ...START, lightSession: true });
    await upgrades(1);
    // Connected, and nothing sent: a pre-connect costs no request.
    expect(endpoint.frames).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.upgrades[0]!.headers.authorization).toBe("Bearer sk-test");

    const first = await stream(provider, USER, LIGHT);
    const second = await stream(provider, historyAfter(first), LIGHT);
    expect(second.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frames[0]!.previous_response_id).toBeUndefined();
    expect(endpoint.frames[1]!.previous_response_id).toBe("resp_1");
    expect(endpoint.frames[1]!.input).toEqual([TOOL_OUTPUT]);
  });

  test("a call that arrives during the pre-connect shares its handshake", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.delayUpgradeMs = 120;
    endpoint.reply = (_frame, socket) => sendAll(socket, answerTurn("resp_1"));
    const provider = light(baseURL);

    provider.prewarmStartup!({ ...START, lightSession: true });
    expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("uses the socket for a Light call without a session start, and HTTP for an unmarked call", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) => sendAll(socket, answerTurn("resp_1"));
    const provider = light(baseURL);

    await stream(provider, USER, LIGHT);
    expect(endpoint.upgrades).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(0);
    // An auxiliary call of the same provider (no Light mark) keeps HTTP.
    await stream(provider, USER);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("opens no socket for the http transport, for a session that is not Light, or for a model on Chat Completions", async () => {
    const { endpoint, baseURL } = await start();
    const optedOut = light(baseURL, { responsesTransport: "http" });
    optedOut.prewarmStartup!({ ...START, lightSession: true });
    light(baseURL).prewarmStartup!(START);
    light(baseURL, { useResponsesApi: false, model: "gpt-4o" }).prewarmStartup!({ ...START, lightSession: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(endpoint.upgrades).toHaveLength(0);

    // The opt-out sends what the socket-less provider sends, byte for byte.
    await stream(optedOut, USER, LIGHT);
    await stream(light(baseURL), USER);
    expect(endpoint.upgrades).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(2);
    expect(endpoint.httpBodies[1]).toBe(endpoint.httpBodies[0]);
  });

  test("the configured websocket transport pre-connects for any session", async () => {
    const { baseURL } = await start();
    openai(baseURL).prewarmStartup!(START);
    await upgrades(1);
  });

  test("sends the session header of the ChatGPT backend on the pre-connect", async () => {
    const { endpoint, baseURL } = await start();
    light(baseURL, { chatgptBackend: true }).prewarmStartup!({ ...START, lightSession: true });
    await upgrades(1);
    expect(endpoint.upgrades[0]!.headers.session_id).toBe(START.conversationId);
  });

  test("reopens the socket after the far end closes it idle, and stops when the new ones go unused", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) =>
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_2"));
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    await upgrades(1);
    const first = await stream(provider, USER, LIGHT);

    // Idle close by the far end: the next socket is opened at once, not by the next call.
    endpoint.sockets[0]!.close(1000);
    await upgrades(2);
    const second = await stream(provider, historyAfter(first), LIGHT);
    expect(second.content).toBe("done");
    expect(endpoint.frameSockets).toEqual([0, 1]);
    // A new connection has no memory of the previous response: full input.
    expect(endpoint.frames[1]!.previous_response_id).toBeUndefined();
    expect((endpoint.frames[1]!.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);
    expect(endpoint.httpBodies).toHaveLength(0);

    // Sockets that are closed unused are replaced twice, then no more until a call asks.
    endpoint.sockets[1]!.close(1000);
    await upgrades(3);
    endpoint.sockets[2]!.close(1000);
    await upgrades(4);
    endpoint.sockets[3]!.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(endpoint.upgrades).toHaveLength(4);
    expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(5);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("a socket cut mid-response (1006) is reported like a cut SSE stream and the retry runs on a new socket", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      if (index === 1) {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_cut" } }));
        // No close frame: the client sees an abnormal closure, code 1006.
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "par" }), () => socket.terminate());
        return;
      }
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn("resp_3"));
    };
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    const history = historyAfter(await stream(provider, USER, LIGHT));

    await expect(stream(provider, history, LIGHT)).rejects.toBeInstanceOf(LLMStreamTruncatedError);
    // The replacement is opened without waiting for the retry.
    await upgrades(2);
    const retried = await stream(provider, history, LIGHT);

    expect(retried.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frameSockets).toEqual([0, 0, 1]);
    expect(endpoint.frames[1]!.previous_response_id).toBe("resp_1");
    expect(endpoint.frames[2]!.previous_response_id).toBeUndefined();
    expect((endpoint.frames[2]!.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);
  });

  test("a refused continuation is answered over HTTP with the full body, with one notice", async () => {
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
      sendAll(socket, index === 0 ? toolTurn("resp_1") : answerTurn(`resp_${index + 1}`));
    };
    const warnings: string[] = [];
    const provider = light(baseURL, { emitWarning: (warning) => warnings.push(warning.cause) });
    provider.prewarmStartup!({ ...START, lightSession: true });
    const history = historyAfter(await stream(provider, USER, LIGHT));

    expect((await stream(provider, history, LIGHT)).content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);
    const httpBody = JSON.parse(endpoint.httpBodies[0]!) as Frame;
    expect(httpBody.previous_response_id).toBeUndefined();
    expect((httpBody.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);

    // The socket stays, with the full input from now on, and the notice is not repeated.
    expect((await stream(provider, history, LIGHT)).content).toBe("done");
    expect(endpoint.frames.at(-1)!.previous_response_id).toBeUndefined();
    expect(endpoint.httpBodies).toHaveLength(1);
    expect(endpoint.upgrades).toHaveLength(1);
    expect(warnings).toEqual(["openai_websocket_full_input"]);
  });

  test("an early error frame that forbids a retry ends the call and is not resubmitted over HTTP", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) => sendAll(socket, [{
      type: "error", status: 503,
      headers: { "x-retry-metadata": "NO_MORE_RETRY" },
      error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are overloaded." },
    }]);
    const provider = light(baseURL);

    await expect(stream(provider, USER, LIGHT)).rejects.toBeInstanceOf(LLMStreamRetryDeniedError);
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(0);

    // The same error without the directive is still answered over HTTP.
    endpoint.reply = (_frame, socket) => sendAll(socket, [{
      type: "error", status: 503,
      error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are overloaded." },
    }]);
    expect((await stream(light(baseURL), USER, LIGHT)).content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);
  });

  test("the provider's client releases the socket: closed at once, not reopened, and usable again later", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket) => sendAll(socket, answerTurn("resp_1"));
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    await upgrades(1);
    await stream(provider, USER, LIGHT);

    // What a session does at shutdown and when another provider takes over.
    (provider as unknown as { client: { releaseTransports(): void } }).client.releaseTransports();
    await expect.poll(() => endpoint.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(endpoint.upgrades).toHaveLength(1);

    // The provider is not broken: a later call connects again, and its socket is not replaced ahead.
    expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
    endpoint.sockets[1]!.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(endpoint.upgrades).toHaveLength(2);
  });

  test("a release during the pre-connect ends the handshake", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.delayUpgradeMs = 60;
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    await expect.poll(() => endpoint.upgrades.length).toBe(1);
    (provider as unknown as { client: { releaseTransports(): void } }).client.releaseTransports();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(endpoint.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
    expect(endpoint.upgrades).toHaveLength(1);
  });

  test("the 60 minute limit of the service moves the call to a new socket with the full input", async () => {
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
    const warnings: string[] = [];
    const provider = light(baseURL, { emitWarning: (warning) => warnings.push(warning.cause) });
    provider.prewarmStartup!({ ...START, lightSession: true });
    const second = await stream(provider, historyAfter(await stream(provider, USER, LIGHT)), LIGHT);

    expect(second.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(0);
    expect(endpoint.frameSockets).toEqual([0, 0, 1]);
    expect(endpoint.frames[2]!.previous_response_id).toBeUndefined();
    expect((endpoint.frames[2]!.input as unknown[]).at(-1)).toEqual(TOOL_OUTPUT);
    expect(warnings).toEqual([]);
  });

  test("a call cancelled mid-stream closes its socket and a new one is ready for the next call", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.reply = (_frame, socket, index) => {
      if (index === 0) {
        return sendAll(socket, [
          { type: "response.created", response: { id: "resp_slow" } },
          { type: "response.output_text.delta", delta: "par" },
        ]);
      }
      sendAll(socket, answerTurn("resp_2"));
    };
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    await upgrades(1);
    const controller = new AbortController();
    const chunks: string[] = [];
    const pending = inScope(() => provider.chatStream(USER, (chunk) => {
      if (chunk.content) chunks.push(chunk.content);
    }, { ...LIGHT, signal: controller.signal }));
    await expect.poll(() => chunks.join("")).toBe("par");
    const serverSide = endpoint.sockets[0]!;
    const closed = new Promise<void>((resolve) => serverSide.once("close", () => resolve()));
    controller.abort();

    await expect(pending).rejects.toThrow();
    await closed;
    await upgrades(2);
    expect(endpoint.frames).toHaveLength(1);
    const next = await stream(provider, USER, LIGHT);
    expect(next.content).toBe("done");
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.frameSockets).toEqual([0, 1]);
    expect(endpoint.httpBodies).toHaveLength(0);
  });

  test("a default try against a local endpoint without WebSocket mode settles on HTTP after one failed start, silently", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.refuseUpgrade = 404;
    const warnings: string[] = [];
    const diagnostics: string[] = [];
    const provider = light(baseURL, {
      emitWarning: (warning) => warnings.push(warning.cause),
      emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic.cause),
    });
    provider.prewarmStartup!({ ...START, lightSession: true });
    await expect.poll(() => diagnostics).toEqual(["openai_websocket_preconnect_failed"]);

    const viaDefault = await stream(provider, USER, LIGHT);
    await stream(provider, USER, LIGHT);
    const direct = await stream(light(baseURL, { responsesTransport: "http" }), USER, LIGHT);
    // The pre-connect and the first call's own try; nothing after that.
    expect(endpoint.upgrades).toHaveLength(2);
    expect(endpoint.httpBodies).toHaveLength(3);
    expect(new Set(endpoint.httpBodies).size).toBe(1);
    expect(viaDefault).toEqual(direct);
    expect(diagnostics).toEqual(["openai_websocket_preconnect_failed", "openai_websocket_fallback"]);
    expect(warnings).toEqual([]);
  });

  test("on OpenAI's own endpoints two failed starts keep the session on HTTP with the notice", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.refuseUpgrade = 404;
    const warnings: string[] = [];
    // The ChatGPT backend flag marks the endpoint as OpenAI's, whatever its address.
    const provider = light(baseURL, { chatgptBackend: true, emitWarning: (warning) => warnings.push(warning.cause) });
    provider.prewarmStartup!({ ...START, lightSession: true });
    await expect.poll(() => endpoint.upgrades.length).toBe(1);

    for (let call = 0; call < 3; call += 1) expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    // The failed pre-connect is not one of the two.
    expect(endpoint.upgrades).toHaveLength(3);
    expect(endpoint.httpBodies).toHaveLength(3);
    expect(warnings).toEqual(["openai_websocket_unavailable"]);
  });

  test("a pre-connect refused for its credential does not cost the session its socket", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.refuseUpgrade = 401;
    endpoint.reply = (_frame, socket) => sendAll(socket, answerTurn("resp_1"));
    const warnings: string[] = [];
    const diagnostics: string[] = [];
    const provider = light(baseURL, {
      chatgptBackend: true,
      emitWarning: (warning) => warnings.push(warning.cause),
      emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic.cause),
    });
    provider.prewarmStartup!({ ...START, lightSession: true });
    await expect.poll(() => diagnostics).toEqual(["openai_websocket_preconnect_failed"]);

    // The first call is refused too and goes over HTTP (where a 401 refreshes the sign-in) ...
    expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    expect(endpoint.httpBodies).toHaveLength(1);
    // ... and with the credential accepted again the next call is on the socket.
    endpoint.refuseUpgrade = undefined;
    expect((await stream(provider, USER, LIGHT)).content).toBe("done");
    expect(endpoint.frames).toHaveLength(1);
    expect(endpoint.httpBodies).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("opens no socket by default when a fetch is injected or the host is another remote one", async () => {
    const { endpoint, baseURL } = await start();
    const injected = light(baseURL, { fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args) });
    injected.prewarmStartup!({ ...START, lightSession: true });
    await stream(injected, USER, LIGHT);
    expect(endpoint.upgrades).toHaveLength(0);
    expect(endpoint.httpBodies).toHaveLength(1);

    // A gateway: the call goes to the injected fetch-less HTTP path only, so no socket is tried there.
    // (The hermetic runner fails the suite on any public connection attempt.)
    const gateway = light("https://gateway.invalid/v1");
    gateway.prewarmStartup!({ ...START, lightSession: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(endpoint.upgrades).toHaveLength(0);
  });

  test("dispose during the pre-connect leaves no socket behind", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.delayUpgradeMs = 60;
    const provider = light(baseURL);
    provider.prewarmStartup!({ ...START, lightSession: true });
    await expect.poll(() => endpoint.upgrades.length).toBe(1);
    provider.dispose();
    // The handshake ends with the provider: the endpoint's late answer finds nobody.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(endpoint.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
    expect(endpoint.frames).toHaveLength(0);
  });
});

describe("ResponsesWebSocketSession", () => {
  const body = (input: unknown[]): Record<string, unknown> => ({ model: MODEL, input, stream: true, store: false });
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "read a" }] };
  const replay = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading a." }] },
    { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
  ];

  async function drain(session: ResponsesWebSocketSession, baseURL: string, input: unknown[], signal?: AbortSignal): Promise<boolean> {
    const turn = await session.begin({
      target: async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} }),
      body: body(input),
      ...(signal !== undefined ? { signal } : {}),
    });
    for await (const _event of turn.events()) { /* read to the end */ }
    return turn.incremental;
  }

  test("replaces a socket older than its age limit before the next send, with the full input", async () => {
    const { endpoint, baseURL } = await start();
    let now = 0;
    const session = new ResponsesWebSocketSession({ providerName: "openai", maxConnectionAgeMs: 1000, now: () => now });
    try {
      expect(await drain(session, baseURL, [user])).toBe(false);
      now = 999;
      expect(await drain(session, baseURL, [user, ...replay, TOOL_OUTPUT])).toBe(true);
      now = 1000;
      expect(await drain(session, baseURL, [user, ...replay, TOOL_OUTPUT, ...replay, TOOL_OUTPUT])).toBe(false);
      expect(endpoint.upgrades).toHaveLength(2);
      expect(endpoint.frames[2]!.previous_response_id).toBeUndefined();
      expect(session.stats).toMatchObject({ connects: 2, turns: 3, incrementalTurns: 1, fallbacks: 0 });
    } finally {
      session.dispose();
    }
  });

  test("replaces an idle pre-connected socket at its age limit without a call", async () => {
    const { endpoint, baseURL } = await start();
    const session = new ResponsesWebSocketSession({ providerName: "openai", maxConnectionAgeMs: 800 });
    const target = async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} });
    try {
      expect(await session.preconnect(target)).toBe("open");
      expect(await drain(session, baseURL, [user])).toBe(false);
      expect(endpoint.upgrades).toHaveLength(1);
      await expect.poll(() => endpoint.sockets.length, { timeout: 5000 }).toBe(2);
      // The old socket is closed, and the next call starts a new chain on the new one.
      await expect.poll(() => endpoint.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
      expect(await drain(session, baseURL, [user, ...replay, TOOL_OUTPUT])).toBe(false);
      expect(endpoint.frameSockets).toEqual([0, 1]);
      expect(session.stats).toMatchObject({ connects: 2, preconnects: 2, turns: 2, fallbacks: 0 });
    } finally {
      session.dispose();
    }
  });

  test("a pre-connect is one connect: repeated and concurrent calls share it", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.delayUpgradeMs = 50;
    const session = new ResponsesWebSocketSession({ providerName: "openai" });
    const target = async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} });
    try {
      const [first, second] = await Promise.all([session.preconnect(target), session.preconnect(target)]);
      expect([first, second]).toEqual(["open", "open"]);
      expect(await session.preconnect(target)).toBe("open");
      expect(endpoint.upgrades).toHaveLength(1);
      expect(session.stats).toMatchObject({ connects: 1, preconnects: 1, connectFailures: 0 });
    } finally {
      session.dispose();
    }
  });

  test("a write the peer never reads is given up at the send timeout, and a cancel ends it at once", async () => {
    const { endpoint, baseURL } = await start();
    endpoint.stopReading = true;
    const target = async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} });
    // Far more than the socket buffers of both ends hold.
    const huge = [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(48 * 1024 * 1024) }] }];

    const session = new ResponsesWebSocketSession({ providerName: "openai", sendTimeoutMs: 300 });
    try {
      const started = Date.now();
      const failure = await session.begin({ target, body: body(huge) }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ResponsesWebSocketFallback);
      expect((failure as ResponsesWebSocketFallback).message).toBe("send timed out");
      // The frame may have reached the service in part: a single-attempt caller must know.
      expect((failure as ResponsesWebSocketFallback).afterSend).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(session.available).toBe(true);
    } finally {
      session.dispose();
    }

    const cancelled = new ResponsesWebSocketSession({ providerName: "openai", sendTimeoutMs: 60_000 });
    try {
      const controller = new AbortController();
      const pending = cancelled.begin({ target, body: body(huge), signal: controller.signal });
      await expect.poll(() => endpoint.sockets.length).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      controller.abort(new Error("cancelled by the user"));
      await expect(pending).rejects.toThrow("cancelled by the user");
      expect(Date.now() - started).toBeLessThan(2000);
      // The lane is free again (the stalled socket was terminated; its peer does not read the close).
      expect(cancelled.available).toBe(true);
    } finally {
      cancelled.dispose();
    }
  });

  test("standing down closes an idle socket and stops the reopening; a response in flight keeps its socket", async () => {
    const { endpoint, baseURL } = await start();
    const session = new ResponsesWebSocketSession({ providerName: "openai", maxConnectionAgeMs: 300 });
    const target = async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} });
    try {
      expect(await session.preconnect(target)).toBe("open");
      session.standDown();
      await expect.poll(() => endpoint.sockets[0]!.readyState).toBe(WebSocket.CLOSED);
      // Neither the close nor the age limit opens another one.
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(endpoint.upgrades).toHaveLength(1);

      const turn = await session.begin({ target, body: body([user]) });
      session.standDown();
      const types: string[] = [];
      for await (const event of turn.events()) types.push(String(event.data.type));
      expect(types.at(-1)).toBe("response.completed");
      expect(endpoint.upgrades).toHaveLength(2);
    } finally {
      session.dispose();
    }
  });

  test("a turn given up without being read frees the session", async () => {
    const { endpoint, baseURL } = await start();
    const session = new ResponsesWebSocketSession({ providerName: "openai" });
    try {
      const turn = await session.begin({
        target: async () => ({ url: `${baseURL.replace("http", "ws")}/responses`, headers: {} }),
        body: body([user]),
      });
      expect(session.available).toBe(false);
      turn.cancel();
      expect(session.available).toBe(true);
      expect(await drain(session, baseURL, [user])).toBe(false);
      expect(endpoint.upgrades).toHaveLength(2);
    } finally {
      session.dispose();
    }
  });

  test("reports a busy or disposed session as a fallback that sent nothing", async () => {
    const { baseURL } = await start();
    const session = new ResponsesWebSocketSession({ providerName: "openai" });
    session.dispose();
    const failure = await drain(session, baseURL, [user]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResponsesWebSocketFallback);
    expect((failure as ResponsesWebSocketFallback).afterSend).toBe(false);
  });
});
