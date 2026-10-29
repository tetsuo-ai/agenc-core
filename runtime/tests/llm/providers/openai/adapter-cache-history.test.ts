import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";
import { llmMessageToResponseItem, responseItemToLlmMessage } from "../../../../src/session/message-history-conversion.js";

const tool = (name: string): LLMTool => ({ type: "function", function: { name,
  description: `Use ${name}`, parameters: { type: "object", properties: {} } } });
const search = tool("system.searchTools");
const one = tool("mcp.memory.lookup");
const two = tool("mcp.memory.list");
const user = (content: string): LLMMessage => ({ role: "user", content });
const roundTrip = (message: LLMMessage): LLMMessage => responseItemToLlmMessage(
  JSON.parse(JSON.stringify(llmMessageToResponseItem(message))),
);

function client(model = "gpt-6.1-terra", providerName = "openai") {
  const bodies: Record<string, any>[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const payload = { id: "resp_fixture", model, status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
    ], usage: { input_tokens: 10, output_tokens: 1 } };
    return body.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }) : Response.json(payload);
  });
  const provider = new OpenAIProvider({ model, providerName, apiKey: "fixture", fetchImpl,
    ...(providerName === "openai" ? {} : { baseURL: "https://example.invalid/v1" }) });
  return { provider, bodies };
}

// Reconstruct a new provider after each turn, like a daemon restart plus CLI -c.
async function turn(history: LLMMessage[], tools: LLMTool[], effort: "low" | "high" | undefined, stream = false, model?: string, providerName?: string) {
  const { provider, bodies } = client(model, providerName);
  const options = { tools, reasoningEffort: effort, promptCacheKey: "conv-fixture" };
  const response = stream ? await provider.chatStream(history, () => {}, options) : await provider.chat(history, options);
  const { toolCalls, content, providerContextHistory } = response;
  history.push(roundTrip({ role: "assistant", content, toolCalls, providerContextHistory }));
  return bodies[0]!;
}

describe("OpenAI append-only tool and effort history", () => {
  it.each([false, true])("retains two tool loads and one effort update across durable continuation (stream=%s)", async stream => {
    const history = [user("Load lookup")];
    const first = await turn(history, [search], "low", stream);
    history.push(user("Use lookup"));
    const second = await turn(history, [search, one], "low", stream);
    history.push(user("Load list and think harder"));
    const third = await turn(history, [search, one, two], "high", stream);
    history.push(user("Use both again"));
    const fourth = await turn(history, [search, one, two], "high", stream);
    for (const body of [second, third, fourth]) {
      expect(body.tools).toEqual(first.tools);
      expect(body.reasoning.effort).toBe("low");
    }
    const additions = fourth.input.filter((item: any) => item.type === "additional_tools");
    expect(additions.map((item: any) => item.tools.map((t: any) => t.name))).toEqual([
      ["mcp__memory__lookup"], ["mcp__memory__list"],
    ]);
    expect(additions.every((item: any) => item.role === "developer")).toBe(true);
    expect(fourth.input.filter((item: any) => item.type === "configuration_update")).toEqual([
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
    const change = third.input.findIndex((item: any) => item.type === "configuration_update");
    expect(third.input[change + 1]).toMatchObject({ role: "user", content: [{ text: "Load list and think harder" }] });
    expect(fourth.input.slice(0, third.input.length)).toEqual(third.input);
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
  });

  it("changes effort without changing the request-level effort", async () => {
    const history = [user("First")];
    const first = await turn(history, [search], "low");
    history.push(user("Hard follow-up"));
    const next = await turn(history, [search], "high");
    expect(next.reasoning).toEqual(first.reasoning);
    expect(next.input.filter((item: any) => item.type === "configuration_update")).toEqual([
      { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
  });

  it("clears effort to the documented medium default and replays the change once", async () => {
    const history = [user("First")];
    await turn(history, [search], "low");
    history.push(user("Use the model default"));
    const next = await turn(history, [search], undefined);
    history.push(user("Continue"));
    const last = await turn(history, [search], undefined);
    expect(next.reasoning.effort).toBe("low");
    expect(last.input.filter((item: any) => item.type === "configuration_update")).toEqual([
      { type: "configuration_update", reasoning: { effort: "medium" } },
    ]);
    expect(last.input.slice(0, next.input.length)).toEqual(next.input);
  });

  it("loads a tool after a real search call and tool output", async () => {
    const history = [user("Find lookup")];
    await turn(history, [search], "low");
    history.push({ role: "assistant", content: "", toolCalls: [{ id: "call_search", name: "system.searchTools", arguments: '{"select":["mcp.memory.lookup"]}' }] },
      { role: "tool", toolCallId: "call_search", content: "lookup loaded" });
    const next = await turn(history, [search, one], "low");
    expect(next.tools).toHaveLength(1);
    expect(next.input.at(-2)).toMatchObject({ type: "function_call_output", output: "lookup loaded" });
    expect(next.input.at(-1)).toMatchObject({ type: "additional_tools", role: "developer" });
  });

  it.each([["gpt-4.1", "openai"], ["gpt-6.1-terra", "deepseek"]])("keeps the old provider contract for %s via %s", async (model, providerName) => {
    const history = [user("First")];
    await turn(history, [search], "low", false, model, providerName);
    history.push(user("Next"));
    const body = await turn(history, [search, one], "high", false, model, providerName);
    expect(body.tools).toHaveLength(2);
    expect(body.reasoning.effort).toBe("high");
    expect(body.input.some((item: any) => ["additional_tools", "configuration_update"].includes(item.type))).toBe(false);
  });

  it("rebases safely when a tool is revoked", async () => {
    const history = [user("First")];
    await turn(history, [search, one], "low");
    history.push(user("Load list"));
    await turn(history, [search, one, two], "high");
    history.push(user("Lookup was revoked"));
    const body = await turn(history, [search, two], "low");
    expect(body.tools.map((t: any) => t.name)).toEqual(["tool2__system_x2esearchTools", "mcp__memory__list"]);
    expect(body.input.some((item: any) => item.type === "additional_tools")).toBe(false);
  });
  it("rebases after schema changes, compaction, or a model switch", async () => {
    const history = [user("First")];
    await turn(history, [search, one], "low");
    history.push(user("Schema changed"));
    const changed = { ...one, function: { ...one.function, description: "New tool contract" } };
    const body = await turn(history, [search, changed], "high");
    expect(body.reasoning.effort).toBe("high");
    expect(body.tools[1].description).toBe("New tool contract");
    expect(body.input.some((item: any) => item.type === "additional_tools")).toBe(false);
    const compacted = [user("A fresh compacted summary"), history.at(-1)!, user("Continue")];
    const fresh = await turn(compacted, [search, changed], "high", false, "gpt-6-luna");
    expect(fresh.tools).toHaveLength(2);
    expect(fresh.input.some((item: any) => item.type === "configuration_update")).toBe(false);
  });
});
