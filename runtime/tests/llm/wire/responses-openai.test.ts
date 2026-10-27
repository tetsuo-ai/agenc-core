import { describe, expect, test } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import { encodeMcpToolNameForWire } from "./mcp-tool-naming.js";
import {
  advertisedResponsesToolNames,
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
} from "./responses-openai.js";

const TEST_TOOLS: LLMTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
        },
        required: ["cmd"],
      },
    },
  },
];

describe("buildOpenAIResponsesRequest", () => {
  test("uses native verbosity only for verified direct models and keeps subscription instructions fixed", () => {
    const build = (modelVerbosity?: "low" | "high", chatgptBackend = false) => buildOpenAIResponsesRequest({
      model: "gpt-5", messages: [{ role: "user", content: "hello" }], tools: TEST_TOOLS,
      chatgptBackend,
      options: { systemPrompt: "STATIC_HEAD\n\n<!-- dynamic-boundary -->\n\nDYNAMIC_TAIL",
        modelVerbosity, ...(chatgptBackend ? { responseDetailOverride: modelVerbosity } : {}),
        reasoningEffort: "high", toolChoice: "required", maxOutputTokens: 4096 },
    });
    const inherited = build();
    const low = build("low");
    const high = build("high");
    expect(inherited).not.toHaveProperty("text");
    expect(low.text).toEqual({ verbosity: "low" });
    expect(high.text).toEqual({ verbosity: "high" });
    for (const candidate of [low, high]) {
      const { text: _detail, ...rest } = candidate;
      expect(rest).toEqual(inherited);
      expect(candidate.max_output_tokens).toBe(4096);
    }
    const subscriptionBase = build(undefined, true);
    for (const level of ["low", "high"] as const) {
      const subscription = build(level, true);
      expect(subscription).not.toHaveProperty("text");
      expect(subscription).not.toHaveProperty("max_output_tokens");
      expect(subscription.instructions).toBe(subscriptionBase.instructions);
      expect((subscription.input as unknown[]).slice(0, -1)).toEqual(subscriptionBase.input);
      expect((subscription.input as Array<Record<string, unknown>>).at(-1)).toMatchObject({
        type: "message", role: "user",
        content: [{ type: "input_text", text: expect.stringContaining("# Response Detail") }],
      });
      expect(JSON.stringify(subscription)).toContain("If you ran checks or tests, still report their results. Always report errors, blockers, and approval requests.");
    }
    expect(subscriptionBase.instructions).not.toContain("# Response Detail");
    expect(JSON.stringify(subscriptionBase.input)).not.toContain("# Response Detail");
  });

  test("falls back for an unsupported or unknown direct OpenAI model and inherits configured subscription detail", () => {
    const build = (model: string, chatgptBackend = false) => buildOpenAIResponsesRequest({
      model, chatgptBackend, messages: [{ role: "user", content: "hello" }], tools: [],
      options: { systemPrompt: "STATIC_HEAD\n\n<!-- dynamic-boundary -->\n\nDYNAMIC_TAIL",
        modelVerbosity: "high", responseDetailOverride: undefined, maxOutputTokens: 4096 },
    });
    for (const model of ["gpt-4o", "gpt-5-preview", "unlisted-openai-model"]) {
      const request = build(model);
      expect(request).not.toHaveProperty("text.verbosity");
      expect(request.instructions).toBe("STATIC_HEAD");
      expect((request.input as Array<Record<string, unknown>>)[0]).toMatchObject({
        role: "system", content: [{ text: expect.stringContaining("# Response Detail") }],
      });
      expect(request.max_output_tokens).toBe(4096);
    }
    const configured = build("gpt-5", true);
    expect(configured).not.toHaveProperty("text.verbosity");
    expect(configured.instructions).toBe("STATIC_HEAD\n\nDYNAMIC_TAIL");
    expect((configured.input as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      role: "user", content: [{ text: expect.stringContaining("Detailed: give thorough user-facing answers.") }],
    });
    expect(configured).not.toHaveProperty("max_output_tokens");
  });

  test("keeps the unset direct and subscription request bytes from the pre-detail builder", () => {
    const build = (chatgptBackend: boolean) => JSON.stringify(buildOpenAIResponsesRequest({
      model: "gpt-5", chatgptBackend, messages: [{ role: "user", content: "hello" }], tools: [],
      options: { systemPrompt: "STATIC_HEAD\n\n<!-- dynamic-boundary -->\n\nDYNAMIC_TAIL",
        reasoningEffort: "high", maxOutputTokens: 4096 },
    }));
    // The session tail leads the direct input (append-only requests).
    expect(build(false)).toBe('{"model":"gpt-5","input":[{"type":"message","role":"system","content":[{"type":"input_text","text":"DYNAMIC_TAIL"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"stream":false,"store":false,"instructions":"STATIC_HEAD","max_output_tokens":4096,"reasoning":{"effort":"high"}}');
    expect(build(true)).toBe('{"model":"gpt-5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"stream":false,"store":false,"instructions":"STATIC_HEAD\\n\\nDYNAMIC_TAIL","include":["reasoning.encrypted_content"],"reasoning":{"effort":"high"}}');
  });
  test.each(["conv-123", "k".repeat(64), `review-${"a".repeat(64)}`])(
    "bounds prompt cache keys while preserving existing short keys: %s",
    (promptCacheKey) => {
      const build = (key: string) => buildOpenAIResponsesRequest({
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: { promptCacheKey: key },
      }).prompt_cache_key;
      const key = build(promptCacheKey);

      expect(key).toHaveLength(Math.min(promptCacheKey.length, 64));
      expect(build(promptCacheKey)).toBe(key);
      if (promptCacheKey.length <= 64) {
        expect(key).toBe(promptCacheKey);
      } else {
        expect(build(`${promptCacheKey.slice(0, -1)}b`)).not.toBe(key);
      }
    },
  );

  test("keeps request instructions in the Responses instructions field", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "hello" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
        maxOutputTokens: 8192,
      },
    });

    expect(request.instructions).toBe("base instructions\n\nstable prefix");
    expect(request.max_output_tokens).toBe(8192);
  });

  test("serializes request-scoped temperature", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        temperature: 0.3,
      },
    });

    expect(request.temperature).toBe(0.3);
  });

  // OpenAI documents temperature on its reasoning models only when the
  // effective effort is none (GPT-5.4 parameter compatibility, Using GPT-6);
  // gpt-6-luna answered a live request with 400 "Unsupported parameter:
  // 'temperature' is not supported with this model". An omitted effort runs
  // the model's documented default: none for GPT-5.1, 5.2 and the 5.4 line.
  test("keeps temperature off OpenAI reasoning models unless the effective effort is none", () => {
    const build = (
      model: string,
      options: NonNullable<Parameters<typeof buildOpenAIResponsesRequest>[0]["options"]>,
    ) =>
      buildOpenAIResponsesRequest({
        model,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options,
      });

    for (const model of [
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4-pro",
      "gpt-5",
      "o3",
      "openai/gpt-6-luna",
    ]) {
      expect(build(model, { temperature: 0.2 }).temperature, model).toBeUndefined();
    }
    for (const model of ["gpt-6-luna", "gpt-5.4", "gpt-5.2"]) {
      expect(
        build(model, { temperature: 0.2, reasoningEffort: "low" }).temperature,
        model,
      ).toBeUndefined();
    }
    for (const model of ["gpt-5.4", "gpt-5.4-2026-03-05", "gpt-5.4-mini", "gpt-5.2", "gpt-5.1"]) {
      expect(build(model, { temperature: 0.2 }).temperature, model).toBe(0.2);
    }
    expect(
      build("gpt-6-luna", { temperature: 0.2, reasoningEffort: "none" }),
    ).toMatchObject({ temperature: 0.2, reasoning: { effort: "none" } });
    expect(build("gpt-4.1", { temperature: 0.2 }).temperature).toBe(0.2);
  });

  test("folds developer messages into instructions before current user input", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "previous ask" },
        { role: "developer", content: [{ type: "text", text: "realtime update" }] },
        { role: "user", content: "current ask" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
      },
    });

    expect(request.instructions).toBe(
      "base instructions\n\nstable prefix\n\nrealtime update",
    );
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "previous ask" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current ask" }],
      },
    ]);
  });

  test("uses AgenC-style response items and disables store by default", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "look at this" },
        {
          role: "assistant",
          content: "working",
          toolCalls: [
            {
              id: "tool-1",
              name: "shell",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "tool-1",
          toolName: "shell",
          content: "ok",
        },
      ],
      tools: TEST_TOOLS,
    });

    expect(request).toMatchObject({
      model: "gpt-5",
      instructions: "system prompt",
      stream: false,
      store: false,
    });
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string" },
          },
          required: ["cmd"],
        },
      },
    ]);
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "look at this" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "working" }],
      },
      {
        type: "function_call",
        call_id: "tool-1",
        name: "shell",
        arguments: "{\"cmd\":\"pwd\"}",
      },
      {
        type: "function_call_output",
        call_id: "tool-1",
        output: "ok",
      },
    ]);
  });

  test.each([
    ["platform API", false],
    ["ChatGPT backend", true],
  ])("sends history function calls with the item id the provider issued or none on the %s", (_label, chatgptBackend) => {
    const issuedId = "fc_0a1b2c3d4e5f6071016acbcc22e5e8819192aa7ff9b45985e6";
    const issued = new Map([["call_seen", issuedId]]);
    const request = buildOpenAIResponsesRequest({
      model: "gpt-6-luna",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_seen", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
            { id: "call_unseen", name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
          ],
        },
        { role: "tool", toolCallId: "call_seen", toolName: "shell", content: "a" },
        { role: "tool", toolCallId: "call_unseen", toolName: "shell", content: "b" },
      ],
      tools: TEST_TOOLS,
      chatgptBackend,
      functionCallItemId: (callId) => issued.get(callId),
    });

    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
      { type: "function_call", id: issuedId, call_id: "call_seen", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call", call_id: "call_unseen", name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_seen", output: "a" },
      { type: "function_call_output", call_id: "call_unseen", output: "b" },
    ]);
    // The serialized wire names no item derived from a call id.
    const wire = JSON.stringify(request);
    expect(wire).not.toContain("\"fc_seen\"");
    expect(wire).not.toContain("\"fc_unseen\"");
  });

  test.each(["", 1, null] as const)("omits an item id when the lookup returns %j", (issued) => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_seen", name: "shell", arguments: "{}" }] },
        { role: "tool", toolCallId: "call_seen", toolName: "shell", content: "ok" },
      ],
      tools: TEST_TOOLS,
      functionCallItemId: () => issued as never,
    });

    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run" }] },
      { type: "function_call", call_id: "call_seen", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_seen", output: "ok" },
    ]);
    expect(JSON.stringify(request)).not.toContain("\"fc_");
  });

  test("trims a history call token before looking up the issued item id", () => {
    const issuedId = "fc_0a1b2c3d4e5f6071016acbcc22e5e8819192aa7ff9b45985e6";
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: "", toolCalls: [{ id: "  call_seen  ", name: "shell", arguments: "{}" }] },
        { role: "tool", toolCallId: "  call_seen  ", toolName: "shell", content: "ok" },
      ],
      tools: TEST_TOOLS,
      functionCallItemId: (callId) => callId === "call_seen" ? issuedId : undefined,
    });

    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run" }] },
      { type: "function_call", id: issuedId, call_id: "call_seen", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_seen", output: "ok" },
    ]);
  });

  test.each([false, true])("requires observed provenance for an item-id-shaped call token, observed=%s", (observed) => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", content: "", toolCalls: [{ id: "fc_only", name: "shell", arguments: "{}" }] },
        { role: "tool", toolCallId: "fc_only", toolName: "shell", content: "ok" },
      ],
      tools: TEST_TOOLS,
      functionCallItemId: (id) => observed && id === "fc_only" ? "fc_only" : undefined,
    });

    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run" }] },
      { type: "function_call", ...(observed ? { id: "fc_only" } : {}), call_id: "call_only", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_only", output: "ok" },
    ]);
  });

  test("drops orphan tool outputs before serializing responses input", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "tool",
          toolCallId: "call_missing",
          toolName: "shell",
          content: "done",
        },
      ],
      tools: TEST_TOOLS,
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "run it" }],
      },
    ]);
  });

  test("maps user images to input_image parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YWJj" },
            },
          ],
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
    ]);
  });

  test("maps user PDFs to input_file parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0xLjQK",
              },
              filename: "brief.pdf",
            },
          ],
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "summarize" },
          {
            type: "input_file",
            filename: "brief.pdf",
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
          },
        ],
      },
    ]);
  });

  test("preserves inline input_audio parts in responses input messages", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this" },
            {
              type: "input_audio",
              input_audio: {
                data: "UklGRiQAAABXQVZFZm10",
                format: "wav",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Transcribe this" },
          {
            type: "input_audio",
            input_audio: {
              data: "UklGRiQAAABXQVZFZm10",
              format: "wav",
            },
          },
        ],
      },
    ]);
  });

  test("replays persisted data-url audio history as input_audio parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              audio_url: {
                url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: "UklGRiQAAABXQVZFZm10",
              format: "wav",
            },
          },
        ],
      },
    ]);
  });

  test("fails closed to a text placeholder when persisted audio references cannot be replayed", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              audio_url: {
                url: "file:///tmp/example.wav",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[audio]" }],
      },
    ]);
  });

  test("forwards prompt_cache_key when the runtime shapes one for the session", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        promptCacheKey: "conv-123",
      },
    });

    expect(request.prompt_cache_key).toBe("conv-123");
  });

  test("forwards service_tier and text verbosity controls", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        serviceTier: "flex",
        modelVerbosity: "high",
      },
    });

    expect(request.service_tier).toBe("flex");
    expect(request.text).toEqual({ verbosity: "high" });
  });

  test("sends structured output schemas through Responses text.format", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        modelVerbosity: "low",
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
            },
          },
        },
      },
    });

    expect(request.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: { type: ["string", "null"] },
          },
          additionalProperties: false,
          required: ["answer"],
        },
      },
    });
  });

  test("forwards reasoning summary for reasoning-capable responses models", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
    });

    expect(request.reasoning).toEqual({
      effort: "high",
      summary: "concise",
    });
  });

  test("omits reasoning summary when explicitly disabled", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        reasoningSummary: "none",
      },
    });

    expect(request.reasoning).toBeUndefined();
  });

  test("preserves mixed text and image tool outputs as function_call_output content items", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_image",
              name: "view_image",
              arguments: "{\"path\":\"/tmp/cat.png\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_image",
          toolName: "view_image",
          content: [
            { type: "text", text: "Screenshot captured" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YWJj" },
            },
          ],
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "inspect" }],
      },
      {
        type: "function_call",
        call_id: "call_image",
        name: "view_image",
        arguments: "{\"path\":\"/tmp/cat.png\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [
          { type: "input_text", text: "Screenshot captured" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
    ]);
  });

  test("encodes a named toolChoice with the same wire name as tools", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "search memory" }],
      tools: [
        {
          type: "function",
          function: {
            name: "mcp.memory.search_nodes",
            description: "Search the memory graph.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      options: {
        toolChoice: { type: "function", name: "mcp.memory.search_nodes" },
      },
    });

    const tools = request.tools as Array<{ name: string }>;
    // Hardcoded literal on purpose: pins the wire contract.
    expect(tools[0]!.name).toBe("mcp__memory__search_nodes");
    // tool_choice must reference the encoded tools[] entry byte-for-byte,
    // never the dotted internal name the provider never saw.
    expect(request.tool_choice).toEqual({
      type: "function",
      name: tools[0]!.name,
    });
  });

  test("omits tools when an auto_only destination is asked not to call one", () => {
    const request = buildOpenAIResponsesRequest({
      model: "muse-wonder-1.0",
      messages: [{ role: "user", content: "summarize" }],
      tools: TEST_TOOLS,
      toolChoicePolicy: "auto_only",
      options: { toolChoice: "none" },
    });
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  test("keeps tools and sends auto when auto_only rewrites required or a named choice", () => {
    for (const toolChoice of ["required", { type: "function", name: "shell" }] as const) {
      const request = buildOpenAIResponsesRequest({
        model: "muse-wonder-1.0",
        messages: [{ role: "user", content: "go" }],
        tools: TEST_TOOLS,
        toolChoicePolicy: "auto_only",
        options: { toolChoice },
      });
      expect(request.tool_choice).toBe("auto");
      expect(request.tools).toEqual([
        expect.objectContaining({ type: "function", name: "shell" }),
      ]);
    }
  });

  test("strips a reasoning effort the destination does not accept", () => {
    const allowed = new Set(["minimal", "low", "medium", "high", "xhigh"]);
    const stripped = buildOpenAIResponsesRequest({
      model: "muse-wonder-1.0",
      messages: [{ role: "user", content: "think" }],
      tools: [],
      options: { reasoningEffort: "max" },
      reasoningEffortAllowedValues: allowed,
    });
    expect(stripped.reasoning).toBeUndefined();

    const kept = buildOpenAIResponsesRequest({
      model: "muse-wonder-1.0",
      messages: [{ role: "user", content: "think" }],
      tools: [],
      options: { reasoningEffort: "high" },
      reasoningEffortAllowedValues: allowed,
    });
    expect(kept.reasoning).toEqual({ effort: "high" });

    const unrestricted = buildOpenAIResponsesRequest({
      model: "muse-wonder-1.0",
      messages: [{ role: "user", content: "think" }],
      tools: [],
      options: { reasoningEffort: "max" },
    });
    expect(unrestricted.reasoning).toEqual({ effort: "max" });

    const emptyAllowlist = buildOpenAIResponsesRequest({
      model: "muse-wonder-1.0",
      messages: [{ role: "user", content: "think" }],
      tools: [],
      options: { reasoningEffort: "high" },
      reasoningEffortAllowedValues: new Set(),
    });
    expect(emptyAllowlist.reasoning).toBeUndefined();
  });
});

describe("advertisedResponsesToolNames", () => {
  const request = {
    model: "muse-wonder-1.0",
    messages: [] as LLMMessage[],
    tools: TEST_TOOLS,
  };

  test("is empty only when auto_only omits tools for toolChoice none", () => {
    expect(advertisedResponsesToolNames({
      ...request,
      toolChoicePolicy: "auto_only",
      options: { toolChoice: "none" },
    })).toEqual([]);
    expect(advertisedResponsesToolNames({
      ...request,
      toolChoicePolicy: "auto_only",
      options: { toolChoice: "auto" },
    })).toEqual(["shell"]);
    expect(advertisedResponsesToolNames({
      ...request,
      toolChoicePolicy: "auto_only",
      options: { toolChoice: "required" },
    })).toEqual(["shell"]);
    // Without auto_only, none is a wire choice and the catalog stays advertised.
    expect(advertisedResponsesToolNames({
      ...request,
      options: { toolChoice: "none" },
    })).toEqual(["shell"]);
    expect(advertisedResponsesToolNames(request)).toEqual(["shell"]);
  });
});

describe("parseOpenAIResponsesResponse", () => {
  const request = {
    model: "gpt-5",
    messages: [] as LLMMessage[],
    tools: TEST_TOOLS,
  };

  test("marks function-call outputs as tool_calls turns", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "shell",
            arguments: "{\"cmd\":\"pwd\"}",
          },
        ],
      },
      request,
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: "call_1",
        name: "shell",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    ]);
  });

  test("parses structured output from Responses output text", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "{\"answer\":\"ok\"}",
              },
            ],
          },
        ],
      },
      {
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: {
          structuredOutput: {
            schema: {
              type: "json_schema",
              name: "answer",
              schema: {
                type: "object",
                properties: {
                  answer: { type: "string" },
                },
                required: ["answer"],
              },
            },
          },
        },
      },
    );

    expect(response.structuredOutput).toEqual({
      type: "json_schema",
      name: "answer",
      rawText: "{\"answer\":\"ok\"}",
      parsed: { answer: "ok" },
    });
  });

  test("maps incomplete max_output_tokens to length", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      request,
    );

    expect(response.finishReason).toBe("length");
  });

  test.each([
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
    ["error", "error"],
  ])("never parses or executes incomplete function calls (%s)", (reason, finishReason) => {
    const response = parseOpenAIResponsesResponse("gpt-5", {
      status: "incomplete", incomplete_details: { reason },
      output: [{ type: "function_call", call_id: "call_cut", name: "spawn_agent", arguments: '{"message":"cut' }],
    }, request);
    expect(response.finishReason).toBe(finishReason);
    expect(response.toolCalls).toEqual([]);
    expect(response.incompleteToolCalls).toEqual(reason === "max_output_tokens"
      ? [{ id: "call_cut", name: "spawn_agent" }] : undefined);
  });

  test("does not resolve a hashed tool alias when auto_only omitted the catalog", () => {
    const longToolName = `mcp.plugin-${"shared-prefix-".repeat(5)}.search`;
    const wireName = encodeMcpToolNameForWire(longToolName);
    expect(wireName).toMatch(/^toolh__/);
    const omitted = {
      model: "muse-wonder-1.0",
      messages: [] as LLMMessage[],
      tools: [
        {
          type: "function" as const,
          function: {
            name: longToolName,
            description: "A long tool that was disabled for this request.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      toolChoicePolicy: "auto_only" as const,
      options: { toolChoice: "none" as const },
    };

    expect(() =>
      parseOpenAIResponsesResponse(
        "muse-wonder-1.0",
        {
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_unadvertised",
              name: wireName,
              arguments: "{}",
            },
          ],
        },
        omitted,
      ),
    ).toThrow(/unknown hashed tool name/i);

    expect(() =>
      parseOpenAIResponsesResponse(
        "muse-wonder-1.0",
        {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "function_call",
              call_id: "call_cut",
              name: wireName,
              arguments: '{"q":"',
            },
          ],
        },
        omitted,
      ),
    ).toThrow(/unknown hashed tool name/i);
  });

  test("maps a hashed alias only against the tools that request advertised", () => {
    const longToolName = `mcp.plugin-${"shared-prefix-".repeat(5)}.search`;
    const wireName = encodeMcpToolNameForWire(longToolName);
    const response = parseOpenAIResponsesResponse(
      "muse-wonder-1.0",
      {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_search",
            name: wireName,
            arguments: "{}",
          },
        ],
      },
      {
        model: "muse-wonder-1.0",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: longToolName,
              description: "Search.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    );
    expect(response.toolCalls).toEqual([
      { id: "call_search", name: longToolName, arguments: "{}" },
    ]);
  });

  test("keeps a plain wire name when auto_only omitted the catalog", () => {
    const response = parseOpenAIResponsesResponse(
      "muse-wonder-1.0",
      {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_plain",
            name: "shell",
            arguments: "{}",
          },
        ],
      },
      {
        model: "muse-wonder-1.0",
        messages: [],
        tools: TEST_TOOLS,
        toolChoicePolicy: "auto_only",
        options: { toolChoice: "none" },
      },
    );
    expect(response.toolCalls).toEqual([
      { id: "call_plain", name: "shell", arguments: "{}" },
    ]);
  });

  test("records responses endpoint markers in request metrics", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        id: "resp_123",
        status: "completed",
        output: [],
      },
      request,
    );

    expect(response.requestMetrics).toMatchObject({
      endpoint: "/responses",
      responseId: "resp_123",
    });
  });
});

describe("closeDanglingFunctionCalls", () => {
  test("pairs every unmatched call with a synthetic interrupted output", async () => {
    const { closeDanglingFunctionCalls } = await import(
      "../../../src/llm/wire/responses-openai.js"
    );
    const input: Array<Record<string, unknown>> = [
      { type: "function_call", call_id: "call_a", name: "navigate", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "ok" },
      { type: "function_call", call_id: "call_b", name: "navigate", arguments: "{}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    ];
    closeDanglingFunctionCalls(input);
    expect(input).toHaveLength(5);
    expect(input[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call_b",
    });
    expect(String((input[3] as { output?: unknown }).output)).toMatch(/interrupted/iu);
    // The answered pair stays untouched.
    expect(input.filter((item) => item.call_id === "call_a")).toHaveLength(2);
  });
});
