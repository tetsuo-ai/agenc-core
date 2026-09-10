import { describe, expect, it, vi } from "vitest";
import { __createDeferredDaemonPromptTuiSessionForTest } from "../../src/bin/agenc-main.js";
import { ConfigStore } from "../../src/config/store.js";
import { DENIED } from "../../src/permissions/review-decision.js";
import type { WorkflowApprovalControls } from "../../src/tui/workflow-approval-controls.js";

describe("cold deferred workflow controls", () => {
  it("cancels a connecting panel without dispatching and closes the shared connection", async () => {
    const request = vi.fn();
    const close = vi.fn(async () => {});
    let connectReady!: (client: { request: typeof request; close: typeof close }) => void;
    const connect = vi.fn(() => new Promise<{ request: typeof request; close: typeof close }>(resolve => { connectReady = resolve; }));
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: { services: { configStore: new ConfigStore({ env: {} }) } },
      deps: { createConnectedTuiClient: connect } as never,
      agencHome: process.cwd(), env: {}, cwd: process.cwd(), clientId: "cancelled-workflow-controls-test",
    });
    const controller = new AbortController();
    const session = deferred.session as { workflowApprovalControls: WorkflowApprovalControls };
    const listing = session.workflowApprovalControls.list("wf-owner", controller.signal);
    const failedListing = expect(listing).rejects.toThrow();
    controller.abort();
    connectReady({ request, close });
    await failedListing;
    expect(request).not.toHaveBeenCalled();
    await deferred.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retries failed connection establishment but never replays an ambiguous approval", async () => {
    const pending = { ownerRunId: "wf-owner", requestId: "request-one", sessionId: "child-one", toolName: "Read", input: {} };
    const request = vi.fn(async (method: string) => {
      if (method === "permission.list") return { permissions: [], pendingRequests: [pending] };
      throw new Error("connection lost after dispatch");
    });
    const connect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ request, close: async () => {} });
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: { services: { configStore: new ConfigStore({ env: {} }) } },
      deps: { createConnectedTuiClient: connect } as never,
      agencHome: process.cwd(), env: {}, cwd: process.cwd(), clientId: "retry-workflow-controls-test",
    });
    try {
      const session = deferred.session as { workflowApprovalControls: WorkflowApprovalControls };
      const signal = new AbortController().signal;
      await expect(session.workflowApprovalControls.list("wf-owner", signal)).rejects.toThrow("offline");
      expect(await session.workflowApprovalControls.list("wf-owner", signal)).toEqual([pending]);
      await expect(session.workflowApprovalControls.respond(pending, DENIED, "response", signal)).rejects.toThrow("after dispatch");
      expect(connect).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([method]) => method === "tool.deny")).toHaveLength(1);
    } finally {
      await deferred.close();
    }
  });

  it("resolves workflow requests without starting an unrelated coding turn", async () => {
    const pending = { ownerRunId: "wf-owner", requestId: "request-one", sessionId: "child-one", toolName: "Read", input: { file_path: "fixture" } };
    const request = vi.fn(async (method: string) => method === "permission.list" ? { permissions: [], pendingRequests: [pending] } : { requestId: pending.requestId, decision: "denied" });
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ request, close }));
    const startPromptAgent = vi.fn();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: { services: { configStore: new ConfigStore({ env: {} }) } },
      deps: { createConnectedTuiClient: connect, startPromptAgent } as never,
      agencHome: process.cwd(), env: {}, cwd: process.cwd(), clientId: "workflow-controls-test",
    });
    try {
      const session = deferred.session as { workflowApprovalControls: WorkflowApprovalControls };
      expect(connect).not.toHaveBeenCalled();
      const signal = new AbortController().signal;
      expect(await session.workflowApprovalControls.list("wf-owner", signal)).toEqual([pending]);
      expect(await session.workflowApprovalControls.respond(pending, DENIED, "response", signal)).toBe(true);
      expect(request).toHaveBeenLastCalledWith("tool.deny", { sessionId: "wf-owner", requestId: pending.requestId, reason: "denied" }, { signal });
      expect(connect).toHaveBeenCalledOnce();
      expect(startPromptAgent).not.toHaveBeenCalled();
      await deferred.close();
      expect(close).toHaveBeenCalledOnce();
      await expect(session.workflowApprovalControls.list("wf-owner", signal)).rejects.toThrow("closed");
    } finally {
      await deferred.close();
    }
  });
});
