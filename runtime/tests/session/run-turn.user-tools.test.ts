import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { discoverUserToolMentions } from "../../src/session/run-turn-sampling-request.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

function setup(lightMode = true) {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode, requireAdmission: false });
  const provider = mkProvider();
  const { session } = mkSession({ registry, provider, services: {
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode }),
  } });
  return { registry, session, provider };
}

test("an explicitly named deferred tool is present on the first real request", async () => {
  const { registry, session, provider } = setup();
  const initial = registry.toLLMTools();
  expect(initial.map(t => t.function.name)).not.toContain("TodoWrite");
  const requests: string[][] = [];
  provider.chatStream = async (_messages, _onChunk, options) => {
    requests.push((options?.tools ?? []).map(t => t.function.name));
    return { content: "Ready", toolCalls: [], model: "test-model", finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  };
  await drain(runTurn(session, mkCtx(), "Use TodoWrite to record my checklist."));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("TodoWrite");
  expect(registry.toLLMTools().slice(0, initial.length)).toEqual(initial);
  expect(registry.getDiscoveredToolNames?.()).not.toContain("FileRead");
});

test("discovery uses exact user names and stays local to the Light session", () => {
  const one = setup(); const other = setup(); const normal = setup(false);
  discoverUserToolMentions(one.session, "Please fix this file. No checklist is needed.");
  discoverUserToolMentions(one.session, "TodoWriter todoWrite prefix.TodoWrite");
  expect(one.registry.getDiscoveredToolNames?.().size).toBe(0);
  discoverUserToolMentions(one.session, "Use `TodoWrite` and write_stdin; FileRead is already listed.");
  expect(one.registry.getDiscoveredToolNames?.()).toEqual(new Set(["TodoWrite", "write_stdin"]));
  expect(other.registry.getDiscoveredToolNames?.().size).toBe(0);
  discoverUserToolMentions(normal.session, "Use TodoWrite");
  expect(normal.registry.getDiscoveredToolNames?.().size).toBe(0);
});

test("existing direct MCP discovery still applies in normal sessions", () => {
  const { session, registry } = setup(false);
  discoverUserToolMentions(session, "Use mcp.docs.lookup");
  expect(registry.getDiscoveredToolNames?.()).toContain("mcp.docs.lookup");
});
