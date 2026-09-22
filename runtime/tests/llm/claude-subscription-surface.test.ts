import { expect, test } from "vitest";
import { buildBootstrapToolRegistry } from "../bin/bootstrap-tool-registry.js";
import { prepareRequest, parseResponse, wireName } from "./providers/claude-subscription/adapter.js";
import type { LLMTool } from "./types.js";

test("every registered built-in tool survives Claude catalog projection and result-name decoding", () => {
  const registry = buildBootstrapToolRegistry({
    workspaceRoot: process.cwd(), getSession: () => null, emitWarning: () => {},
    mcpManager: { getTools: () => [] } as never,
    csvAgentJobsRepositories: { async withRepository() { throw new Error("No execution in catalog qualification"); } },
  });
  const tools: LLMTool[] = registry.tools.map(tool => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
  } }));
  expect(tools.length).toBeGreaterThan(60);
  const request = prepareRequest("sonnet", [{ role: "user", content: "catalog fixture" }], { tools });
  expect(new Set(request.tools.map(tool => tool.function.name)).size).toBe(tools.length);
  for (const tool of tools) {
    const name = tool.function.name;
    const response = parseResponse({ model: "sonnet", choices: [{ finish_reason: "tool_calls", message: {
      content: "", tool_calls: [{ id: "fixture-call", function: { name: wireName(name), arguments: "{}" } }],
    } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, native_admission: { upstream_requests: 1, blocked_requests: 0 } } }, request, { tools });
    expect(response.toolCalls[0]?.name).toBe(name);
  }
  console.log("CLAUDE_CATALOG_QUALIFICATION", JSON.stringify(tools.map(tool => tool.function.name).sort()));
});
