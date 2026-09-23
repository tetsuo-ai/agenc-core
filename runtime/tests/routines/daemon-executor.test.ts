import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDaemonRoutineExecutor, providerEnvironmentKeys, routineSessionEnvironment } from "../../src/routines/daemon-executor.js";
import { RoutineExecutionUnsettledError, RoutineService } from "../../src/routines/service.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";

function fixture(environment?: Record<string, string | undefined>, defaultProvider?: () => string | undefined) {
  const manager = {
    createAgent: vi.fn(async () => ({ agentId: "agent", sessionId: "session" })),
    streamAgentMessage: vi.fn(() => new Promise<never>(() => {})),
    cancelRunTree: vi.fn(async () => ({ runId: "agent" })),
    stopAgent: vi.fn(async () => ({ agentId: "agent", stopped: true })),
    finishRoutineRun: vi.fn(async () => "completed" as const),
  };
  const executor = createDaemonRoutineExecutor({ agentManager: manager as never, ...(environment ? { environment } : {}), ...(defaultProvider ? { defaultProvider } : {}), runtimeOptions: { simpleMode: false, dangerouslyBypassApprovalsAndSandbox: false, stdinDataMode: false, remoteMode: false, allowUntrustedHooks: false, pluginStorageRoot: "/fixture/plugins", sessionTempRoot: "/fixture/tmp" } as AgentRuntimeOptions });
  const controller = new AbortController();
  const routine = { id: "routine", name: "Check", instructions: "Inspect", cwd: "/fixture", permissionMode: "plan" } as Routine;
  const run = { id: "routine-run" } as RoutineRun;
  return { manager, executor, controller, routine, run };
}

function routineService(f: ReturnType<typeof fixture>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-routine-terminal-")));
  const cwd = join(home, "project"); mkdirSync(cwd);
  const service = new RoutineService({ home, executor: f.executor }); service.start();
  const routine = service.create({ name: "Check", instructions: "Inspect", cwd, schedule: { kind: "manual" } }).routine;
  return { service, routine, cleanup: async () => { await service.close(); rmSync(home, { recursive: true, force: true }); } };
}

function failedCoreTerminal(service: RoutineService, routineId: string, terminalRunId?: string, stopReason?: string): void {
  const run = service.runs({ id: routineId }).runs[0]!;
  service.observeSessionEvent(run.sessionId!, {
    method: "event.session_event",
    params: { agentId: run.agentId, runId: run.coreRunId, eventId: "terminal:agent:1", sequence: 3,
      event: { type: "run_terminal", payload: { runId: terminalRunId ?? run.coreRunId, status: "failed", exitCode: 1,
        ...(stopReason ? { stopReason } : {}) } } },
  });
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

  it("requires stop confirmation when the finish seam has no outcome", async () => {
    const f = fixture();
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 1 } }) as never);
    f.manager.finishRoutineRun.mockImplementation(async () => undefined as never);
    f.manager.stopAgent.mockRejectedValue(new Error("stop failed"));
    await expect(f.executor.execute(f.routine, f.run, { signal: f.controller.signal, bind: vi.fn() }))
      .rejects.toBeInstanceOf(RoutineExecutionUnsettledError);
  });

  it("settles a failed Core terminal after stopping its ended agent throws", async () => {
    const f = fixture();
    f.manager.streamAgentMessage.mockRejectedValue(new Error("turn failed"));
    f.manager.stopAgent.mockRejectedValue(Object.assign(new Error("agent already ended"), { code: "AGENT_NOT_FOUND" }));
    const h = routineService(f);
    try {
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(h.service.runs({ id: h.routine.id }).runs[0]?.error).toContain("could not confirm"));
      expect(h.service.runs({ id: h.routine.id }).runs[0]).toMatchObject({ status: "running", finishedAt: null });
      failedCoreTerminal(h.service, h.routine.id);
      expect(h.service.runs({ id: h.routine.id }).runs[0]).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
      expect(h.service.delete({ id: h.routine.id })).toEqual({ deleted: true });
    } finally { await h.cleanup(); }
  });

  it("settles a failed Core terminal while the message submission promise is pending", async () => {
    const f = fixture();
    let agentNumber = 0;
    f.manager.createAgent.mockImplementation(async () => { const number = ++agentNumber; return { agentId: `agent-${number}`, sessionId: `session-${number}` }; });
    let finishMessage!: (value: never) => void;
    f.manager.streamAgentMessage.mockImplementationOnce(() => new Promise<never>((resolve) => { finishMessage = resolve; }));
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    const execute = vi.spyOn(f.executor, "execute");
    const h = routineService(f);
    try {
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(f.manager.streamAgentMessage).toHaveBeenCalledOnce());
      failedCoreTerminal(h.service, h.routine.id, "another-agent");
      expect(h.service.runs({ id: h.routine.id }).runs[0]?.status).toBe("running");
      failedCoreTerminal(h.service, h.routine.id);
      await vi.waitFor(() => expect(h.service.runs({ id: h.routine.id }).runs[0]?.status).toBe("failed"));
      await expect(execute.mock.results[0]?.value).resolves.toBe("failed");
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(h.service.runs({ id: h.routine.id }).runs[0]?.status).toBe("completed"));
      expect(h.service.delete({ id: h.routine.id })).toEqual({ deleted: true });
    } finally {
      finishMessage?.({ terminal: { code: 1 } } as never);
      await h.cleanup();
    }
  });

  it("uses a later failed Core terminal when the finish seam had no outcome", async () => {
    const f = fixture();
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    f.manager.finishRoutineRun.mockImplementation(async () => undefined as never);
    const h = routineService(f);
    try {
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(h.service.runs({ id: h.routine.id }).runs[0]?.status).toBe("completed"));
      expect(f.manager.finishRoutineRun).toHaveBeenCalledOnce();
      failedCoreTerminal(h.service, h.routine.id);
      expect(h.service.runs({ id: h.routine.id }).runs[0]).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
    } finally { await h.cleanup(); }
  });

  it("keeps the permission denial explanation when Core settles during finalization", async () => {
    const f = fixture();
    f.manager.streamAgentMessage.mockImplementation(async () => ({ terminal: { code: 0 } }) as never);
    let finish!: (value: never) => void;
    f.manager.finishRoutineRun.mockImplementation(() => new Promise<never>((resolve) => { finish = resolve; }));
    const h = routineService(f);
    try {
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(f.manager.finishRoutineRun).toHaveBeenCalledOnce());
      failedCoreTerminal(h.service, h.routine.id, undefined, "routine_permission_denied");
      expect(h.service.runs({ id: h.routine.id }).runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("read-only permissions") });
    } finally {
      finish?.("permission_denied" as never);
      await h.cleanup();
    }
  });

  it("finishes cancellation when Core ends before a pending cancellation call returns", async () => {
    const f = fixture();
    let finishCancellation!: () => void;
    f.manager.cancelRunTree.mockImplementation(() => new Promise((resolve) => { finishCancellation = () => resolve({ runId: "agent" }); }));
    const h = routineService(f);
    try {
      h.service.run({ id: h.routine.id });
      await vi.waitFor(() => expect(f.manager.streamAgentMessage).toHaveBeenCalledOnce());
      const cancelling = h.service.cancel({ id: h.routine.id });
      await vi.waitFor(() => expect(f.manager.cancelRunTree).toHaveBeenCalledOnce());
      failedCoreTerminal(h.service, h.routine.id);
      await expect(cancelling).resolves.toMatchObject({ run: { status: "failed", finishedAt: expect.any(String) } });
    } finally {
      finishCancellation?.();
      await h.cleanup();
    }
  });
});
