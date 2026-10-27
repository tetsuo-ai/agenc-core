import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { findToolTurnValidationIssue } from "../../src/llm/tool-turn-validator.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { buildAnthropicMessagesRequest } from "../../src/llm/wire/messages-anthropic.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { buildXaiResponsesRequest } from "../../src/llm/wire/responses-xai.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { BedrockProvider } from "../../src/llm/providers/bedrock/index.js";
import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import { responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { RunDeadlineReachedError } from "../../src/session/run-deadline.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

const essay = "Write a 600-word essay about lighthouses. Do not use any tools.";
const nextPrompt = "Spawn a sub-agent to write sub.txt, then reply with only: both done";
const marker = "[The user stopped this response before it finished. Do not continue the previous request unless the user asks you to.]";

async function assertWireBoundaries(messages: LLMMessage[]) {
  const input = { messages, tools: [], model: "test-model" };
  const requests = [
    buildChatCompletionsRequest(input).messages,
    buildAnthropicMessagesRequest(input).messages,
    buildOpenAIResponsesRequest(input).input,
    buildXaiResponsesRequest(input).input,
  ];
  const bedrockFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    output: { message: { role: "assistant", content: [{ text: "both done" }] } }, stopReason: "end_turn",
  }));
  await new BedrockProvider({ model: "amazon.nova-pro-v1:0", region: "us-east-1",
    accessKeyId: "test-only", secretAccessKey: "test-only", fetchImpl: bedrockFetch }).chat(messages);
  requests.push(JSON.parse(String(bedrockFetch.mock.calls[0]?.[1]?.body)).messages);

  const ollama = new OllamaProvider({ model: "qwen2.5-coder:7b" });
  Object.assign(ollama, { client: {
    show: async () => ({ capabilities: ["completion", "tools"] }),
    chat: async (request: { messages: unknown }) => {
      requests.push(request.messages);
      return { message: { content: "both done" }, done: true, done_reason: "stop" };
    },
  } });
  const profile = await ollama.getExecutionProfile({});
  await ollama.chat(messages, { providerExecutionHandle: profile.providerExecutionHandle });

  for (const request of requests) {
    const turns = (request as Array<{ role: string; content: unknown }>).filter(
      item => item.role === "user" || item.role === "assistant",
    );
    const previous = turns.findIndex(item => JSON.stringify(item.content).includes(essay));
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(turns.slice(previous, previous + 3).map(item => item.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(turns[previous + 1]?.content)).toContain(marker);
    expect(JSON.stringify(turns[previous + 2]?.content)).toContain(nextPrompt);
  }
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: "both done" }] }, finishReason: "STOP" }],
  }));
  const gemini = new GeminiProvider({
    model: "gemini-2.5-pro", endpointPlan: createGeminiEndpointPlan(),
    credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" }, fetchImpl,
  });
  await gemini.chat(messages);
  const contents = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).contents;
  const previous = contents.findIndex((item: unknown) => JSON.stringify(item).includes(essay));
  expect(contents.slice(previous, previous + 3).map((item: { role: string }) => item.role)).toEqual(["user", "model", "user"]);
  expect(JSON.stringify(contents[previous + 1])).toContain(marker);
  expect(JSON.stringify(contents[previous + 2])).toContain(nextPrompt);
}

describe("model request after user interruption", () => {
  for (const lightMode of [false, true]) {
    for (const child of [false, true]) {
      test.each(["before text", "streamed text", "returned partial"])(
        `persists one boundary, live and resumed (Light=${lightMode}, child=${child}, %s)`,
        async (phase) => {
          const home = mkdtempSync(join(tmpdir(), "interrupt-marker-"));
          const controller = new AbortController();
          const requests: LLMMessage[][] = [];
          const provider = mkProvider({ content: "both done" }, { onChatStream: messages => requests.push(messages) });
          const complete = provider.chatStream;
          let first = true;
          provider.chatStream = async (messages, emit, options) => {
            if (!first) return complete(messages, emit, options);
            first = false;
            if (phase !== "before text") emit({ content: "A lighthouse stands on the rocky coast.", done: false });
            controller.abort("interrupted");
            if (phase === "returned partial") return {
              content: "A lighthouse stands on the rocky coast.", toolCalls: [], model: "test-model",
              finishReason: "stop", usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
            };
            throw new DOMException("Stopped", "AbortError");
          };
          const services = { runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode }) };
          const { session, events } = mkSession({ cwd: home, provider, services });
          const store = new RolloutStore({ cwd: home, agencHome: join(home, "agenc"),
            sessionId: "conv-test", agencVersion: "0.19.18", sessionTempRoot: home });
          store.open({ sessionId: "conv-test", timestamp: new Date().toISOString(), cwd: home,
            originator: "interrupt-test", agencVersion: "0.19.18", model: "test-model", modelProvider: provider.name });
          session.mountRolloutStore(store);
          const ctx = (subId: string) => mkCtx({ subId, cwd: home,
            ...(child ? { depth: 1, sessionSource: "cli_subagent" } : {}) });
          try {
            await drain(runTurn(session, ctx("stopped"), essay, { signal: controller.signal }));
            expect(events.filter(event => event.msg.type === "turn_aborted").map(event => event.msg.payload))
              .toEqual([expect.objectContaining({ reason: "interrupted" })]);
            store.flushDurable();
            const reconstructed = reconstructFromRollout(store.readAll());
            expect(reconstructed.orphanedTurnIds).toEqual([]);
            const history = reconstructed.history.map(responseItemToLlmMessage);
            expect(history.filter(message => message.content === marker)).toHaveLength(1);
            await drain(runTurn(session, ctx("next-live"), nextPrompt));
            const resumed = mkSession({ cwd: home, provider, services, history }).session;
            try { await drain(runTurn(resumed, ctx("next-resumed"), nextPrompt)); }
            finally { await resumed.shutdown(); }
            expect(requests).toHaveLength(2);
            for (const request of requests) {
              expect(request.filter(message => message.content === marker)).toHaveLength(1);
              await assertWireBoundaries(request);
            }
            expect(store.readAll().filter(item => item.type === "response_item" && item.payload.content === marker)).toHaveLength(1);
          } finally {
            await session.shutdown();
            store.close();
            rmSync(home, { recursive: true, force: true });
          }
        },
      );
    }
  }

  test.each(["daemon_shutdown", "replaced", "review_ended"])("does not label %s as a user stop", async reason => {
    const controller = new AbortController();
    const provider = mkProvider();
    provider.chatStream = async () => {
      controller.abort(reason);
      throw new DOMException("Aborted", "AbortError");
    };
    const { session } = mkSession({ provider });
    try {
      await drain(runTurn(session, mkCtx(), essay, { signal: controller.signal }));
      const history = await session.state.with(state => [...state.history]);
      expect(history.some(message => message.content === marker)).toBe(false);
    } finally { await session.shutdown(); }
  });

  test("keeps completed tool pairs before the stop marker and the next request", async () => {
    const controller = new AbortController();
    const requests: LLMMessage[][] = [];
    const provider = mkProvider({ content: "both done" }, { onChatStream: messages => requests.push(messages) });
    const complete = provider.chatStream;
    let first = true;
    provider.chatStream = async (messages, emit, options) => {
      if (!first) return complete(messages, emit, options);
      first = false;
      return { content: "Checking the file.", toolCalls: [{ id: "read-once", name: "interrupt_probe", arguments: "{}" }],
        model: "test-model", finishReason: "tool_calls",
        usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 } };
    };
    const read = vi.fn(async () => {
      controller.abort("interrupted");
      return { content: "already read", isError: false };
    });
    const registry = {
      tools: [{ name: "interrupt_probe", description: "read", inputSchema: { type: "object" },
        requiresApproval: false, recoveryCategory: "read-only",
        execute: read }],
      toLLMTools: () => [], dispatch: read,
    } as unknown as ToolRegistry;
    const { session, events } = mkSession({ provider, registry });
    try {
      await drain(runTurn(session, mkCtx({ subId: "read" }), "Read a file", { signal: controller.signal }));
      expect(events.filter(event => ["turn_aborted", "turn_failed", "turn_complete"].includes(event.msg.type)).map(event => event.msg))
        .toContainEqual(expect.objectContaining({ type: "turn_aborted", payload: expect.objectContaining({ reason: "interrupted" }) }));
      await drain(runTurn(session, mkCtx({ subId: "next" }), nextPrompt));
      expect(requests).toHaveLength(1);
      const messages = requests[0]!;
      expect(findToolTurnValidationIssue(messages)).toBeNull();
      const toolIndex = messages.findIndex(message => message.role === "tool" && message.toolCallId === "read-once");
      const stopIndex = messages.findIndex(message => message.content === marker);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(stopIndex).toBeGreaterThan(toolIndex);
      expect(messages[stopIndex + 1]?.content).toBe(nextPrompt);
      expect(read).toHaveBeenCalledOnce();
    } finally { await session.shutdown(); }
  });

  test("marks a stop during pre-request compaction before any sample", async () => {
    const controller = new AbortController();
    const requests: LLMMessage[][] = [];
    const provider = mkProvider({ content: "both done" }, { onChatStream: messages => requests.push(messages) });
    const { session } = mkSession({ provider });
    setAutoCompactImplForTests(async () => {
      controller.abort("interrupted");
      throw new DOMException("Stopped during compaction", "AbortError");
    });
    try {
      await drain(runTurn(session, mkCtx({ modelInfo: { ...mkCtx().modelInfo, autoCompactTokenLimit: 1 } }),
        essay, { signal: controller.signal }));
      expect(requests).toHaveLength(0);
      setAutoCompactImplForTests(null);
      await drain(runTurn(session, mkCtx({ subId: "next" }), nextPrompt));
      expect(requests).toHaveLength(1);
      await assertWireBoundaries(requests[0]!);
    } finally {
      setAutoCompactImplForTests(null);
      await session.shutdown();
    }
  });

  test.each([false, true])("does not call a deadline a user stop (provider throws=%s)", async throws => {
    const controller = new AbortController();
    const provider = mkProvider();
    const complete = provider.chatStream;
    provider.chatStream = async (messages, emit, options) => {
      const error = new RunDeadlineReachedError(Date.now());
      controller.abort(error);
      if (throws) throw error;
      return complete(messages, emit, options);
    };
    const { session, events } = mkSession({ provider });
    try {
      await drain(runTurn(session, mkCtx(), essay, { signal: controller.signal }));
      expect(events.some(event => event.msg.type === "turn_failed" && event.msg.payload.code === "deadline_reached")).toBe(true);
      expect(session.state.unsafePeek().history.some(message => message.content === marker)).toBe(false);
    } finally { await session.shutdown(); }
  });
});
