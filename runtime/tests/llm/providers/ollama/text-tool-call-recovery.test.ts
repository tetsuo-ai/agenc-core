import { describe, expect, it } from "vitest";
import { diagnoseRejectedTextToolCall } from "../../../../src/llm/providers/ollama/text-tool-call-recovery.js";
import type { LLMTool } from "../../../../src/llm/types.js";

const tool: LLMTool = { type: "function", function: {
  name: "lookup", description: "Read a verification marker",
  parameters: { type: "object", properties: { key: { type: "string", enum: ["verification"] } }, required: ["key"], additionalProperties: false },
} };
const call = (args: unknown) => JSON.stringify({ name: "lookup", arguments: args });

describe("rejected text-tool feedback", () => {
  it("diagnoses a known function with missing arguments without making it executable", () => {
    const diagnosis = diagnoseRejectedTextToolCall(call({}), [tool]);
    expect(diagnosis).toEqual({ toolName: "lookup", reason: "invalid_arguments", message: expect.stringContaining("required property") });
    expect(diagnosis).not.toHaveProperty("toolCalls");
    expect(diagnosis).not.toHaveProperty("arguments");
  });
  it("accepts parameter alias and JSON-encoded argument objects", () => {
    expect(diagnoseRejectedTextToolCall('{"name":"lookup","parameters":{}}', [tool])).toBeDefined();
    expect(diagnoseRejectedTextToolCall(call("{}"), [tool])).toBeDefined();
  });
  it.each([[], ["private-marker-do-not-echo"], null, true, false, 42, "[]", "null", "42", "private-marker-invalid-json"])
    ("diagnoses advertised non-object arguments without coercing or exposing them: %j", args => {
      const diagnosis = diagnoseRejectedTextToolCall(call(args), [tool]);
      expect(diagnosis).toEqual({ toolName: "lookup", reason: "invalid_arguments", message: "Arguments must be a JSON object matching the advertised schema." });
      expect(diagnosis).not.toHaveProperty("toolCalls");
      expect(diagnosis).not.toHaveProperty("arguments");
      expect(JSON.stringify(diagnosis)).not.toContain("private-marker");
    });
  it("applies the same non-object correction to parameters and known-call batches", () => {
    expect(diagnoseRejectedTextToolCall('{"name":"lookup","parameters":[]}', [tool]))
      .toMatchObject({ toolName: "lookup", reason: "invalid_arguments" });
    expect(diagnoseRejectedTextToolCall(`[${call({ key: "verification" })},${call([])}]`, [tool]))
      .toMatchObject({ toolName: "lookup", reason: "invalid_arguments" });
    expect(diagnoseRejectedTextToolCall(`[${call([])},{"name":"unknown","arguments":{}}]`, [tool])).toBeUndefined();
  });
  it("does not mutate or diagnose valid arguments", () => {
    expect(diagnoseRejectedTextToolCall(call({ key: "verification" }), [tool])).toBeUndefined();
  });
  it.each([
    ["```json\n", "\n```"],
    ["```\n", "\n```"],
    ["~~~json\r\n", "\r\n~~~"],
    ["  ````JSON\n", "\n  ````\n"],
  ])("diagnoses a single whole-response fence already recognized by salvage: %s", (open, close) => {
    for (const args of [{}, [], null, "bad-json"]) {
      expect(diagnoseRejectedTextToolCall(open + call(args) + close, [tool]))
        .toMatchObject({ toolName: "lookup", reason: "invalid_arguments" });
    }
    expect(diagnoseRejectedTextToolCall(open + call({ key: "verification" }) + close, [tool])).toBeUndefined();
  });
  it("does not expand fenced diagnosis to unloaded MCP names or mixed unknown batches", () => {
    const search: LLMTool = { ...tool, function: { ...tool.function, name: "system.searchTools" } };
    for (const body of [
      '{"name":"mcp.server.lookup","arguments":{}}',
      '{"name":"mcp__server__lookup","arguments":{}}',
      `[${call({})},{"name":"mcp.server.lookup","arguments":{}}]`,
    ]) {
      expect(diagnoseRejectedTextToolCall("```json\n" + body + "\n```", [tool, search])).toBeUndefined();
    }
    expect(diagnoseRejectedTextToolCall("```json\n" + call({}) + "\n```", [search])).toBeUndefined();
  });
  it("requires every batch member to be a known call envelope", () => {
    expect(diagnoseRejectedTextToolCall(`[${call({ key: "verification" })},${call({})}]`, [tool])).toBeDefined();
    expect(diagnoseRejectedTextToolCall(`[${call({})},{"name":"unknown","arguments":{}}]`, [tool])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(`[${call({})},{"data":"example"}]`, [tool])).toBeUndefined();
  });
  it.each([
    'Example: {"name":"lookup","arguments":{}}',
    'Example:\n```json\n{"name":"lookup","arguments":{}}\n```',
    '```json\n{"name":"lookup","arguments":{}}\n```\nThis is an example.',
    '```javascript\n{"name":"lookup","arguments":{}}\n```',
    '```json\n{"name":"lookup","arguments":{}}\n```\n```json\n{"name":"lookup","arguments":{}}\n```',
    '```json\n{"name":"lookup","arguments":{}}\n',
    '```json\n{"name":"lookup","arguments":{}}\n~~~',
    '```json\n{"example":{"name":"lookup","arguments":{}}}\n```',
    '```json\n{"name":"lookup","arguments":{},"description":"example"}\n```',
    '{"name":"lookup","arguments":{}}\nThis is an example.',
    '{"example":{"name":"lookup","arguments":{}}}',
    '{"name":"unknown","arguments":{}}',
    '{"name":"lookup","arguments":{},"description":"example"}',
    '{"name":"lookup","arguments":{},"parameters":{}}',
    '{"name":"lookup","arguments":',
    'Example: {"name":"lookup","arguments":[]}',
    'Example:\n```json\n{"name":"lookup","arguments":[]}\n```',
    '{"name":"lookup","arguments":[]}\nThis is an example.',
    '{"example":{"name":"lookup","arguments":[]}}',
    '{"name":"lookup","arguments":[],"description":"example"}',
    '{"name":"lookup","arguments":[],"parameters":{}}',
    '{"name":"lookup","arguments":{"key":1e999}}',
    '[]',
  ])("preserves non-diagnostic content: %s", content => {
    expect(diagnoseRejectedTextToolCall(content, [tool])).toBeUndefined();
  });
  it("requires the exact advertised catalog", () => {
    expect(diagnoseRejectedTextToolCall(call({}), undefined)).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(call({}), [])).toBeUndefined();
  });
  it("only diagnoses unloaded MCP calls when discovery is actually available", () => {
    const search: LLMTool = { ...tool, function: { ...tool.function, name: "system.searchTools" } };
    const content = '{"name":"mcp.agenc-desktop-control.browser_open_tab","arguments":{"url":"https://example.com"}}';
    expect(diagnoseRejectedTextToolCall(content, [tool])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(content, [tool, search])).toMatchObject({ toolName: "mcp.agenc-desktop-control.browser_open_tab", reason: "not_advertised" });
    expect(diagnoseRejectedTextToolCall(content.replace("mcp.agenc-desktop-control.browser_open_tab", "mcp__agenc-desktop-control__browser_open_tab"), [search])).toMatchObject({ toolName: "mcp.agenc-desktop-control.browser_open_tab", reason: "not_advertised" });
    expect(diagnoseRejectedTextToolCall('{"name":"mcp.fake.newline\\nattack","arguments":{}}', [search])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall('{"name":"made-up-function","arguments":{}}', [search])).toBeUndefined();
    for (const args of [[], null, 42, "[]", "private-marker-invalid-json"]) {
      for (const name of ["made-up-function", "mcp.server.lookup", "mcp__server__lookup"]) {
        expect(diagnoseRejectedTextToolCall(JSON.stringify({ name, arguments: args }), [tool, search])).toBeUndefined();
      }
    }
  });
  it("does not echo rejected values", () => {
    const diagnosis = diagnoseRejectedTextToolCall(call({ key: "private-marker-do-not-echo" }), [tool]);
    expect(diagnosis).toBeDefined();
    expect(diagnosis!.message).not.toContain("private-marker");
  });
  it("does not infer schema validity for an unsupported schema", () => {
    const unsupported = { ...tool, function: { ...tool.function, parameters: { $ref: "https://invalid.example/schema" } } };
    expect(diagnoseRejectedTextToolCall(call({}), [unsupported])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(call([]), [unsupported])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall("```json\n" + call({}) + "\n```", [unsupported])).toBeUndefined();
  });
  it("bounds response size, batch size and nesting", () => {
    expect(diagnoseRejectedTextToolCall(" ".repeat(1_048_577) + call({}), [tool])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(`[${Array.from({ length: 65 }, () => call({})).join(",")}]`, [tool])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(call({ key: JSON.parse("[".repeat(65) + "0" + "]".repeat(65)) }), [tool])).toBeUndefined();
    expect(diagnoseRejectedTextToolCall(call("[".repeat(65) + "0" + "]".repeat(65)), [tool])).toBeUndefined();
  });
});
