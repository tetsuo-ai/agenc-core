import { describe, expect, it, vi } from "vitest";
import { createDaemonRoutineExecutor, providerEnvironmentKeys, routineSessionEnvironment } from "../../src/routines/daemon-executor.js";
import { RoutineExecutionUnsettledError } from "../../src/routines/service.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";

function fixture(environment?: Record<string, string | undefined>, defaultProvider?: () => string | undefined) {
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: "agent", sessionId: "session" })),
    streamAgentMessage: vi.fn(() => new Promise<never>(() => {})),
    cancelRunTree: vi.fn(async () => ({ runId: "agent" })),
    stopAgent: vi.fn(async () => ({ agentId: "agent", stopped: true })),
    finishRoutineRun: vi.fn(async () => {}),
  };
  const executor = createDaemonRoutineExecutor({ agentManager: manager as never, ...(environment ? { environment } : {}), ...(defaultProvider ? { defaultProvider } : {}), runtimeOptions: { simpleMode: false, dangerouslyBypassApprovalsAndSandbox: false, stdinDataMode: false, remoteMode: false, allowUntrustedHooks: false, pluginStorageRoot: "/fixture/plugins", sessionTempRoot: "/fixture/tmp" } as AgentRuntimeOptions });
  const controller = new AbortController();
  const routine = { id: "routine", name: "Check", instructions: "Inspect", cwd: "/fixture", permissionMode: "plan" } as Routine;
  const run = { id: "routine-run" } as RoutineRun;
  return { manager, executor, controller, routine, run };
}

const AMBIENT = {
  PATH: "/usr/bin", DEEPSEEK_API_KEY: "deepseek-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/v1",
  XAI_API_KEY: "other-provider-key", MODEL_API_KEY: "meta-key", AGENC_CREDENTIAL_MCP_TOKEN: "mcp-bearer",
  AGENC_SESSION_ACCESS_TOKEN: "session-token", AGENC_REMOTE_SESSION_ID: "remote-id", AGENC_BROWSER_NO_SANDBOX: "1",
  AGENC_PROVIDER: "xai", AGENC_MODEL: "grok", SHELL_SECRET: "never",
};
const envOverridesOf = (f: ReturnType<typeof fixture>) => (f.manager.createAgent.mock.calls[0]?.[0] as { envOverrides?: Record<string, string> }).envOverrides;

describe("routine agent environment", () => {
  it("forwards only PATH and the selected provider's own variables", async () => {
    const f = fixture(AMBIENT);
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await expect(f.executor.execute({ ...f.routine, provider: "deepseek" }, f.run, { signal: f.controller.signal, bind: vi.fn() })).resolves.toBe("completed");
    expect(envOverridesOf(f)).toEqual({ PATH: "/usr/bin", DEEPSEEK_API_KEY: "deepseek-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/v1" });
  });
  it("uses the daemon's default provider when the routine names none", async () => {
    const f = fixture(AMBIENT, () => "meta");
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() });
    expect(envOverridesOf(f)).toEqual({ PATH: "/usr/bin", MODEL_API_KEY: "meta-key" });
  });
  it("forwards only PATH for an unknown provider and omits envOverrides when nothing applies", async () => {
    const f = fixture(AMBIENT);
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await f.executor.execute({ ...f.routine, provider: "no-such-provider" }, f.run, { signal: f.controller.signal, bind: vi.fn() });
    expect(envOverridesOf(f)).toEqual({ PATH: "/usr/bin" });
    const g = fixture({ SHELL_SECRET: "never", AGENC_CREDENTIAL_MCP_TOKEN: "mcp-bearer" });
    g.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    await g.executor.execute({ ...g.routine, provider: "deepseek" }, g.run, { signal: g.controller.signal, bind: vi.fn() });
    expect(g.manager.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("envOverrides");
  });
  it("never forwards MCP bearers, session or remote tokens, browser flags or another provider's key", () => {
    const forwarded = routineSessionEnvironment(AMBIENT, "deepseek");
    for (const key of ["AGENC_CREDENTIAL_MCP_TOKEN", "AGENC_SESSION_ACCESS_TOKEN", "AGENC_REMOTE_SESSION_ID", "AGENC_BROWSER_NO_SANDBOX", "AGENC_PROVIDER", "AGENC_MODEL", "XAI_API_KEY", "MODEL_API_KEY", "SHELL_SECRET"]) {
      expect(forwarded).not.toHaveProperty(key);
    }
    expect(routineSessionEnvironment(AMBIENT, undefined)).toEqual({ PATH: "/usr/bin" });
  });
  it("derives the provider's variables from the registry and drops empty values", () => {
    expect([...providerEnvironmentKeys("deepseek")].sort()).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);
    expect(providerEnvironmentKeys("no-such-provider")).toEqual([]);
    expect(routineSessionEnvironment({ DEEPSEEK_API_KEY: "", PATH: "/p" }, "deepseek")).toEqual({ PATH: "/p" });
    expect(Object.isFrozen(routineSessionEnvironment({}, "deepseek"))).toBe(true);
  });
});

describe("routine execution finalization", () => {
  it("preserves the canonical permission denial even when the model finishes its answer", async () => {
    const f = fixture();
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    f.manager.finishRoutineRun.mockImplementation(async () => "permission_denied" as never);
    await expect(f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() })).resolves.toBe("permission_denied");
    expect(f.manager.stopAgent).not.toHaveBeenCalled();
  });
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
