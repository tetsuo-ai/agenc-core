import { describe, expect, test, vi } from "vitest";

import { createTokenAccountingRequest } from "../../token-accounting.js";
import type { LLMMessage, LLMTool } from "../../types.js";
import { createGeminiEndpointPlan } from "./endpoint-plan.js";
import { GeminiProvider } from "./index.js";
import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from "../../../../src/contracts/agent-invocation-envelope.js";

function invocationMessages() {
  return materializeAgentInvocationMessages(
    createCsvAgentInvocationEnvelope({
      jobId: "gemini-job",
      itemId: "gemini-item",
      rowIndex: 0,
      rowSha256: `sha256:${"b".repeat(64)}`,
      instruction: "GEMINI_TASK_MARKER",
      row: { payload: "GEMINI_DATA_MARKER" },
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const echoTool: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

function apiKeyCredentialPlan(credential = "gemini-test") {
  return {
    kind: "api-key" as const,
    credential,
    source: "factory" as const,
  };
}

function missingCredentialPlan(
  expected: "api-key" | "access-token" | "adc" | "any" = "any",
) {
  return expected === "any"
    ? ({ kind: "none", mode: "auto", expected: "any" } as const)
    : ({ kind: "none", mode: expected, expected } as const);
}

const developerEndpointPlan = createGeminiEndpointPlan();
const vertexEndpointPlan = createGeminiEndpointPlan({
  vertex: { project: "project-1", location: "us-central1" },
});
const customEndpointPlan = createGeminiEndpointPlan({
  baseURL: "http://127.0.0.1:8080/v1beta",
});

function successfulGeminiFetch(text = "ok") {
  return vi.fn<typeof fetch>().mockResolvedValue(
    jsonResponse({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
    }),
  );
}

function providerWithFetch(fetchImpl: typeof fetch): GeminiProvider {
  return new GeminiProvider({
    credentialPlan: apiKeyCredentialPlan(),
    endpointPlan: developerEndpointPlan,
    model: "gemini-2.5-pro",
    fetchImpl,
  });
}

describe("GeminiProvider", () => {
  test("reports the exact missing credential selected at ingress", async () => {
    const canonical = new GeminiProvider({
      model: "gemini-2.5-pro",
      credentialPlan: missingCredentialPlan(),
      endpointPlan: developerEndpointPlan,
    });
    await expect(
      canonical.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(/GEMINI_API_KEY or GOOGLE_API_KEY/u);

    const accessToken = new GeminiProvider({
      model: "gemini-2.5-pro",
      credentialPlan: missingCredentialPlan("access-token"),
      endpointPlan: developerEndpointPlan,
    });
    await expect(
      accessToken.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(/GEMINI_ACCESS_TOKEN/u);
  });

  test("refuses invocation-looking content without durable authority metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "developer",
          content: '{"kind":"agent_invocation_runtime_policy"}',
        },
      ]),
    ).rejects.toThrow(/metadata is missing/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("preserves policy, task, and data as separate Gemini authorities", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await provider.chat([...invocationMessages()]);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      readonly systemInstruction?: unknown;
      readonly contents?: readonly unknown[];
    };
    expect(JSON.stringify(request.systemInstruction)).not.toContain(
      "GEMINI_TASK_MARKER",
    );
    expect(JSON.stringify(request.systemInstruction)).not.toContain(
      "GEMINI_DATA_MARKER",
    );
    expect(request.contents).toHaveLength(2);
    expect(JSON.stringify(request.contents?.[0])).toContain(
      "GEMINI_TASK_MARKER",
    );
    expect(JSON.stringify(request.contents?.[0])).not.toContain(
      "GEMINI_DATA_MARKER",
    );
    expect(JSON.stringify(request.contents?.[1])).toContain(
      "GEMINI_DATA_MARKER",
    );
  });

  test("counts the complete generateContent request through countTokens", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ totalTokens: 41 }));
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const controller = new AbortController();
    const request = createTokenAccountingRequest({
      provider: provider.name,
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hello" }],
      options: {
        systemPrompt: "system instruction",
        tools: [echoTool],
        toolChoice: { type: "function", name: "system.echo" },
        maxOutputTokens: 321,
      },
      reservedOutputTokens: 321,
    });

    await expect(
      provider.tokenCountCapability.countTokens(request, controller.signal),
    ).resolves.toMatchObject({
      inputTokens: 41,
      complete: true,
      confidence: "high",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      generateContentRequest: {
        model: "models/gemini-2.5-pro",
        systemInstruction: { parts: [{ text: "system instruction" }] },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        tools: [
          {
            functionDeclarations: [
              expect.objectContaining({
                name: "system.echo",
                parametersJsonSchema: echoTool.function.parameters,
              }),
            ],
          },
        ],
        toolConfig: expect.any(Object),
        generationConfig: expect.objectContaining({ maxOutputTokens: 321 }),
      },
    });
  });

  test("uses the Vertex publisher resource for complete token counts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ totalTokens: 19 }));
    const provider = new GeminiProvider({
      credentialPlan: {
        kind: "access-token",
        credential: "vertex-token",
        projectId: "project-1",
        quotaProjectId: "billing-project",
        source: "GEMINI_ACCESS_TOKEN",
      },
      endpointPlan: vertexEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const request = createTokenAccountingRequest({
      provider: provider.name,
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hello" }],
      options: {},
      reservedOutputTokens: 0,
    });

    await provider.tokenCountCapability.countTokens(
      request,
      new AbortController().signal,
    );
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:countTokens",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: expect.any(Object),
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty(
      "generateContentRequest",
    );
  });

  test("single-wire chat performs exactly one transport attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "temporarily down" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }], {
        singleWireAttempt: true,
      }),
    ).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("single-wire stream hands fallback outward without an internal retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
      providerFallback: {
        provider: "gemini",
        model: "gemini-2.5-pro",
        targets: [{ provider: "grok", model: "grok-4-fast" }],
      },
    });

    await expect(
      provider.chatStream([{ role: "user", content: "hello" }], () => {}, {
        singleWireAttempt: true,
      }),
    ).rejects.toMatchObject({ name: "FallbackTriggeredError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("uses native generateContent with canonical model and API-key auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "ok" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
        },
      }),
    );

    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini:models/gemini-2.5-pro",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }], {
      temperature: 0.25,
      stopSequences: ["END"],
    });

    expect(response.content).toBe("ok");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    expect(headers.get("authorization")).toBeNull();
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.25,
        stopSequences: ["END"],
      },
    });
    expect("model" in requestBody).toBe(false);
    expect("store" in requestBody).toBe(false);
  });

  test("defaults a malformed document MIME type without object stringification", async () => {
    const fetchImpl = successfulGeminiFetch();
    const provider = providerWithFetch(fetchImpl);
    const message = {
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: { invalid: true },
            data: "JVBERi0xLjQ=",
          },
        },
      ],
    } as unknown as LLMMessage;

    await provider.chat([message]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: "JVBERi0xLjQ=",
              },
            },
          ],
        },
      ],
    });
  });

  test("materializes the selected bearer plan with its quota project", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "bearer" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );

    const provider = new GeminiProvider({
      model: "gemini-2.5-pro",
      fetchImpl,
      credentialPlan: {
        kind: "access-token",
        credential: "ya29-token",
        projectId: "project-1",
        quotaProjectId: "billing-project",
        source: "GEMINI_ACCESS_TOKEN",
      },
      endpointPlan: developerEndpointPlan,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("bearer");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer ya29-token");
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(headers.get("x-goog-user-project")).toBe("billing-project");
  });

  test("uses Vertex Gemini publisher paths with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "vertex" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      model: "gemini-2.5-pro",
      credentialPlan: {
        kind: "access-token",
        credential: "vertex-token",
        projectId: "project-1",
        quotaProjectId: "billing-project",
        source: "GEMINI_ACCESS_TOKEN",
      },
      endpointPlan: vertexEndpointPlan,
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("vertex");
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer vertex-token");
    expect(headers.get("x-goog-user-project")).toBe("billing-project");
  });

  test("does not reinterpret retired OAuth-shaped fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "oauth" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      authMode: "oauth",
      oauth: { accessToken: "oauth-token" },
      model: "gemini-2.5-pro",
      fetchImpl,
    } as unknown as ConstructorParameters<typeof GeminiProvider>[0]);

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("oauth");
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
  });

  test("sends tools as Gemini function declarations and parses function calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "system.echo",
                    args: { text: "hi" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
        },
      }),
    );

    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "call echo" }],
      { tools: [echoTool] },
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "gemini_call_0", name: "system.echo", arguments: '{"text":"hi"}' },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
      availability: "reported",
      provenance: "provider",
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "system.echo",
            description: "Echo text",
            parametersJsonSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
  });

  test("preserves nullable and nested JSON Schema types for Gemini tools", async () => {
    const taskUpdateTool: LLMTool = {
      type: "function",
      function: {
        name: "TaskUpdate",
        description: "Update a durable AgenC task",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            owner: { type: ["string", "null"] },
            deletedValue: { type: ["null"] },
            explicitNull: { type: "null" },
            entries: {
              type: ["array", "null"],
              items: {
                type: ["object", "null"],
                properties: {
                  label: { type: "string" },
                },
                required: ["label"],
              },
            },
            target: {
              type: ["object", "null"],
              properties: {
                kind: { type: "string" },
              },
              required: ["kind"],
              anyOf: [
                { type: "object", properties: { kind: { type: "string" } } },
                { type: "object", properties: { id: { type: "integer" } } },
              ],
            },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
      },
    };
    const fetchImpl = successfulGeminiFetch();
    const provider = providerWithFetch(fetchImpl);

    await provider.chat([{ role: "user", content: "update task" }], {
      tools: [taskUpdateTool],
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "TaskUpdate",
            description: "Update a durable AgenC task",
            parametersJsonSchema: taskUpdateTool.function.parameters,
          },
        ],
      },
    ]);
  });

  test("compiles default-tool anyOf unions that omit a parent type", async () => {
    const fileReadTool: LLMTool = {
      type: "function",
      function: {
        name: "FileRead",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            offset: {
              anyOf: [
                { type: "number" },
                { type: "string", pattern: "^[1-9]\\d*$" },
              ],
              description: "Optional. Line number to start from.",
            },
            limit: {
              anyOf: [
                { type: "number" },
                { type: "string", pattern: "^[1-9]\\d*$" },
              ],
            },
          },
          required: ["file_path"],
        },
      },
    };
    const searchToolsTool: LLMTool = {
      type: "function",
      function: {
        name: "system.searchTools",
        description: "Search the tool catalog",
        parameters: {
          type: "object",
          properties: {
            select: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
        },
      },
    };
    const fetchImpl = successfulGeminiFetch();
    const provider = providerWithFetch(fetchImpl);

    await provider.chat([{ role: "user", content: "read file" }], {
      tools: [fileReadTool, searchToolsTool],
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    const declarations = (
      requestBody.tools as readonly Record<string, unknown>[]
    )[0]?.functionDeclarations as readonly Record<string, unknown>[];
    const fileRead = declarations.find((tool) => tool.name === "FileRead");
    const searchTools = declarations.find(
      (tool) => tool.name === "system.searchTools",
    );
    const fileReadParams = fileRead?.parametersJsonSchema as {
      readonly properties: {
        readonly offset: Record<string, unknown>;
        readonly limit: Record<string, unknown>;
      };
    };
    const searchParams = searchTools?.parametersJsonSchema as {
      readonly properties: { readonly select: Record<string, unknown> };
    };
    expect(fileReadParams.properties.offset).toEqual({
      description: "Optional. Line number to start from.",
      anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }],
    });
    expect(fileReadParams.properties.limit).toEqual({
      anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }],
    });
    expect(searchParams.properties.select).toEqual({
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    });
  });

  test("passes refs and surrounding tool JSON Schema through without rewriting", async () => {
    const repeated = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `entry${index}`,
        { $ref: "#/$defs/Entry" },
      ]),
    );
    const schema = {
      type: "object",
      properties: {
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }],
        },
        firstTupleEntry: { $ref: "#/properties/tuple/prefixItems/0" },
        displayName: { $ref: "#/%24defs/Display%20Name" },
        recursiveNode: { $ref: "#/$defs/Node" },
        labeledEntry: {
          $ref: "#/$defs/Entry",
          description: "An entry with a conjunctive annotation sibling",
        },
        exclusive: {
          oneOf: [{ type: "number" }, { minimum: 0 }],
        },
        ...repeated,
      },
      $defs: {
        Entry: { type: "integer" },
        "Display Name": { type: "string" },
        Node: {
          type: "object",
          properties: {
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
    };
    const fetchImpl = successfulGeminiFetch();
    const provider = providerWithFetch(fetchImpl);

    await provider.chat([{ role: "user", content: "search" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "mcp.search",
            description: "Search a referenced schema",
            parameters: schema,
          },
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      readonly tools: readonly [
        {
          readonly functionDeclarations: readonly [Record<string, unknown>];
        },
      ];
    };
    const declaration = requestBody.tools[0].functionDeclarations[0];
    expect(declaration?.parametersJsonSchema).toEqual(schema);
    expect(declaration).not.toHaveProperty("parameters");
  });

  test.each([
    {
      label: "a local root reference",
      schema: {
        $ref: "#/$defs/Args",
        $defs: {
          Args: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
    },
    {
      label: "an embedded-resource root reference",
      schema: {
        $id: "https://example.test/tool-root.json",
        $ref: "args.json",
        $defs: {
          Args: {
            $id: "args.json",
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
    },
    {
      label: "an all-object anyOf",
      schema: {
        anyOf: [
          { type: "object", properties: { text: { type: "string" } } },
          { $ref: "#/$defs/Args" },
        ],
        $defs: { Args: { type: "object", additionalProperties: false } },
      },
    },
    {
      label: "an all-object oneOf",
      schema: {
        oneOf: [
          { type: "object", properties: { text: { type: "string" } } },
          { $ref: "#/$defs/Args" },
        ],
        $defs: { Args: { type: "object", additionalProperties: false } },
      },
    },
  ])("preserves $label tool root", async ({ schema }) => {
    const fetchImpl = successfulGeminiFetch();
    const provider = providerWithFetch(fetchImpl);

    await provider.chat([{ role: "user", content: "run tool" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "rooted_tool",
            description: "Exercise a referenced object root",
            parameters: schema,
          },
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      readonly tools: readonly [
        {
          readonly functionDeclarations: readonly [Record<string, unknown>];
        },
      ];
    };
    expect(
      requestBody.tools[0].functionDeclarations[0]?.parametersJsonSchema,
    ).toEqual(schema);
  });

  test.each([
    { label: "an array", schema: { type: "array", items: { type: "string" } } },
    { label: "a scalar", schema: { type: "string" } },
    { label: "a nullable object", schema: { type: ["object", "null"] } },
    { label: "an unconstrained schema", schema: {} },
    {
      label: "a mixed-object union",
      schema: { anyOf: [{ type: "object" }, { type: "string" }] },
    },
    {
      label: "a contradictory allOf",
      schema: { allOf: [{ type: "object" }, { type: "string" }] },
    },
    {
      label: "an object sibling beside a scalar root reference",
      schema: {
        type: "object",
        $ref: "#/$defs/Scalar",
        $defs: { Scalar: { type: "string" } },
      },
    },
    {
      label: "an unresolved root reference",
      schema: { $ref: "#/$defs/Missing" },
    },
    {
      label: "an external root reference",
      schema: { $ref: "https://example.test/external.json" },
    },
  ])("rejects $label tool root before dispatch", async ({ schema }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "run tool" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "invalid_root",
              description: "Invalid root",
              parameters: schema,
            },
          },
        ],
      }),
    ).rejects.toThrow('tools["invalid_root"].parameters');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["chat", "stream", "count"] as const)(
    "validates tool roots before %s dispatch",
    async (operation) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = providerWithFetch(fetchImpl);
      const tools: LLMTool[] = [
        {
          type: "function",
          function: {
            name: "invalid_root",
            description: "Invalid root",
            parameters: { type: "array", items: { type: "string" } },
          },
        },
      ];
      const options = { tools };

      let invocation: Promise<unknown>;
      switch (operation) {
        case "chat":
          invocation = provider.chat(
            [{ role: "user", content: "run tool" }],
            options,
          );
          break;
        case "stream":
          invocation = provider.chatStream(
            [{ role: "user", content: "run tool" }],
            () => {},
            options,
          );
          break;
        case "count":
          invocation = provider.tokenCountCapability.countTokens(
            createTokenAccountingRequest({
              provider: provider.name,
              model: "gemini-2.5-pro",
              messages: [{ role: "user", content: "run tool" }],
              options,
              reservedOutputTokens: 0,
            }),
            new AbortController().signal,
          );
          break;
      }

      await expect(invocation).rejects.toThrow(
        'tools["invalid_root"].parameters',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([
    { label: "Developer v1beta", endpointPlan: developerEndpointPlan },
    { label: "Vertex v1", endpointPlan: vertexEndpointPlan },
    { label: "a custom native endpoint", endpointPlan: customEndpointPlan },
  ])("uses native JSON Schema fields for $label", async ({ endpointPlan }) => {
    const fetchImpl = successfulGeminiFetch('{"answer":null}');
    const credentialPlan =
      endpointPlan.kind === "vertex"
        ? ({
            kind: "access-token",
            credential: "vertex-token",
            projectId: "project-1",
            source: "GEMINI_ACCESS_TOKEN",
          } as const)
        : apiKeyCredentialPlan();
    const provider = new GeminiProvider({
      credentialPlan,
      endpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const responseSchema = {
      $ref: "#/$defs/Answer",
      $defs: {
        Answer: {
          type: "object",
          properties: { answer: { type: ["string", "null"] } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    };

    await provider.chat([{ role: "user", content: "answer" }], {
      tools: [echoTool],
      structuredOutput: {
        enabled: true,
        schema: {
          type: "json_schema",
          name: "answer",
          schema: responseSchema,
        },
      },
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      readonly tools: readonly [
        {
          readonly functionDeclarations: readonly [Record<string, unknown>];
        },
      ];
      readonly generationConfig: Record<string, unknown>;
    };
    const declaration = requestBody.tools[0].functionDeclarations[0];
    expect(declaration?.parametersJsonSchema).toEqual(
      echoTool.function.parameters,
    );
    expect(declaration).not.toHaveProperty("parameters");
    expect(requestBody.generationConfig.responseJsonSchema).toEqual(
      responseSchema,
    );
    expect(requestBody.generationConfig).not.toHaveProperty("responseSchema");
  });

  test("rejects a response $ref sibling instead of shallow-merging it", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: {
                name: {
                  $ref: "#/$defs/Name",
                  description: "Display name",
                },
              },
              $defs: { Name: { type: "string" } },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'structuredOutput["answer"].schema.properties.name.description: Gemini does not allow non-$ siblings beside $ref',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects structured-output oneOf before provider dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              oneOf: [{ type: "number" }, { minimum: 0 }],
            },
          },
        },
      }),
    ).rejects.toThrow(
      'structuredOutput["answer"].schema.oneOf: Gemini interprets oneOf as anyOf',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("preserves the supported response schema surface and optional recursion", async () => {
    const fetchImpl = successfulGeminiFetch('{"choice":"yes"}');
    const provider = providerWithFetch(fetchImpl);
    const responseSchema = {
      $id: "https://example.test/schemas/answer",
      $anchor: "Answer",
      type: "object",
      title: "Answer envelope",
      description: "A schema that exercises Gemini's documented subset.",
      properties: {
        choice: {
          anyOf: [
            { enum: ["yes", "no"] },
            { type: "number", minimum: 0, maximum: 1 },
          ],
        },
        values: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          prefixItems: [{ type: "string", format: "date-time" }],
          items: { type: ["integer", "null"] },
        },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        escaped: { $ref: "#/$defs/a~1b~0c" },
        percentEncoded: { $ref: "#/%24defs/Display%20Name" },
        anchored: { $ref: "#Answer" },
        recursive: { $ref: "#/$defs/Node" },
      },
      required: ["choice", "values"],
      propertyOrdering: [
        "choice",
        "values",
        "labels",
        "escaped",
        "percentEncoded",
        "anchored",
        "recursive",
      ],
      additionalProperties: false,
      $defs: {
        "a/b~c": { type: "string" },
        "Display Name": { type: "string" },
        Node: {
          type: "object",
          properties: {
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
    };

    await provider.chat([{ role: "user", content: "answer" }], {
      structuredOutput: {
        enabled: true,
        schema: {
          type: "json_schema",
          name: "answer",
          schema: responseSchema,
        },
      },
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      generationConfig: Record<string, unknown>;
    };
    expect(requestBody.generationConfig.responseJsonSchema).toEqual(
      responseSchema,
    );
  });

  test("resolves references and anchors within embedded schema resources", async () => {
    const fetchImpl = successfulGeminiFetch('{"node":{"value":"ok"}}');
    const provider = providerWithFetch(fetchImpl);
    const responseSchema = {
      $id: "https://example.test/root.json",
      $anchor: "Shared",
      type: "object",
      properties: {
        node: { $ref: "node.json" },
        value: { $ref: "node.json#/$defs/Value" },
      },
      $defs: {
        Node: {
          $id: "node.json",
          $anchor: "Shared",
          type: "object",
          properties: {
            value: { $ref: "#/$defs/Value" },
            child: { $ref: "#Shared" },
          },
          $defs: { Value: { type: "string" } },
        },
      },
    };

    await provider.chat([{ role: "user", content: "answer" }], {
      structuredOutput: {
        enabled: true,
        schema: { type: "json_schema", name: "answer", schema: responseSchema },
      },
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      readonly generationConfig: Record<string, unknown>;
    };
    expect(requestBody.generationConfig.responseJsonSchema).toEqual(
      responseSchema,
    );
  });

  test("rejects a required cycle inside an embedded schema resource", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              $id: "https://example.test/root.json",
              $ref: "node.json",
              $defs: {
                Node: {
                  $id: "node.json",
                  $anchor: "Node",
                  type: "object",
                  properties: { child: { $ref: "#Node" } },
                  required: ["child"],
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'schema.$defs.Node.properties.child.$ref: cyclic $ref is inside required property "child"',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "a non-empty $id fragment",
      schema: {
        $id: "https://example.test/root.json#fragment",
        type: "object",
      },
      message: "must not contain a non-empty fragment",
    },
    {
      label: "an invalid $id URI-reference",
      schema: { $id: "http://[", type: "object" },
      message: "expected a valid URI-reference",
    },
  ])("rejects $label before dispatch", async ({ schema, message }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: { type: "json_schema", name: "answer", schema },
        },
      }),
    ).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    { keyword: "allOf", schema: { allOf: [{ type: "string" }] } },
    {
      keyword: "definitions",
      schema: { definitions: { Value: { type: "string" } } },
    },
    {
      keyword: "dependentSchemas",
      schema: { dependentSchemas: { value: { type: "string" } } },
    },
    {
      keyword: "patternProperties",
      schema: { patternProperties: { "^value": { type: "string" } } },
    },
    { keyword: "contains", schema: { contains: { type: "string" } } },
    { keyword: "if", schema: { if: { type: "string" } } },
    { keyword: "then", schema: { then: { type: "string" } } },
    { keyword: "else", schema: { else: { type: "string" } } },
    { keyword: "not", schema: { not: { type: "string" } } },
    {
      keyword: "propertyNames",
      schema: { propertyNames: { type: "string" } },
    },
    {
      keyword: "unevaluatedProperties",
      schema: { unevaluatedProperties: false },
    },
    { keyword: "const", schema: { const: "fixed" } },
    { keyword: "pattern", schema: { type: "string", pattern: "^fixed$" } },
    { keyword: "minLength", schema: { type: "string", minLength: 1 } },
  ])(
    "rejects unsupported response keyword $keyword before dispatch",
    async ({ keyword, schema }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = providerWithFetch(fetchImpl);

      await expect(
        provider.chat([{ role: "user", content: "answer" }], {
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "answer",
              schema,
            },
          },
        }),
      ).rejects.toThrow(
        `structuredOutput["answer"].schema.${keyword}: keyword "${keyword}" is not supported`,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      location: "$defs",
      schema: { $defs: { Value: { const: "fixed" } } },
      path: "$defs.Value.const",
    },
    {
      location: "properties",
      schema: { properties: { value: { pattern: "^fixed$" } } },
      path: "properties.value.pattern",
    },
    {
      location: "items",
      schema: { type: "array", items: { minLength: 1 } },
      path: "items.minLength",
    },
    {
      location: "prefixItems",
      schema: { prefixItems: [{ not: { type: "null" } }] },
      path: "prefixItems[0].not",
    },
    {
      location: "anyOf",
      schema: { anyOf: [{ allOf: [{ type: "string" }] }] },
      path: "anyOf[0].allOf",
    },
  ])(
    "reports the full path for unsupported keywords below $location",
    async ({ schema, path }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = providerWithFetch(fetchImpl);

      await expect(
        provider.chat([{ role: "user", content: "answer" }], {
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "answer",
              schema,
            },
          },
        }),
      ).rejects.toThrow(`structuredOutput["answer"].schema.${path}`);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("rejects a recursive reference inside a required property", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              $ref: "#/$defs/Node",
              $defs: {
                Node: {
                  type: "object",
                  properties: {
                    child: { $ref: "#/$defs/Node" },
                  },
                  required: ["child"],
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'schema.$defs.Node.properties.child.$ref: cyclic $ref is inside required property "child"',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "unresolved local pointer",
      reference: "#/$defs/Missing",
      message: "does not resolve JSON Pointer",
    },
    {
      label: "schema container pointer",
      reference: "#/properties",
      message: "identifies a schema container, not a schema object",
    },
    {
      label: "remote reference",
      reference: "https://example.test/schema.json#/$defs/Value",
      message: "remote references are not supported",
    },
  ])("rejects $label", async ({ reference, message }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = providerWithFetch(fetchImpl);

    await expect(
      provider.chat([{ role: "user", content: "answer" }], {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { value: { $ref: reference } },
            },
          },
        },
      }),
    ).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["chat", "stream", "count"] as const)(
    "validates response schemas before %s dispatch",
    async (operation) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = providerWithFetch(fetchImpl);
      const options = {
        structuredOutput: {
          enabled: true,
          schema: {
            type: "json_schema" as const,
            name: "answer",
            schema: { type: "string", const: "fixed" },
          },
        },
      };

      const invocation =
        operation === "chat"
          ? provider.chat([{ role: "user", content: "answer" }], options)
          : operation === "stream"
            ? provider.chatStream(
                [{ role: "user", content: "answer" }],
                () => {},
                options,
              )
            : provider.tokenCountCapability.countTokens(
                createTokenAccountingRequest({
                  provider: provider.name,
                  model: "gemini-2.5-pro",
                  messages: [{ role: "user", content: "answer" }],
                  options,
                  reservedOutputTokens: 0,
                }),
                new AbortController().signal,
              );

      await expect(invocation).rejects.toThrow(
        'structuredOutput["answer"].schema.const',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([
    { label: "Developer v1beta", endpointPlan: developerEndpointPlan },
    { label: "Vertex v1", endpointPlan: vertexEndpointPlan },
    { label: "a custom native endpoint", endpointPlan: customEndpointPlan },
  ])(
    "uses fail-closed response schema capabilities for $label",
    async ({ endpointPlan }) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const credentialPlan =
        endpointPlan.kind === "vertex"
          ? ({
              kind: "access-token",
              credential: "vertex-token",
              projectId: "project-1",
              source: "GEMINI_ACCESS_TOKEN",
            } as const)
          : apiKeyCredentialPlan();
      const provider = new GeminiProvider({
        credentialPlan,
        endpointPlan,
        model: "unrecognized-model-family",
        fetchImpl,
      });

      await expect(
        provider.chat([{ role: "user", content: "answer" }], {
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "answer",
              schema: { type: "string", minLength: 1 },
            },
          },
        }),
      ).rejects.toThrow('structuredOutput["answer"].schema.minLength');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("streams Gemini text, function calls, and usage from streamGenerateContent", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hi "}]},"finishReason":"STOP"}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"there"},{"functionCall":{"name":"system.echo","args":{"text":"hi"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,"totalTokenCount":11}}\n\n',
        ]),
      );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });
    const chunks: unknown[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "call echo" }],
      (chunk) => chunks.push(chunk),
      { tools: [echoTool] },
    );

    expect(chunks).toEqual([
      { content: "Hi ", done: false },
      { content: "there", done: false },
      {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: "gemini_call_0",
          index: 0,
          contentBlock: {
            type: "tool_use",
            id: "gemini_call_0",
            name: "system.echo",
            input: { text: "hi" },
          },
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "gemini_call_0",
          index: 0,
          partialJson: '{"text":"hi"}',
        },
      },
      {
        content: "",
        done: true,
        toolCalls: [
          {
            id: "gemini_call_0",
            name: "system.echo",
            arguments: '{"text":"hi"}',
          },
        ],
      },
    ]);
    expect(response.content).toBe("Hi there");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "gemini_call_0", name: "system.echo", arguments: '{"text":"hi"}' },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 7,
      completionTokens: 4,
      totalTokens: 11,
      availability: "reported",
      provenance: "provider",
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.tools).toBeDefined();
    expect("stream" in requestBody).toBe(false);
    expect("stream_options" in requestBody).toBe(false);
  });

  test("uses cachedContents prompt-cache hints and maps cached usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "cached" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 2,
          totalTokenCount: 22,
          cachedContentTokenCount: 16,
        },
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      cachedContent: "cachedContents/project-context",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.usage.cachedInputTokens).toBe(16);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.cachedContent).toBe("cachedContents/project-context");
  });

  test("uses request prompt-cache hints before configured cachedContents", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "request cache" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      cachedContent: "cachedContents/project-context",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      promptCacheKey: "cachedContents/request-context",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.cachedContent).toBe("cachedContents/request-context");
  });

  test("preserves Gemini thought signatures through history and response thinking", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  thought: true,
                  text: "reasoning",
                  thoughtSignature: "sig-2",
                },
                { text: "done" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          totalTokenCount: 6,
          thoughtsTokenCount: 1,
        },
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    const response = await provider.chat([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "previous reasoning",
            signature: "sig-1",
          },
          { type: "text", text: "previous answer" },
        ] as never,
      },
      { role: "user", content: "continue" },
    ]);

    expect(response.thinking).toEqual([
      {
        text: "reasoning",
        redacted: false,
        signature: "sig-2",
        kind: "thinking",
      },
    ]);
    expect(response.usage.reasoningOutputTokens).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(init?.body)) as {
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    expect(requestBody.contents[0]).toEqual({
      role: "model",
      parts: [
        {
          text: "previous reasoning",
          thought: true,
          thoughtSignature: "sig-1",
        },
        { text: "previous answer" },
      ],
    });
  });

  test("rejects malformed Gemini function calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { args: { text: "hi" } } }],
            },
            finishReason: "MALFORMED_FUNCTION_CALL",
          },
        ],
      }),
    );
    const provider = new GeminiProvider({
      credentialPlan: apiKeyCredentialPlan(),
      endpointPlan: developerEndpointPlan,
      model: "gemini-2.5-pro",
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "call echo" }], {
        tools: [echoTool],
      }),
    ).rejects.toThrow("Gemini response emitted invalid functionCall");
  });
});
