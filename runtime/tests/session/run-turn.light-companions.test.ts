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
  const provider = mkProvider();
  provider.chatStream = async (_messages, _onChunk, options): Promise<LLMResponse> => {
    requests.push((options?.tools ?? []).map((tool) => tool.function.name));
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
  expect([...requests[0]!].sort()).toEqual([
    "FileRead", "MultiEdit", "Write", "exec_command",
  ]);
  expect(requests[0]).not.toContain("write_stdin");
  expect(requests[1]).toContain("write_stdin");
  expect(manager.execCommand).toHaveBeenCalledTimes(1);
  expect(manager.writeStdin).toHaveBeenCalledTimes(1);
  const completed = events.filter((event) => event.msg.type === "tool_call_completed")
    .map((event) => event.msg.payload as { toolName: string; isError: boolean });
  expect(completed.map((entry) => entry.toolName)).toEqual(["exec_command", "write_stdin"]);
  expect(completed.every((entry) => !entry.isError)).toBe(true);
});
