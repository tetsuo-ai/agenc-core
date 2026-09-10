import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";
import {
  createOllamaToolNameProjection,
  projectOllamaHistoryToolNames,
} from "../../../../src/llm/providers/ollama/tool-naming.js";
import { salvageTextToolCalls } from "../../../../src/llm/providers/ollama/salvage-tool-calls.js";
import { encodeMcpToolNameForWire } from "../../../../src/llm/wire/mcp-tool-naming.js";

const tool = (name: string): LLMTool => ({
  type: "function",
  function: { name, description: "test tool", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  } },
});

describe("request-bound Ollama tool names", () => {
  it.each([
    "FileRead",
    "mcp.server.read_file",
    "mcp.plugin:sample:local.read_file",
    "mcp.server__with_separator.read_file",
    `mcp.${"very-long-plugin-server-".repeat(4)}.read_file`,
    "system.searchTools",
  ])("round-trips advertised %s without changing schemas or arguments", (name) => {
    const original = tool(name);
    const before = JSON.stringify(original);
    const projection = createOllamaToolNameProjection([original]);
    const wire = projection.wireTools[0]!.function.name;
    if (name.startsWith("mcp.")) expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(wire).toBe(name.startsWith("mcp.") ? encodeMcpToolNameForWire(name) : name);
    expect(projection.canonicalTools[0]).toBe(original);
    expect(projection.wireTools[0]!.function.parameters).toBe(original.function.parameters);
    expect(projection.canonicalizeToolCall({ id: "call-1", name: wire, arguments: '{"path":"file.txt"}' }))
      .toEqual({ id: "call-1", name, arguments: '{"path":"file.txt"}' });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("accepts only the exact canonical name and its explicit wire alias for this request", () => {
    const projection = createOllamaToolNameProjection([tool("mcp.server.read_file")]);
    for (const name of [
      "read_file", "mcp__other__read_file", "FileRead",
      "mcp2__server__read_ufile", " mcp__server__read_file", "mcp__server__read_file ",
      encodeMcpToolNameForWire(`mcp.${"unadvertised-".repeat(8)}.read_file`),
    ]) {
      expect(projection.toCanonicalName(name)).toBeUndefined();
      expect(projection.canonicalizeToolCall({ id: "call", name, arguments: "{}" })).toBeNull();
    }
    expect(projection.toCanonicalName("mcp.server.read_file")).toBe("mcp.server.read_file");
    expect(createOllamaToolNameProjection([]).toCanonicalName("mcp__server__read_file")).toBeUndefined();
  });

  it("rejects duplicate declarations and short or hashed alias collisions before exposure", () => {
    expect(() => createOllamaToolNameProjection([tool("FileRead"), tool("FileRead")]))
      .toThrow(/duplicate canonical tool names/);
    for (const canonical of ["mcp.server.read_file", `mcp.${"very-long-".repeat(12)}.read_file`]) {
      expect(() => createOllamaToolNameProjection([tool(canonical), tool(encodeMcpToolNameForWire(canonical))]))
        .toThrow(/tool-name collision/);
    }
    expect(() => createOllamaToolNameProjection([tool("mcp.incomplete")])).toThrow(/cannot be represented/);
  });

  it("does not reinterpret an explicitly advertised literal reserved-looking name", () => {
    const literal = "mcp__server__read_file";
    const projection = createOllamaToolNameProjection([tool(literal)]);
    expect(projection.toCanonicalName(literal)).toBe(literal);
    expect(projection.toCanonicalName("mcp.server.read_file")).toBeUndefined();
  });

  it("keeps hashed aliases bound to their exact request, including common long prefixes", () => {
    const prefix = `mcp.${"same-long-prefix-".repeat(8)}`;
    const first = createOllamaToolNameProjection([tool(`${prefix}first.read`)]);
    const second = createOllamaToolNameProjection([tool(`${prefix}second.read`)]);
    expect(first.wireTools[0]!.function.name).not.toBe(second.wireTools[0]!.function.name);
    expect(second.toCanonicalName(first.wireTools[0]!.function.name)).toBeUndefined();
  });

  it("salvages advertised wire calls against the original schema before canonicalizing", () => {
    const canonical = "mcp.plugin:sample:local.read_file";
    const projection = createOllamaToolNameProjection([tool(canonical)]);
    const wire = projection.wireTools[0]!.function.name;
    const recovered = salvageTextToolCalls(JSON.stringify({ name: wire, arguments: { path: "file.txt" } }), projection.salvageTools);
    expect(recovered.content).toBe("");
    expect(recovered.toolCalls).toHaveLength(1);
    expect(projection.canonicalizeToolCall(recovered.toolCalls[0]!)?.name).toBe(canonical);
    for (const args of [{}, { path: 7 }, { path: "file.txt", unadvertised: true }]) {
      expect(salvageTextToolCalls(JSON.stringify({ name: wire, arguments: args }), projection.salvageTools).toolCalls).toEqual([]);
    }
    expect(projection.wireTools).toHaveLength(1);
    expect(projection.salvageTools).toHaveLength(2);
    expect(salvageTextToolCalls(JSON.stringify({ name: canonical, arguments: { path: "file.txt" } }), projection.salvageTools).toolCalls)
      .toHaveLength(1);
    expect(salvageTextToolCalls(JSON.stringify({ name: "mcp__unadvertised__read_file", arguments: { path: "file.txt" } }), projection.salvageTools).toolCalls)
      .toEqual([]);
  });

  it("keeps dotted builtins unchanged and does not enable strict-provider aliases for them", () => {
    const projection = createOllamaToolNameProjection([tool("system.searchTools")]);
    expect(projection.wireTools[0]!.function.name).toBe("system.searchTools");
    expect(projection.salvageTools).toHaveLength(1);
    expect(projection.toCanonicalName("system.searchTools")).toBe("system.searchTools");
    expect(projection.toCanonicalName(encodeMcpToolNameForWire("system.searchTools"))).toBeUndefined();
    const projected = projectOllamaHistoryToolNames([{ role: "assistant", content: "", toolCalls: [
      { id: "search", name: "system.searchTools", arguments: "{}" },
    ] }]);
    expect(projected[0]!.toolCalls?.[0]?.name).toBe("system.searchTools");
  });

  it("does not apply another provider's builtin alias collisions when resolving a hashed MCP call", () => {
    const canonical = `mcp.${"very-long-server-".repeat(8)}.read_file`;
    const builtin = "system.searchTools";
    const strictProviderAlias = encodeMcpToolNameForWire(builtin);
    const projection = createOllamaToolNameProjection([tool(canonical), tool(builtin), tool(strictProviderAlias)]);
    expect(projection.toCanonicalName(projection.wireTools[0]!.function.name)).toBe(canonical);
    expect(projection.toCanonicalName(builtin)).toBe(builtin);
    expect(projection.toCanonicalName(strictProviderAlias)).toBe(strictProviderAlias);
  });

  it("preserves mixed prose and calls for content-else-tool templates without changing durable history", () => {
    const name = "mcp.plugin:sample:local.read_file";
    const messages: LLMMessage[] = [
      { role: "assistant", content: "Reading", runtimeOnly: { anchorPreserve: true }, toolCalls: [{ id: "call-1", name, arguments: '{"path":"file.txt"}' }] },
      { role: "tool", content: "file contents", toolCallId: "call-1", toolName: name },
      { role: "user", content: "continue" },
    ];
    const before = JSON.stringify(messages);
    const projected = projectOllamaHistoryToolNames(messages);
    expect(projected[0]).toEqual({ role: "assistant", content: "Reading" });
    expect(projected[1]!.content).toBe("");
    expect(projected[1]!.runtimeOnly).toEqual({ anchorPreserve: true });
    expect(projected[1]!.toolCalls?.[0]).toEqual({
      id: "call-1", name: encodeMcpToolNameForWire(name), arguments: '{"path":"file.txt"}',
    });
    expect(projected[2]).toEqual({ ...messages[1], toolName: encodeMcpToolNameForWire(name) });
    expect(projected[3]).toEqual(messages[2]);
    expect(JSON.stringify(messages)).toBe(before);
    expect(projected).not.toBe(messages);
    expect(projected[1]!.toolCalls).not.toBe(messages[0]!.toolCalls);
    expect(projectOllamaHistoryToolNames(projected)).toEqual(projected);
  });

  it("splits multimodal prose once and preserves multiple paired call identities", () => {
    const content: LLMMessage["content"] = [{ type: "text", text: "Checking both files" }];
    const calls = [
      { id: "first", name: "FileRead", arguments: '{"path":"first.txt"}' },
      { id: "second", name: "FileRead", arguments: '{"path":"second.txt"}' },
    ];
    const messages: LLMMessage[] = [
      { role: "assistant", content, toolCalls: calls },
      ...calls.map(call => ({ role: "tool" as const, content: "contents", toolCallId: call.id, toolName: call.name })),
    ];
    const before = structuredClone(messages);
    const projected = projectOllamaHistoryToolNames(messages);
    expect(projected).toEqual([
      { role: "assistant", content },
      { role: "assistant", content: "", toolCalls: calls },
      ...messages.slice(1),
    ]);
    expect(messages).toEqual(before);
  });

  it("does not split empty call carriers or ordinary assistant prose", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: "prose" },
      { role: "assistant", content: "prose", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [{ id: "one", name: "FileRead", arguments: "{}" }] },
      { role: "assistant", content: [], toolCalls: [{ id: "two", name: "FileRead", arguments: "{}" }] },
    ];
    expect(projectOllamaHistoryToolNames(messages)).toEqual([
      ...messages.slice(0, 3),
      { ...messages[3], content: "" },
    ]);
  });

  it("refuses ambiguous names in historical calls", () => {
    expect(() => projectOllamaHistoryToolNames([{ role: "assistant", content: "", toolCalls: [
      { id: "one", name: "mcp.server.read", arguments: "{}" },
      { id: "two", name: "mcp__server__read", arguments: "{}" },
    ] }])).toThrow(/tool-name collision/);
  });
});
