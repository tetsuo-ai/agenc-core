import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { attachToolRuntimeContext } from "../../src/tools/runtimes/context.js";
import type { UnifiedExecProcessManagerLike } from "../../src/unified-exec/types.js";
import { createTestConfigStore, mkCtx, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test.each([
  { parentLean: true, provider: "openai", lightMode: true, childLean: true, refused: false },
  { parentLean: true, provider: "deepseek", lightMode: false, childLean: true, refused: false },
  { parentLean: true, provider: "deepseek", lightMode: true, childLean: false, refused: false },
  { parentLean: false, provider: "deepseek", lightMode: true, childLean: true, refused: true },
])("exec process restrictions belong to the invoking child: %j", async ({ parentLean, provider, lightMode, childLean, refused }) => {
  const makeSession = (name: string, light: boolean, lean: boolean) => {
    const { session } = mkSession({ services: {
      runtimeOptions: { lightMode: light } as never,
      configStore: createTestConfigStore({ base: {
        light_request: lean ? "lean" : "full", light_request_options: { process_tools: false },
      } }),
    } });
    Object.assign(session.services.provider, { name });
    return session;
  };
  const parent = makeSession("deepseek", true, parentLean);
  const child = makeSession(provider, lightMode, childLean);
  const execCommand = vi.fn(async () => ({ output: "child", stdout: "child", stderr: "", exitCode: 0, exit_code: 0,
    wall_time_seconds: 0.01, durationMs: 10, original_token_count: 1, timedOut: false, truncated: false }));
  const manager = { maxTimeoutMs: Infinity, execCommand, writeStdin: vi.fn(), closeAll: vi.fn() } as unknown as UnifiedExecProcessManagerLike;
  // Children wrap these parent-owned tool implementations at dispatch.
  const registry = buildToolRegistry({ workspaceRoot: process.cwd(), lightMode: true, getSession: () => parent,
    unifiedExecManager: manager, sandboxExecutionBroker: explicitDangerBroker });
  const exec = registry.tools.find(tool => tool.name === "exec_command")!;
  const args = { cmd: "printf child", background: true };
  attachToolRuntimeContext(args, {
    callId: "child-exec", toolName: "exec_command", runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0,
    approvalPolicy: "never", requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access",
    approvalResolved: true, rawArgs: JSON.stringify(args),
    invocation: { session: child, turn: mkCtx(), payload: { kind: "function", arguments: JSON.stringify(args) } },
  } as never);
  const result = await exec.execute(args);
  if (refused) {
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Process tools are disabled");
    expect(execCommand).not.toHaveBeenCalled();
  } else {
    expect(result.isError).not.toBe(true);
    expect(execCommand).toHaveBeenCalledWith(expect.objectContaining({ startInBackground: true }));
  }
});
