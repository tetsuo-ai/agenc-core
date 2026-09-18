import { describe, expect, it, vi } from "vitest";
import { createDaemonRoutineExecutor, routineSessionEnvironment } from "../../src/routines/daemon-executor.js";
import { RoutineExecutionUnsettledError } from "../../src/routines/service.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";

function fixture(environment?: Record<string, string | undefined>) {
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: "agent", sessionId: "session" })),
    streamAgentMessage: vi.fn(() => new Promise<never>(() => {})),
    cancelRunTree: vi.fn(async () => ({ runId: "agent" })),
    stopAgent: vi.fn(async () => ({ agentId: "agent", stopped: true })),
    finishRoutineRun: vi.fn(async () => {}),
  };
  const executor = createDaemonRoutineExecutor({ agentManager: manager as never, ...(environment ? { environment } : {}), runtimeOptions: { simpleMode: false, dangerouslyBypassApprovalsAndSandbox: false, stdinDataMode: false, remoteMode: false, allowUntrustedHooks: false, pluginStorageRoot: "/fixture/plugins", sessionTempRoot: "/fixture/tmp" } as AgentRuntimeOptions });
  const controller = new AbortController();
  const routine = { id: "routine", name: "Check", instructions: "Inspect", cwd: "/fixture", permissionMode: "plan" } as Routine;
  const run = { id: "routine-run" } as RoutineRun;
  return { manager, executor, controller, routine, run };
}

describe("routine agent environment", () => {
  it("forwards only the canonical client environment from the daemon process", async () => {
    const f = fixture({ DEEPSEEK_API_KEY: "key-a", AGENC_CREDENTIAL_MCP_TOKEN: "key-b", AGENC_PROVIDER: "xai", AGENC_MODEL: "grok", SHELL_SECRET: "never", EMPTY_API_KEY: "" });
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await expect(f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() })).resolves.toBe("completed");
    const params = f.manager.createAgent.mock.calls[0]?.[0] as { envOverrides?: Record<string, string> };
    expect(params.envOverrides).toEqual({ DEEPSEEK_API_KEY: "key-a", AGENC_CREDENTIAL_MCP_TOKEN: "key-b" });
  });
  it("omits envOverrides entirely when the daemon environment holds nothing forwardable", async () => {
    const f = fixture({ SHELL_SECRET: "never" });
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() });
    expect(f.manager.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("envOverrides");
  });
  it("snapshots the environment once and drops empty values", () => {
    expect(routineSessionEnvironment({ XAI_API_KEY: "", DEEPSEEK_API_KEY: "k" })).toEqual({ DEEPSEEK_API_KEY: "k" });
    expect(Object.isFrozen(routineSessionEnvironment({}))).toBe(true);
  });
});

describe("routine execution finalization", () => {
  it("records canonical completion through the settled-message seam", async () => {
    const f = fixture(); f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await expect(f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() })).resolves.toBe("completed");
    expect(f.manager.finishRoutineRun).toHaveBeenCalledWith("agent", expect.stringMatching(/^routine_message_/));
    expect(f.manager.stopAgent).not.toHaveBeenCalled();
  });
  it("finishes cancellation without waiting for an orphaned stream promise", async () => {
    const f = fixture(); const executing = f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() });
    await vi.waitFor(() => expect(f.manager.streamAgentMessage).toHaveBeenCalledOnce()); f.controller.abort();
    await expect(executing).resolves.toBe("cancelled"); expect(f.manager.cancelRunTree).toHaveBeenCalledOnce();
  });
  it("revokes execution with Core stop when canonical cancellation fails", async () => {
    const f = fixture(); f.manager.cancelRunTree.mockRejectedValue(new Error("cancel failed"));
    const executing = f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() });
    await vi.waitFor(() => expect(f.manager.streamAgentMessage).toHaveBeenCalledOnce()); f.controller.abort();
    await expect(executing).rejects.toThrow("cancel failed"); expect(f.manager.stopAgent).toHaveBeenCalledOnce();
  });
  it("reports unsettled execution if neither cancellation nor stop can prove quiescence", async () => {
    const f = fixture(); f.manager.cancelRunTree.mockRejectedValue(new Error("cancel failed")); f.manager.stopAgent.mockRejectedValue(new Error("stop failed"));
    const executing = f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() });
    await vi.waitFor(() => expect(f.manager.streamAgentMessage).toHaveBeenCalledOnce()); f.controller.abort();
    await expect(executing).rejects.toBeInstanceOf(RoutineExecutionUnsettledError);
  });
});
