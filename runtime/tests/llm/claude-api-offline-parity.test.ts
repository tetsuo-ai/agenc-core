import { expect, test, vi } from "vitest";
import { buildBootstrapToolRegistry } from "../bin/bootstrap-tool-registry.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import { prepareRequest } from "./providers/claude-subscription/adapter.js";
import type { LLMMessage, LLMTool } from "./types.js";

test("API transport preserves the subscription tool catalog, attachments and replay without network", async () => {
  const registry = buildBootstrapToolRegistry({
    workspaceRoot: process.cwd(), getSession: () => null, emitWarning: () => {},
    mcpManager: { getTools: () => [] } as never,
    csvAgentJobsRepositories: { async withRepository() { throw new Error("Catalog only"); } },
  });
  const tools: LLMTool[] = registry.tools.map(tool => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
  } }));
  tools.push({ type: "function", function: { name: "mcp.fixture.ping", description: "fixture", parameters: { type: "object", properties: {} } } });
  const messages: LLMMessage[] = [{ role: "user", content: [
    { type: "text", text: "Synthetic attachment fixture" },
    { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" }, filename: "fixture.pdf" },
  ] }];
  const subscription = prepareRequest("sonnet", messages, { tools });
  let requests = 0;
  // This implementation never delegates to fetch or opens a socket. The real
  // user credential is neither required nor accessed. Bodies are synthetic.
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    requests++;
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("offline-fixture-not-a-real-key");
    expect(headers.has("authorization")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body.tools).toHaveLength(tools.length);
    for (let i = 0; i < tools.length; i++) {
      expect(body.tools[i].name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(body.tools[i].input_schema).toEqual(subscription.tools[i].function.parameters);
    }
    const attachmentBlocks = body.messages[0].content;
    expect(attachmentBlocks.find((b: { type: string }) => b.type === "image").source.data).toBe("YWJj");
    const pdf = attachmentBlocks.find((b: { type: string }) => b.type === "document");
    expect(pdf.source.data).toBe("JVBERi0xLjQK");
    expect(pdf).not.toHaveProperty("filename");
    if (requests === 2) {
      const results = body.messages.flatMap((m: { content: unknown }) => Array.isArray(m.content) ? m.content : []).filter((b: { type: string }) => b.type === "tool_result");
      expect(results).toHaveLength(tools.length);
      for (let i = 0; i < tools.length; i++) expect(results[i]).toMatchObject({ tool_use_id: `call_${i}`, content: `fixture-result-${i}` });
    }
    return new Response(JSON.stringify({ id: "offline", type: "message", role: "assistant", model: "claude-sonnet-5",
      stop_reason: requests === 1 ? "tool_use" : "end_turn",
      content: requests === 1 ? body.tools.map((tool: { name: string }, i: number) => ({ type: "tool_use", id: `call_${i}`, name: tool.name, input: { fixture: i } })) : [{ type: "text", text: "offline replay verified" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const provider = new AnthropicProvider({ apiKey: "offline-fixture-not-a-real-key", model: "claude-sonnet-5", fetchImpl });
  const first = await provider.chat(messages, { tools });
  expect(first.toolCalls.map(call => call.name)).toEqual(tools.map(tool => tool.function.name));
  first.toolCalls.forEach((call, i) => expect(JSON.parse(call.arguments)).toEqual({ fixture: i }));
  const replay: LLMMessage[] = [...messages, { role: "assistant", content: "", toolCalls: first.toolCalls },
    ...first.toolCalls.map((call, i): LLMMessage => ({ role: "tool", toolName: call.name, toolCallId: call.id, content: `fixture-result-${i}` })),
  ];
  expect((await provider.chat(replay, { tools })).content).toBe("offline replay verified");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  console.log("OFFLINE_API_PARITY", JSON.stringify({ builtInTools: tools.length - 1, mcpFixtures: 1, simulatedRequests: requests, realApiRequests: 0 }));
});
