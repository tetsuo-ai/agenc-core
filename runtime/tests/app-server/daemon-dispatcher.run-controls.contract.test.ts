import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher, type AgenCDaemonWorkflowStartService } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonWorkflowControlError } from "../../src/app-server/workflow/run-control-service.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

async function connect(controls?: Partial<AgenCDaemonWorkflowStartService>) {
  const startRun = vi.fn();
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: new AgenCDaemonAgentManager(),
    ...(controls === undefined ? {} : { workflow: { startRun, ...controls } }),
  });
  const connection = dispatcher.createConnection();
  const initialized = await connection.dispatch({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocol: { version: "1.0.0" } },
  });
  const dispatch = (method: string, params: JsonObject) => connection.dispatch({
    jsonrpc: "2.0", id: method, method, params,
  });
  return { initialized, dispatch, startRun };
}

describe("workflow pause and resume transport", () => {
  it("advertises controls only when each backend method is wired", async () => {
    const bare = await connect();
    expect(bare.initialized).toMatchObject({ result: { capabilities: {
      "daemon.methods": { "run.pause": false, "run.resume": false },
    } } });
    expect(await bare.dispatch("run.pause", { runId: "run-1", requestId: "pause-1" }))
      .toMatchObject({ error: { code: -32601 } });
    const partial = await connect({ pauseRun: vi.fn() });
    expect(partial.initialized).toMatchObject({ result: { capabilities: {
      "daemon.methods": { "run.pause": true, "run.resume": false },
    } } });
  });

  it("returns the pending checkpoint state and resumes the exact suspension", async () => {
    const pauseRun = vi.fn(async () => ({ runId: "run-1", state: "pause_requested" as const, requestId: "pause-1" }));
    const resumeRun = vi.fn(async () => ({ runId: "run-1", state: "running" as const }));
    const { dispatch, startRun } = await connect({ pauseRun, resumeRun });
    expect(await dispatch("run.pause", { runId: "run-1", requestId: "pause-1" }))
      .toMatchObject({ result: { runId: "run-1", state: "pause_requested", requestId: "pause-1" } });
    const resume = { runId: "run-1", suspensionId: "pause:run-1:1", envOverrides: { DEEPSEEK_API_KEY: "test-only" } };
    expect(await dispatch("run.resume", resume)).toMatchObject({ result: { runId: "run-1", state: "running" } });
    expect(pauseRun).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", requestId: "pause-1" });
    expect(resumeRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runId: resume.runId,
      suspensionId: resume.suspensionId,
      envOverrides: expect.objectContaining({ DEEPSEEK_API_KEY: "test-only", XAI_API_KEY: "" }),
    }));
    expect(startRun).not.toHaveBeenCalled();
  });

  it("rejects missing identity, stale-control alternatives, and budget or authority changes before delegation", async () => {
    const pauseRun = vi.fn();
    const resumeRun = vi.fn();
    const { dispatch } = await connect({ pauseRun, resumeRun });
    for (const params of [
      { runId: "run-1" },
      { runId: "run-1", requestId: "" },
      { runId: "run-1", requestId: "x".repeat(129) },
      { runId: "run-1", requestId: "pause-1", maxCostUsd: 20 },
      { runId: "run-1", requestId: "pause-1", envOverrides: { DEEPSEEK_API_KEY: "test-only" } },
    ]) {
      expect(await dispatch("run.pause", params)).toMatchObject({ error: { code: -32602 } });
    }
    for (const params of [
      { runId: "run-1" },
      { runId: "run-1", suspensionId: "../pause" },
      { runId: "run-1", suspensionId: "x".repeat(513) },
      { runId: "run-1", suspensionId: "pause-1", maxCostUsd: 20 },
      { runId: "run-1", suspensionId: "pause-1", envOverrides: { AGENC_HOME: "/other" } },
    ]) {
      expect(await dispatch("run.resume", params)).toMatchObject({ error: { code: -32602 } });
    }
    expect(pauseRun).not.toHaveBeenCalled();
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("preserves a controller conflict as an actionable error", async () => {
    const { dispatch } = await connect({ resumeRun: async () => {
      throw new AgenCDaemonWorkflowControlError("WORKFLOW_CONTROL_CONFLICT", "This suspension is no longer current");
    } });
    expect(await dispatch("run.resume", { runId: "run-1", suspensionId: "old-pause" }))
      .toMatchObject({ error: { code: -32602, message: "This suspension is no longer current", data: { code: "WORKFLOW_CONTROL_CONFLICT" } } });
  });
});
