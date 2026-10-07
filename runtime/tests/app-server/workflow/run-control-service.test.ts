import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonWorkflowControlService } from "../../../src/app-server/workflow/run-control-service.js";
import { getCurrentRuntimeSession, setCurrentRuntimeSession } from "../../../src/session/current-session.js";
import type { Session } from "../../../src/session/session.js";

afterEach(() => setCurrentRuntimeSession(null));

describe("workflow control service session authority", () => {
  it("isolates controls from ambiguous foreground sessions and preserves the controller result", async () => {
    setCurrentRuntimeSession({ sessionConfiguration: { cwd: "/one" } } as Session);
    setCurrentRuntimeSession({ sessionConfiguration: { cwd: "/two" } } as Session);
    expect(() => getCurrentRuntimeSession()).toThrow(/Ambiguous runtime session/);
    const pending = { runId: "run-1", state: "pause_requested" as const, requestId: "pause-1" };
    const running = { runId: "run-1", state: "running" as const };
    const controller = {
      requestPause: vi.fn(async () => {
        await Promise.resolve();
        expect(getCurrentRuntimeSession()).toBeNull();
        return pending;
      }),
      resumePaused: vi.fn(async () => {
        await Promise.resolve();
        expect(getCurrentRuntimeSession()).toBeNull();
        return running;
      }),
    };
    const service = new DaemonWorkflowControlService(controller);
    const pause = { runId: "run-1", requestId: "pause-1" };
    const resume = { runId: "run-1", suspensionId: "suspension-1" };
    expect(await service.pauseRun(pause)).toBe(pending);
    expect(await service.resumeRun(resume)).toBe(running);
    expect(controller.requestPause).toHaveBeenCalledExactlyOnceWith(pause);
    expect(controller.resumePaused).toHaveBeenCalledExactlyOnceWith(resume);
    expect(() => getCurrentRuntimeSession()).toThrow(/Ambiguous runtime session/);
  });

  it("propagates durable-control failure instead of returning a success state", async () => {
    const failure = new Error("durable checkpoint unavailable");
    const service = new DaemonWorkflowControlService({
      requestPause: async () => { throw failure; },
      resumePaused: async () => { throw failure; },
    });
    await expect(service.pauseRun({ runId: "run-1", requestId: "pause-1" })).rejects.toBe(failure);
    await expect(service.resumeRun({ runId: "run-1", suspensionId: "suspension-1" })).rejects.toBe(failure);
  });
});
