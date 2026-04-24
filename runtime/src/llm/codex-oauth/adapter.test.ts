import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMTool } from "../types.js";

const mockCreate = vi.fn();
const mockOpenAIConstructor = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    responses = { create: mockCreate };

    constructor(opts: any) {
      mockOpenAIConstructor(opts);
    }
  }

  return {
    default: MockOpenAI,
    OpenAI: MockOpenAI,
  };
});

import { CodexOAuthProvider } from "./adapter.js";
import {
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_CODEX_OAUTH_BASE_URL,
} from "./types.js";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(payload)}.sig`;
}

function makeIdToken(input: {
  readonly accountId?: string;
  readonly fedramp?: boolean;
} = {}): string {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
    "https://api.openai.com/auth": {
      chatgpt_account_id: input.accountId ?? "acct-test",
      chatgpt_account_is_fedramp: input.fedramp === true,
    },
  });
}

async function writeCodexAuth(
  codexHome: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "auth.json"),
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          id_token: makeIdToken({ accountId: "acct-test" }),
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "acct-test",
        },
        last_refresh: new Date().toISOString(),
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

function makeTool(
  name: string,
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      input: { type: "string" },
    },
  },
): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description: `Tool ${name}`,
      parameters,
    },
  };
}

function makeCompletion(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: "completed",
    output_text: "Hello from Codex",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello from Codex" }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    model: "gpt-5.4",
    ...overrides,
  };
}

async function* makeStream(...events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

function makeCompletionStream(overrides: Record<string, unknown> = {}): unknown {
  return makeStream({
    type: "response.completed",
    response: makeCompletion(overrides),
  });
}

describe("CodexOAuthProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Codex OAuth credentials to call the Responses API", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agenc-codex-auth-"));
    await writeCodexAuth(codexHome);
    mockCreate.mockResolvedValueOnce(makeCompletionStream());

    const provider = new CodexOAuthProvider({
      model: "gpt-5.4",
      codexHome,
      tools: [makeTool("system.echo")],
    });
    const result = await provider.chat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);

    expect(mockOpenAIConstructor).toHaveBeenCalledOnce();
    expect(mockOpenAIConstructor.mock.calls[0][0]).toMatchObject({
      apiKey: "access-token",
      baseURL: DEFAULT_CODEX_OAUTH_BASE_URL,
      defaultHeaders: {
        "ChatGPT-Account-ID": "acct-test",
        version: DEFAULT_CODEX_CLIENT_VERSION,
      },
    });
    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are helpful.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tools: [
        {
          type: "function",
          description: "Tool system.echo",
        },
      ],
      tool_choice: "auto",
      store: false,
      stream: true,
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
    });
    expect(
      ((params.tools as Array<Record<string, unknown>>)[0]?.name as string) ?? "",
    ).toMatch(/^system_echo_[a-f0-9]{10}$/);
    expect(params.prompt_cache_key).toEqual(expect.any(String));
    expect(params.client_metadata).toMatchObject({
      "x-codex-installation-id": expect.any(String),
    });
    expect(result.content).toBe("Hello from Codex");
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
    });
  });

  it("refreshes stale Codex OAuth tokens and persists the updated auth file", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agenc-codex-auth-"));
    await writeCodexAuth(codexHome, {
      tokens: {
        id_token: makeIdToken({ accountId: "acct-old" }),
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refresh_token: "refresh-token-old",
        account_id: "acct-old",
      },
      last_refresh: "2020-01-01T00:00:00.000Z",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id_token: makeIdToken({ accountId: "acct-new", fedramp: true }),
        access_token: "access-token-new",
        refresh_token: "refresh-token-new",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    mockCreate.mockResolvedValueOnce(makeCompletionStream());

    const provider = new CodexOAuthProvider({
      model: "gpt-5.4",
      codexHome,
      refreshTokenUrl: "https://auth.test/oauth/token",
    });
    await provider.chat([{ role: "user", content: "Hello" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://auth.test/oauth/token");
    const refreshBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as { body?: unknown }).body),
    ) as Record<string, unknown>;
    expect(refreshBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-token-old",
    });
    expect(mockOpenAIConstructor.mock.calls[0][0]).toMatchObject({
      apiKey: "access-token-new",
      defaultHeaders: {
        "ChatGPT-Account-ID": "acct-new",
        "X-OpenAI-Fedramp": "true",
      },
    });

    const storedAuth = JSON.parse(
      await readFile(join(codexHome, "auth.json"), "utf8"),
    ) as Record<string, any>;
    expect(storedAuth.tokens.access_token).toBe("access-token-new");
    expect(storedAuth.tokens.refresh_token).toBe("refresh-token-new");
    expect(storedAuth.tokens.account_id).toBe("acct-new");
    expect(typeof storedAuth.last_refresh).toBe("string");
  });

  it("parses Responses API function calls using the provider call_id", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agenc-codex-auth-"));
    await writeCodexAuth(codexHome);
    mockCreate.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const providerToolName = String(
        (params.tools as Array<Record<string, unknown>>)[0]?.name ?? "",
      );
      return makeCompletionStream({
        output_text: "",
        output: [
          {
            type: "function_call",
            call_id: "call_123",
            name: providerToolName,
            arguments: '{"input":"hi"}',
          },
        ],
      });
    });

    const provider = new CodexOAuthProvider({
      model: "gpt-5.4",
      codexHome,
      tools: [makeTool("system.echo")],
    });
    const result = await provider.chat([{ role: "user", content: "Call tool" }]);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_123",
        name: "system.echo",
        arguments: '{"input":"hi"}',
      },
    ]);
  });

  it("normalizes nested array schemas before sending tools to Codex", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agenc-codex-auth-"));
    await writeCodexAuth(codexHome);
    mockCreate.mockResolvedValueOnce(makeCompletionStream());
    const originalParameters: Record<string, any> = {
      type: "object",
      properties: {
        constraints: {
          anyOf: [
            { type: "object" },
            { type: "array" },
            { type: "string" },
          ],
        },
        nullableArray: {
          type: ["array", "null"],
        },
        stringList: {
          type: "array",
          items: { type: "string" },
        },
        nestedArray: {
          type: "array",
          items: { type: "array" },
        },
        literalChoice: {
          enum: ["fast", "safe"],
        },
      },
    };

    const provider = new CodexOAuthProvider({
      model: "gpt-5.4",
      codexHome,
      tools: [makeTool("agenc.createTask", originalParameters)],
    });

    await provider.chat([{ role: "user", content: "Create a task" }]);

    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tool = (params.tools as Array<Record<string, unknown>>)[0];
    const parameters = tool?.parameters as Record<string, any>;
    expect(parameters.properties.constraints.anyOf[1]).toEqual({
      type: "array",
      items: {},
    });
    expect(parameters.properties.nullableArray).toEqual({
      type: ["array", "null"],
      items: {},
    });
    expect(parameters.properties.stringList).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(parameters.properties.nestedArray).toEqual({
      type: "array",
      items: { type: "array", items: {} },
    });
    expect(parameters.properties.literalChoice).toEqual({
      enum: ["fast", "safe"],
    });
    expect(originalParameters.properties.constraints.anyOf[1]).toEqual({
      type: "array",
    });
    expect(originalParameters.properties.nullableArray).toEqual({
      type: ["array", "null"],
    });
    expect(originalParameters.properties.nestedArray).toEqual({
      type: "array",
      items: { type: "array" },
    });
  });

  it("treats timeoutMs=0 as unlimited", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agenc-codex-auth-"));
    await writeCodexAuth(codexHome);
    mockCreate.mockResolvedValueOnce(makeCompletionStream());

    const provider = new CodexOAuthProvider({
      model: "gpt-5.4",
      codexHome,
      timeoutMs: 0,
    });
    await provider.chat([{ role: "user", content: "Hello" }]);

    expect(mockOpenAIConstructor.mock.calls[0][0].timeout).toBeUndefined();
  });
});
