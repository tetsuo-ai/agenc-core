import { expect, test, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { withEditThenRun } from "../../src/tools/edit-then-run.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { createTestConfigStore, mkCtx, mkProvider, mkSession } from "../fixtures.js";

test.each([
  ["AGENC_EDIT_THEN_RUN=1", { AGENC_EDIT_THEN_RUN: "1" }, {}],
  ["lean edit_mode check", {}, { light_request: "lean" as const, light_request_options: { edit_mode: "check" as const } }],
])("a Light fast response edits and checks without another model sample, %s", async (_name, environment, config) => {
  const lean = "light_request" in config;
  const edit = vi.fn(async () => ({ content: "edit applied" }));
  const check = vi.fn(async () => ({ content: "check passed\n\n[exec exit_code=0 wall_time=0.0010s tokens=3]" }));
  const tools = [withEditThenRun({ name: "Write", description: "Write",
    inputSchema: { type: "object" }, execute: edit }, lean),
  { name: "exec_command", description: "Run", inputSchema: { type: "object" }, execute: check }];
  const registry: ToolRegistry = { tools,
    toLLMTools: () => tools.map(tool => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })),
    dispatch: async call => tools.find(tool => tool.name === call.name)!.execute(JSON.parse(call.arguments)),
  };
  const requests: LLMMessage[][] = [];
  let fastCalls = 0;
  const provider = mkProvider();
  if (lean) Object.assign(provider, { name: "deepseek" });
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(structuredClone(messages));
    if (oneShotFastModeActive()) fastCalls++;
    return requests.length === 1
      ? { content: "", toolCalls: [{ id: "edit-check", name: "Write", arguments: '{"check":"npm test"}' }], finishReason: "tool_calls", model: "test-model" }
      : { content: "done", toolCalls: [], finishReason: "stop", model: "test-model" };
  };
  const { session, events } = mkSession({ provider, registry, services: {
    configStore: createTestConfigStore({ base: { provider_outage_wait_ms: 0, ...config } }),
    providerEnvironment: environment,
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
      dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true, exactOutput: true }),
  } });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
    config: { ...mkCtx().config, bypassFastMode: true } });
  const loop = runTurn(session, ctx, "Apply the edit and run its check.", { exactOutput: true });
  let terminal;
  for (;;) { const next = await loop.next(); if (next.done) { terminal = next.value; break; } }
  expect(terminal?.reason).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(fastCalls).toBe(1);
  expect(edit).toHaveBeenCalledOnce();
  expect(check).toHaveBeenCalledOnce();
  const results = requests[1]!.filter(message => message.role === "tool");
  expect(results).toHaveLength(1);
  expect(results[0]!.content).toContain("edit applied");
  expect(results[0]!.content).toContain("check passed");
  expect(results[0]!.content).toContain("[exit 0");
  expect(events.filter(event => event.msg.type === "tool_call_completed")
    .map(event => (event.msg.payload as { toolName?: string }).toolName)).toEqual(["Write", "exec_command"]);
});
