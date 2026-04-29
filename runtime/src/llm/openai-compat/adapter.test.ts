import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  LLMAuthenticationError,
  LLMProviderError,
  LLMServerError,
  LLMTimeoutError,
} from "../errors.js";

// ---------------------------------------------------------------------------
// Mock setup — must appear before the import of adapter.js so Vitest's mock
// hoisting applies. The openai mock prevents any real HTTP client from being
// constructed; the filter mock prevents startup network calls.
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockModelsList = vi.fn();

vi.mock("openai", () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    models = { list: mockModelsList };
    constructor(_opts: any) {}
  },
}));

vi.mock("./openai-compat-filter.js", () => ({
  validateOpenAICompatConfig: vi.fn().mockResolvedValue(undefined),
}));

import { OpenAICompatProvider } from "./adapter.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeProvider(
  overrides: Record<string, unknown> = {},
): OpenAICompatProvider {
  return new OpenAICompatProvider({
    model: "test-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "local",
    contextWindowTokens: 4096,
    ...overrides,
  } as any);
}

function makeTool(name: string): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description: `Tool ${name}`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function makeChatResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    choices: [
      {
        message: { role: "assistant", content: "Hello!", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "test-model",
    ...overrides,
  };
}

function makeToolCallResponse(
  toolName: string,
  argsJson: string,
): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "server-call-id-1",
              type: "function",
              function: { name: toolName, arguments: argsJson },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    model: "test-model",
  };
}

const USER_MESSAGE: LLMMessage = { role: "user", content: "Hello" };

// ---------------------------------------------------------------------------
// OpenAICompatProvider
// ---------------------------------------------------------------------------

describe("OpenAICompatProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // chat() — basic response shape
  // -------------------------------------------------------------------------

  describe("chat() — basic response", () => {
    it("sends messages in OpenAI chat format (role + content)", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider();
      await provider.chat([USER_MESSAGE]);

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      const messages = params.messages as Array<{ role: string; content: string }>;
      expect(messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("sets model from config in request params", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ model: "my-local-model" });
      await provider.chat([USER_MESSAGE]);

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.model).toBe("my-local-model");
    });

    it("returns finishReason 'stop' when no tool calls", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider();
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.finishReason).toBe("stop");
    });

    it("returns content from the response message", async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatResponse({ choices: [{ message: { role: "assistant", content: "World!", tool_calls: null }, finish_reason: "stop" }] }),
      );
      const provider = makeProvider();
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.content).toBe("World!");
    });

    it("maps usage fields correctly", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider();
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it("reports model from response", async () => {
      mockCreate.mockResolvedValueOnce(
        makeChatResponse({ model: "server-reported-model" }),
      );
      const provider = makeProvider();
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.model).toBe("server-reported-model");
    });
  });

  // -------------------------------------------------------------------------
  // chat() — tool calls
  // -------------------------------------------------------------------------

  describe("chat() — tool calls", () => {
    it("returns finishReason 'tool_calls' when tool calls are present", async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse("bash", '{"cmd":"ls"}'),
      );
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.finishReason).toBe("tool_calls");
    });

    it("parses tool call name and arguments from response", async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse("bash", '{"cmd":"echo hi"}'),
      );
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("bash");
      expect(result.toolCalls[0].arguments).toBe('{"cmd":"echo hi"}');
    });

    it("assigns UUID IDs to tool calls — never the server-provided id", async () => {
      mockCreate.mockResolvedValueOnce(
        makeToolCallResponse("bash", "{}"),
      );
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.toolCalls[0].id).not.toBe("server-call-id-1");
      expect(result.toolCalls[0].id).toMatch(UUID_RE);
    });

    it("assigns unique UUID IDs when the same tool is called twice in one turn", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "s1", type: "function", function: { name: "bash", arguments: '{"cmd":"a"}' } },
                { id: "s2", type: "function", function: { name: "bash", arguments: '{"cmd":"b"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "test-model",
      });
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chat([USER_MESSAGE]);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].id).toMatch(UUID_RE);
      expect(result.toolCalls[1].id).toMatch(UUID_RE);
      expect(result.toolCalls[0].id).not.toBe(result.toolCalls[1].id);
    });

    it("includes tools array in request params when provider has tools", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const tool = makeTool("bash");
      const provider = makeProvider({ tools: [tool] });
      await provider.chat([USER_MESSAGE]);

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(Array.isArray(params.tools)).toBe(true);
      expect((params.tools as LLMTool[])[0].function.name).toBe("bash");
    });

    it("does not include tools in params when provider has no tools", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider();
      await provider.chat([USER_MESSAGE]);

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.tools).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // chat() — tool routing strategies
  // -------------------------------------------------------------------------

  describe("chat() — tool routing", () => {
    const catalogTools = [makeTool("bash"), makeTool("read_file"), makeTool("write_file")];

    it("all_tools_no_filter: sends all tools when allowedToolNames is undefined", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ tools: catalogTools });
      await provider.chat([USER_MESSAGE]);

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect((params.tools as LLMTool[]).map((t) => t.function.name)).toEqual([
        "bash",
        "read_file",
        "write_file",
      ]);
    });

    it("all_tools_empty_filter: sends empty tools array when allowedToolNames is []", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ tools: catalogTools });
      await provider.chat([USER_MESSAGE], {
        toolRouting: { allowedToolNames: [] },
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.tools).toEqual([]);
    });

    it("subset_exact: sends only the requested tools when all names match", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ tools: catalogTools });
      await provider.chat([USER_MESSAGE], {
        toolRouting: { allowedToolNames: ["bash", "read_file"] },
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect((params.tools as LLMTool[]).map((t) => t.function.name)).toEqual([
        "bash",
        "read_file",
      ]);
    });

    it("subset_partial: sends resolved tools when some requested names are missing from catalog", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ tools: catalogTools });
      await provider.chat([USER_MESSAGE], {
        toolRouting: { allowedToolNames: ["bash", "nonexistent_tool"] },
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect((params.tools as LLMTool[]).map((t) => t.function.name)).toEqual([
        "bash",
      ]);
    });

    it("subset_no_resolved_matches: sends empty tools array when no requested names match catalog", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider({ tools: catalogTools });
      await provider.chat([USER_MESSAGE], {
        toolRouting: { allowedToolNames: ["nonexistent_a", "nonexistent_b"] },
      });

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.tools).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // chat() — error mapping
  // -------------------------------------------------------------------------

  describe("chat() — error mapping", () => {
    it("ECONNREFUSED → LLMProviderError", async () => {
      const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1234"), {
        code: "ECONNREFUSED",
      });
      mockCreate.mockRejectedValue(err);
      await expect(makeProvider().chat([USER_MESSAGE])).rejects.toThrow(LLMProviderError);
    });

    it("ECONNREFUSED error message includes the server URL", async () => {
      const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1234"), {
        code: "ECONNREFUSED",
      });
      mockCreate.mockRejectedValue(err);
      await expect(makeProvider().chat([USER_MESSAGE])).rejects.toThrow(
        "127.0.0.1:1234",
      );
    });

    it("AbortError → LLMTimeoutError", async () => {
      const err = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
      mockCreate.mockRejectedValue(err);
      await expect(makeProvider().chat([USER_MESSAGE])).rejects.toThrow(
        LLMTimeoutError,
      );
    });

    it("HTTP 401 → LLMAuthenticationError", async () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      mockCreate.mockRejectedValue(err);
      await expect(makeProvider().chat([USER_MESSAGE])).rejects.toThrow(
        LLMAuthenticationError,
      );
    });

    it("HTTP 500 → LLMServerError", async () => {
      const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
      mockCreate.mockRejectedValue(err);
      await expect(makeProvider().chat([USER_MESSAGE])).rejects.toThrow(
        LLMServerError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // chat() — per-call timeout override
  // -------------------------------------------------------------------------

  describe("chat() — timeout", () => {
    it("does not throw when timeoutMs option is provided (honored by withTimeout)", async () => {
      mockCreate.mockResolvedValueOnce(makeChatResponse());
      const provider = makeProvider();
      await expect(
        provider.chat([USER_MESSAGE], { timeoutMs: 30_000 }),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // chatStream()
  // -------------------------------------------------------------------------

  describe("chatStream()", () => {
    it("accumulates content chunks and returns full content", async () => {
      async function* makeStream() {
        yield { choices: [{ delta: { content: "Hello" } }], model: "test-model" };
        yield { choices: [{ delta: { content: ", world!" } }], model: "test-model" };
        yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      const chunks: string[] = [];
      const provider = makeProvider();
      const result = await provider.chatStream(
        [USER_MESSAGE],
        (chunk) => { if (chunk.content) chunks.push(chunk.content); },
      );
      expect(chunks).toEqual(["Hello", ", world!"]);
      expect(result.content).toBe("Hello, world!");
    });

    it("calls onChunk with done:true at end", async () => {
      async function* makeStream() {
        yield { choices: [{ delta: { content: "hi" } }], model: "test-model" };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      let finalChunk: { done: boolean; toolCalls?: unknown[] } | undefined;
      const provider = makeProvider();
      await provider.chatStream([USER_MESSAGE], (chunk) => {
        if (chunk.done) finalChunk = chunk;
      });
      expect(finalChunk?.done).toBe(true);
    });

    it("returns finishReason 'stop' when no tool call deltas", async () => {
      async function* makeStream() {
        yield { choices: [{ delta: { content: "ok" } }], model: "test-model" };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      const provider = makeProvider();
      const result = await provider.chatStream([USER_MESSAGE], () => {});
      expect(result.finishReason).toBe("stop");
    });

    it("accumulates tool_call deltas and assigns UUID IDs", async () => {
      async function* makeStream() {
        yield {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"cm' } }] } }],
          model: "test-model",
        };
        yield {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }] } }],
          model: "test-model",
        };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chatStream([USER_MESSAGE], () => {});
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("bash");
      expect(result.toolCalls[0].arguments).toBe('{"cmd":"ls"}');
      expect(result.toolCalls[0].id).toMatch(UUID_RE);
    });

    it("returns finishReason 'tool_calls' when tool call deltas are present", async () => {
      async function* makeStream() {
        yield {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "{}" } }] } }],
          model: "test-model",
        };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      const provider = makeProvider({ tools: [makeTool("bash")] });
      const result = await provider.chatStream([USER_MESSAGE], () => {});
      expect(result.finishReason).toBe("tool_calls");
    });

    it("maps usage from final chunk", async () => {
      async function* makeStream() {
        yield { choices: [{ delta: { content: "hi" } }], model: "test-model" };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        };
      }
      mockCreate.mockResolvedValueOnce(makeStream());
      const provider = makeProvider();
      const result = await provider.chatStream([USER_MESSAGE], () => {});
      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // healthCheck()
  // -------------------------------------------------------------------------

  describe("healthCheck()", () => {
    it("returns true when models.list() succeeds", async () => {
      mockModelsList.mockResolvedValueOnce({ data: [] });
      const provider = makeProvider();
      await expect(provider.healthCheck()).resolves.toBe(true);
    });

    it("returns false when models.list() throws", async () => {
      mockModelsList.mockRejectedValueOnce(new Error("connection refused"));
      const provider = makeProvider();
      await expect(provider.healthCheck()).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getExecutionProfile()
  // -------------------------------------------------------------------------

  describe("getExecutionProfile()", () => {
    it("returns contextWindowTokens from config", async () => {
      const provider = makeProvider({ contextWindowTokens: 32768 });
      const profile = await provider.getExecutionProfile();
      expect(profile.contextWindowTokens).toBe(32768);
    });

    it("reports contextWindowSource as 'explicit_config'", async () => {
      const profile = await makeProvider().getExecutionProfile();
      expect(profile.contextWindowSource).toBe("explicit_config");
    });

    it("returns maxOutputTokens when maxTokens is set in config", async () => {
      const provider = makeProvider({ maxTokens: 4096 });
      const profile = await provider.getExecutionProfile();
      expect(profile.maxOutputTokens).toBe(4096);
    });

    it("returns undefined maxOutputTokens when maxTokens is not set", async () => {
      const profile = await makeProvider().getExecutionProfile();
      expect(profile.maxOutputTokens).toBeUndefined();
    });

    it("reports provider name as 'openai-compat'", async () => {
      const profile = await makeProvider().getExecutionProfile();
      expect(profile.provider).toBe("openai-compat");
    });

    it("reports model from config", async () => {
      const provider = makeProvider({ model: "gemma-4-26b" });
      const profile = await provider.getExecutionProfile();
      expect(profile.model).toBe("gemma-4-26b");
    });
  });
});
