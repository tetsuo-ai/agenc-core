import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import { ollamaTemplateRequiresTextTools } from "../../../../src/llm/providers/ollama/template-tool-support.js";
import { projectProviderAccountingRequest } from "../../../../src/budget/admitted-model-call.js";
import type { LLMMessage, LLMStreamChunk, LLMTool } from "../../../../src/llm/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/history-only-tool-template.json", import.meta.url), "utf8")) as {
  activeTemplate: string;
  proof: { templateSha256: string; markerPresent: boolean; toolNamePresent: boolean; generatedContent: string };
};
const capabilities = ["tools", "thinking", "completion"];
const read: LLMTool = { type: "function", function: {
  name: "FileRead", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
} };
const mcp: LLMTool = { ...read, function: { ...read.function, name: "mcp.memory.read" } };
const messages: LLMMessage[] = [{ role: "user", content: "Read note.txt" }];

function setup(metadata: unknown) {
  const requests: Record<string, any>[] = [];
  const show = vi.fn(async (_request: { model: string }): Promise<unknown> => metadata);
  const content = '{"name":"mcp__memory__read","arguments":{"file_path":"note.txt"}}';
  const chat = vi.fn(async (request: Record<string, any>) => {
    requests.push(request);
    const response = { message: { content }, done: true, done_reason: "stop" };
    return request.stream ? (async function* () { yield response; })() : response;
  });
  const provider = new OllamaProvider({ model: "arbitrary-renamed-local-model", host: "http://metadata.test", numCtx: 32_768, tools: [read, mcp] });
  Object.assign(provider, { client: { show, chat, list: async () => ({ models: [] }) } });
  return { provider, show, chat, requests };
}

afterEach(() => vi.useRealTimers());

describe("audited Ollama native-tools false positive", () => {
  test("recognizes only the exact bounded template, independently of a model name", () => {
    expect(Buffer.byteLength(fixture.activeTemplate, "utf8")).toBe(2_237);
    expect(createHash("sha256").update(fixture.activeTemplate).digest("hex")).toBe(fixture.proof.templateSha256);
    expect(fixture.proof).toMatchObject({ markerPresent: false, toolNamePresent: false, generatedContent: "" });
    expect(ollamaTemplateRequiresTextTools(fixture.activeTemplate)).toBe(true);
    for (const value of [undefined, null, 1, {}, [], "", "{{ .Tools }}", "{{ message['tool_calls'] }}", `${fixture.activeTemplate}\n`, ` ${fixture.activeTemplate}`, fixture.activeTemplate.replace("is_first=false", "is_first=true"), "x".repeat(65_537), "é".repeat(40_000)]) {
      expect(ollamaTemplateRequiresTextTools(value)).toBe(false);
    }
  });

  test.each([false, true])("pins selected text schemas for accounting and one wire attempt (stream=%s)", async streaming => {
    const { provider, show, chat, requests } = setup({ capabilities, template: fixture.activeTemplate });
    const options = { systemPrompt: "Runtime policy", toolRouting: { allowedToolNames: [mcp.function.name] } };
    const profile = await provider.getExecutionProfile(options);
    const pinned = { ...options, providerExecutionHandle: profile.providerExecutionHandle };
    const projected = projectProviderAccountingRequest(provider, messages, pinned);
    expect(show).toHaveBeenCalledExactlyOnceWith({ model: "arbitrary-renamed-local-model" });
    expect(chat).not.toHaveBeenCalled();
    expect(projected.options.tools).toEqual([]);
    expect(projected.options.systemPrompt).toContain('"name":"mcp__memory__read"');
    expect(projected.options.systemPrompt).not.toContain("FileRead");
    expect(projected.options.systemPrompt).not.toContain(fixture.activeTemplate);
    const chunks: LLMStreamChunk[] = [];
    const response = streaming
      ? await provider.chatStream(messages, chunk => chunks.push(chunk), pinned)
      : await provider.chat(messages, pinned);
    expect(chat).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]?.messages).toEqual([{ role: "system", content: projected.options.systemPrompt }, ...projected.messages]);
    expect(response.toolCalls).toMatchObject([{ name: "mcp.memory.read", arguments: '{"file_path":"note.txt"}' }]);
    expect(response.content).toBe("");
    expect(chunks.map(chunk => chunk.content).join("")).toBe("");
  });

  test.each([false, true])("retains native mode for unknown metadata or any nearby altered template (stream=%s)", async streaming => {
    for (const metadata of [
      { capabilities, template: `${fixture.activeTemplate}\n` },
      { capabilities, template: fixture.activeTemplate.replace("is_first=false", "is_first=true") },
      { capabilities, template: "{{ if .Tools }}{{ .Tools }}{{ end }}" },
      { capabilities, template: null }, { capabilities },
      { capabilities: ["tools"], template: fixture.activeTemplate },
      { capabilities: ["completion", "tools", 3], template: fixture.activeTemplate },
      { template: fixture.activeTemplate },
    ]) {
      const { provider, requests } = setup(metadata);
      if (streaming) await provider.chatStream(messages, () => {});
      else await provider.chat(messages);
      expect(requests[0]?.tools).toHaveLength(2);
      expect(requests[0]?.messages).toEqual(messages);
    }
  });

  test("does not advertise any schemas for an empty selection", async () => {
    const { provider, requests } = setup({ capabilities, template: fixture.activeTemplate });
    const response = await provider.chat(messages, { tools: [] });
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]?.messages).toEqual(messages);
    expect(response.toolCalls).toEqual([]);
  });

  test.each([false, true])("preserves policy and the catalog across system/developer updates without promoting conversation data (stream=%s)", async streaming => {
    const { provider, requests } = setup({ capabilities, template: fixture.activeTemplate });
    const history: LLMMessage[] = [
      { role: "system", content: "Supplemental system instruction" },
      { role: "user", content: "USER_ONLY_SENTINEL" },
      { role: "developer", content: "Earlier runtime update" },
      { role: "assistant", content: "ASSISTANT_ONLY_SENTINEL", toolCalls: [{ id: "read-1", name: mcp.function.name, arguments: '{"file_path":"note.txt"}' }] },
      { role: "tool", toolCallId: "read-1", toolName: mcp.function.name, content: "TOOL_ONLY_SENTINEL" },
      { role: "developer", content: [{ type: "text", text: "Latest runtime update" }, { type: "text", text: "Preserve this second part" }] },
      { role: "user", content: "Continue" },
    ];
    const original = structuredClone(history);
    const options = { systemPrompt: "CURRENT_SYSTEM_POLICY", tools: [mcp] };
    const profile = await provider.getExecutionProfile(options);
    const pinned = { ...options, providerExecutionHandle: profile.providerExecutionHandle };
    const projected = projectProviderAccountingRequest(provider, history, pinned);
    if (streaming) await provider.chatStream(history, () => {}, pinned);
    else await provider.chat(history, pinned);
    const wire = requests[0]!.messages as Array<{ role: string; content: string }>;
    expect(wire).toEqual([{ role: "system", content: projected.options.systemPrompt }, ...projected.messages]);
    expect(wire.filter(message => message.role === "system")).toHaveLength(1);
    expect(wire.some(message => message.role === "developer")).toBe(false);
    const effectiveSystem = wire.filter(message => message.role === "system").at(-1)!.content;
    expect(effectiveSystem).toContain(JSON.stringify([
      { role: "system", content: "Supplemental system instruction" },
      { role: "developer", content: "Earlier runtime update" },
      { role: "developer", content: "Latest runtime update\nPreserve this second part" },
    ]));
    expect(effectiveSystem.indexOf("Earlier runtime update")).toBeLessThan(effectiveSystem.indexOf("Latest runtime update"));
    expect(effectiveSystem.indexOf("Latest runtime update")).toBeLessThan(effectiveSystem.indexOf("CURRENT_SYSTEM_POLICY"));
    expect(effectiveSystem.indexOf("CURRENT_SYSTEM_POLICY")).toBeLessThan(effectiveSystem.indexOf("Tool calling protocol"));
    expect(effectiveSystem).toContain('"name":"mcp__memory__read"');
    expect(effectiveSystem).not.toContain("FileRead");
    for (const sentinel of ["USER_ONLY_SENTINEL", "ASSISTANT_ONLY_SENTINEL", "TOOL_ONLY_SENTINEL"]) {
      expect(effectiveSystem).not.toContain(sentinel);
      expect(JSON.stringify(wire.slice(1))).toContain(sentinel);
    }
    expect(history).toEqual(original);
  });

  test("leaves native instruction carriers unchanged and fails closed on unsupported instruction media", async () => {
    const history: LLMMessage[] = [
      { role: "developer", content: "Runtime update" }, ...messages,
    ];
    const native = setup({ capabilities, template: "{{ .Tools }}" });
    await native.provider.chat(history, { systemPrompt: "Policy" });
    expect(native.requests[0]?.messages).toEqual([
      { role: "system", content: "Policy" },
      { role: "system", content: "Runtime update" }, ...messages,
    ]);
    const text = setup({ capabilities, template: fixture.activeTemplate });
    const mediaHistory: LLMMessage[] = [{ role: "developer", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }, ...messages];
    await expect(text.provider.chat(mediaHistory)).rejects.toThrow("instruction messages require text-only content");
    expect(text.chat).not.toHaveBeenCalled();
    expect(mediaHistory[0]?.content).toHaveLength(1);
  });

  test("keeps an admitted template decision pinned while new profiles observe cache expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider, show, requests } = setup({ capabilities, template: fixture.activeTemplate });
    const profile = await provider.getExecutionProfile();
    vi.setSystemTime(Date.now() + 61_000);
    show.mockResolvedValue({ capabilities, template: `${fixture.activeTemplate}\n` });
    await provider.chat(messages, { providerExecutionHandle: profile.providerExecutionHandle });
    expect(requests[0]).not.toHaveProperty("tools");
    expect(show).toHaveBeenCalledOnce();
    await provider.chat(messages);
    expect(requests[1]?.tools).toHaveLength(2);
    expect(show).toHaveBeenCalledTimes(2);
  });
});
