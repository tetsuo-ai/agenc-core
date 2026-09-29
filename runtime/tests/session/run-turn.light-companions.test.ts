import { expect, test, vi } from "vitest";
import type { LLMResponse } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test("a real Light turn advertises polling immediately after canonical async exec, with no discovery call", async () => {
  const output = (exitCode: number | null): ExecCommandToolOutput => ({
    output: exitCode === null ? "" : "12 passed",
    stdout: exitCode === null ? "" : "12 passed", stderr: "",
    exitCode, exit_code: exitCode, durationMs: 1, wall_time_seconds: 0.001,
    timedOut: exitCode === null, truncated: false, original_token_count: 2,
    ...(exitCode === null ? { process_id: 42 } : {}),
  });
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30_000,
    execCommand: vi.fn(async () => output(null)),
    writeStdin: vi.fn(async () => output(0)),
    closeAll: vi.fn(async () => {}),
  };
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    unifiedExecManager: manager, sandboxExecutionBroker: explicitDangerBroker,
  });
  const requests: string[][] = [];
  const reasoningReplay: Array<boolean | undefined> = [];
  const provider = mkProvider();
  provider.chatStream = async (_messages, _onChunk, options): Promise<LLMResponse> => {
    requests.push((options?.tools ?? []).map((tool) => tool.function.name));
    reasoningReplay.push(options?.openaiReasoningReplay);
    const toolCalls = requests.length === 1
      ? [{ id: "launch", name: "exec_command", arguments: '{"cmd":"python -m pytest","yield_time_ms":1}' }]
      : requests.length === 2
        ? [{ id: "poll", name: "write_stdin", arguments: '{"session_id":42,"chars":""}' }]
        : [];
    return {
      content: toolCalls.length > 0 ? "" : "Done. 12 tests passed.", toolCalls,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model", finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  };
  const { session, events } = mkSession({
    provider, registry,
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      sandboxExecutionBroker: explicitDangerBroker,
      permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext({
        mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
      })),
    },
  });
  const ctx = mkCtx({ sandboxPolicy: { value: "danger_full_access" }, permissionMode: "bypassPermissions" });
  await drain(runTurn(session, ctx, "Run the tests and wait for the result."));
  expect(requests).toHaveLength(3);
  expect(reasoningReplay).toEqual([true, true, true]);
  expect([...requests[0]!].sort()).toEqual([
    "FileRead", "MultiEdit", "Write", "exec_command", "system.searchTools",
  ]);
  expect(requests[0]).not.toContain("write_stdin");
  expect(requests[1]).toContain("write_stdin");
  expect(requests[1]!.slice(0, requests[0]!.length)).toEqual(requests[0]);
  expect(manager.execCommand).toHaveBeenCalledTimes(1);
  expect(manager.writeStdin).toHaveBeenCalledTimes(1);
  const completed = events.filter((event) => event.msg.type === "tool_call_completed")
    .map((event) => event.msg.payload as { toolName: string; isError: boolean });
  expect(completed.map((entry) => entry.toolName)).toEqual(["exec_command", "write_stdin"]);
  expect(completed.every((entry) => !entry.isError)).toBe(true);
});

test("a user-named deferred tool is announced once and still requires normal discovery", async () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true,
    requireAdmission: false, sandboxExecutionBroker: explicitDangerBroker });
  const requests: Array<{ names: string[]; messages: string; system: string }> = [];
  const provider = mkProvider();
  provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
    requests.push({ names: (options?.tools ?? []).map(tool => tool.function.name),
      messages: JSON.stringify(messages), system: options?.systemPrompt ?? "" });
    const toolCalls = requests.length === 1
      ? [{ id: "discover", name: "system.searchTools", arguments: '{"select":"TodoWrite"}' }]
      : requests.length === 2
        ? [{ id: "plan", name: "TodoWrite", arguments: '{"todos":[{"content":"Review the change","activeForm":"Reviewing the change","status":"completed"}]}' }]
        : [];
    return { content: toolCalls.length ? "" : "Done.", toolCalls,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "test-model",
      finishReason: toolCalls.length ? "tool_calls" : "stop" };
  };
  const { session, events } = mkSession({ provider, registry, services: {
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
    sandboxExecutionBroker: explicitDangerBroker,
    permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext({
      mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    })),
  } });
  const prompt = "Use TodoWrite to track the review.";
  await drain(runTurn(session, mkCtx({ sandboxPolicy: { value: "danger_full_access" },
    permissionMode: "bypassPermissions" }), prompt, { rootHumanTurnText: prompt }));
  expect(requests).toHaveLength(3);
  expect(requests[0]!.names).not.toContain("TodoWrite");
  expect(requests[1]!.names).toContain("TodoWrite");
  expect(requests[1]!.names.slice(0, requests[0]!.names.length)).toEqual(requests[0]!.names);
  for (const request of requests) {
    expect(request.messages.match(/Referenced tools available through catalog search/g)).toHaveLength(1);
    expect(request.system).toBe(requests[0]!.system);
  }
  const initial = JSON.parse(requests[0]!.messages);
  for (const request of requests.slice(1)) {
    expect(JSON.parse(request.messages).slice(0, initial.length)).toEqual(initial);
  }
  const completed = events.filter(event => event.msg.type === "tool_call_completed")
    .map(event => event.msg.payload as { toolName: string; isError: boolean });
  expect(completed.map(event => event.toolName)).toEqual(["system.searchTools", "TodoWrite"]);
  expect(completed.every(event => !event.isError)).toBe(true);
});
