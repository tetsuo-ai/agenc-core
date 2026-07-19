// run.cancel (frozen Wave-B method): dispatcher routing, param validation,
// capability advertisement, and the canonical-first live flow — a live
// writer must seal one cancelled terminal before the state-DB projection,
// while inactive runs retain the durable offline cascade.

import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import type { CancelAgentRunTreeReport } from "../../src/state/run-cancellation.js";
import type { AgenCBackgroundAgentTerminalSnapshot } from "./background-agent-runner.js";

function request(id: string, method: string, params?: JsonObject): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

function cancelledReport(runId: string): CancelAgentRunTreeReport {
  return {
    runId,
    missing: false,
    alreadyTerminal: false,
    rootStatusBefore: "running",
    subtreeRunIds: [runId, `${runId}_child`],
    cancelledRunIds: [runId, `${runId}_child`],
    priorStatusById: { [runId]: "running", [`${runId}_child`]: "pending" },
    closedEdgeChildIds: [`${runId}_child`],
  };
}

async function dispatchRunCancel(options: {
  readonly report: CancelAgentRunTreeReport;
  readonly interruptResult?: boolean;
  readonly live?: boolean;
  readonly stopError?: Error;
  readonly liveTerminal?: AgenCBackgroundAgentTerminalSnapshot;
}) {
  const order: string[] = [];
  const cancelDurable = vi.fn(async () => {
    order.push("db_cascade");
    return options.report;
  });
  const voidHolds = vi.fn().mockResolvedValue(3);
  const interruptAgentTurn = vi
    .fn()
    .mockImplementation(async () => {
      order.push("interrupt");
      return options.interruptResult ?? true;
    });
  const recordRunTerminal = vi.fn(async () => {
    order.push("terminal_projection");
  });
  const prepareAgentCancellation = vi.fn(async (runId: string) => {
    order.push("canonical_cancel_admission");
    return {
      affectedRunIds: [runId, `${runId}_child`],
      voidedHolds: 3,
      heldUnknownHolds: 0,
    };
  });
  let live = options.live ?? true;
  let agentManager!: AgenCDaemonAgentManager;
  const stopAgent = vi.fn(async (runId: string, reason?: string) => {
    order.push("canonical_terminal");
    if (options.stopError !== undefined) throw options.stopError;
    live = false;
    await agentManager.handleRunnerTerminated(runId, {
      status: "stopped",
      lastActiveAt: "2026-05-11T00:00:00.000Z",
      terminal: {
        openedAt: "2026-05-10T00:00:00.000Z",
        epoch: 1,
        eventId: `run-terminal:${runId}:1`,
        rolloutPath: `/tmp/${runId}.jsonl`,
        result: {
          runId,
          status: "cancelled",
          exitCode: null,
          stopReason: reason ?? "run.cancel",
          finalMessage: null,
          usage: null,
          lastSequence: 2,
          finishedAt: "2026-05-11T00:00:00.000Z",
        },
      },
    });
  });
  agentManager = new AgenCDaemonAgentManager({
    runner: {
      startAgent: vi.fn(),
      getAgentSnapshot: vi.fn(async (_runId: string) =>
        live
          ? {
              status: options.liveTerminal === undefined ? "running" : "stopped",
              lastActiveAt: "2026-05-10T00:00:00.000Z",
              ...(options.liveTerminal !== undefined
                ? { terminal: options.liveTerminal }
                : {}),
            }
          : null,
      ),
      interruptAgentTurn,
      prepareAgentCancellation,
      stopAgent,
    },
    cancelRunTreeDurable: cancelDurable,
    voidBudgetHoldsForAgents: voidHolds,
    recordRunTerminal,
  });
  if (live) {
    await agentManager.restoreAgent({
      agentId: options.report.runId,
      objective: "cancel contract run",
      status: "running",
      runtimeAvailable: true,
      sessionIds: [options.report.runId],
    });
  }
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager });
  const connection = dispatcher.createConnection({
    sendNotification: () => {},
  });
  const init = await connection.dispatch(
    request("init", "initialize", { protocol: { version: "1.0.0" } }),
  );
  return {
    agentManager,
    connection,
    dispatcher,
    init,
    cancelDurable,
    voidHolds,
    interruptAgentTurn,
    prepareAgentCancellation,
    stopAgent,
    recordRunTerminal,
    order,
  };
}

describe("run.cancel dispatcher contract", () => {
  it("advertises the capability and routes to the tree-scoped cancel", async () => {
    const harness = await dispatchRunCancel({
      report: cancelledReport("run_a"),
    });
    const capabilities = (
      harness.init.result as {
        capabilities: Record<string, Record<string, boolean>>;
      }
    ).capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY];
    expect(capabilities["run.cancel"]).toBe(true);

    const response = await harness.connection.dispatch(
      request("rc1", "run.cancel", { runId: "run_a", reason: "operator" }),
    );
    expect(response).toMatchObject({
      result: {
        runId: "run_a",
        alreadyTerminal: false,
        cancelledRunIds: ["run_a", "run_a_child"],
        closedEdgeChildIds: ["run_a_child"],
        interruptedLiveAgentIds: ["run_a"],
        voidedHolds: 3,
      },
    });
    // A live writer seals its canonical cancellation before the rebuildable
    // SQLite cascade and terminal projection.
    expect(harness.cancelDurable).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_a", reason: "operator" }),
    );
    expect(harness.interruptAgentTurn).toHaveBeenCalledWith(
      "run_a",
      "operator",
    );
    expect(harness.stopAgent).toHaveBeenCalledWith("run_a", "operator");
    expect(harness.recordRunTerminal).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual([
      "canonical_cancel_admission",
      "interrupt",
      "canonical_terminal",
      "db_cascade",
      "terminal_projection",
    ]);
    // Live holds were settled while the canonical listener was still open;
    // no post-terminal compatibility publication is allowed.
    expect(harness.prepareAgentCancellation).toHaveBeenCalledWith(
      "run_a",
      "operator",
    );
    expect(harness.voidHolds).not.toHaveBeenCalled();
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("maps a missing run to RUN_NOT_FOUND and requires runId", async () => {
    const harness = await dispatchRunCancel({
      live: false,
      report: {
        runId: "ghost",
        missing: true,
        alreadyTerminal: false,
        rootStatusBefore: null,
        subtreeRunIds: [],
        cancelledRunIds: [],
        priorStatusById: {},
        closedEdgeChildIds: [],
      },
    });
    const missing = await harness.connection.dispatch(
      request("rc2", "run.cancel", { runId: "ghost" }),
    );
    expect(missing).toMatchObject({
      error: { data: { code: "RUN_NOT_FOUND" } },
    });
    const invalid = await harness.connection.dispatch(
      request("rc3", "run.cancel", {}),
    );
    expect(invalid).toMatchObject({
      error: { data: { code: "INVALID_ARGUMENT" } },
    });
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("still voids subtree holds on an already-terminal retry (crash between cascade and voiding)", async () => {
    const harness = await dispatchRunCancel({
      live: false,
      report: {
        runId: "done_run",
        missing: false,
        alreadyTerminal: true,
        rootStatusBefore: "cancelled",
        subtreeRunIds: ["done_run", "done_run_child"],
        cancelledRunIds: [],
        priorStatusById: {},
        closedEdgeChildIds: [],
      },
    });
    const response = await harness.connection.dispatch(
      request("rc4", "run.cancel", { runId: "done_run" }),
    );
    expect(response).toMatchObject({
      result: { runId: "done_run", alreadyTerminal: true, voidedHolds: 3 },
    });
    // A crash between a prior cancel's durable cascade and its hold
    // voiding must be recoverable by retry: voiding runs on the subtree
    // even when nothing new was cancelled.
    expect(harness.voidHolds).toHaveBeenCalledWith([
      "done_run",
      "done_run_child",
    ]);
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("projects a naturally completed terminal before checking the DB cancellation", async () => {
    const runId = "run_completed_race";
    const harness = await dispatchRunCancel({
      report: {
        runId,
        missing: false,
        alreadyTerminal: true,
        rootStatusBefore: "stopped",
        subtreeRunIds: [runId],
        cancelledRunIds: [],
        priorStatusById: {},
        closedEdgeChildIds: [],
      },
      liveTerminal: {
        openedAt: "2026-05-10T00:00:00.000Z",
        epoch: 1,
        eventId: `run-terminal:${runId}:1`,
        rolloutPath: `/tmp/${runId}.jsonl`,
        result: {
          runId,
          status: "completed",
          exitCode: 0,
          stopReason: "turn_completed",
          finalMessage: "done",
          usage: null,
          lastSequence: 4,
          finishedAt: "2026-05-11T00:00:00.000Z",
        },
      },
    });

    const response = await harness.connection.dispatch(
      request("rc-completed", "run.cancel", { runId, reason: "too_late" }),
    );

    expect(response).toMatchObject({
      result: { runId, alreadyTerminal: true, cancelledRunIds: [] },
    });
    expect(harness.order).toEqual(["terminal_projection", "db_cascade"]);
    expect(harness.prepareAgentCancellation).not.toHaveBeenCalled();
    expect(harness.interruptAgentTurn).not.toHaveBeenCalled();
    expect(harness.stopAgent).not.toHaveBeenCalled();
    expect(harness.voidHolds).not.toHaveBeenCalled();
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("does not commit the DB cancellation when a live writer cannot seal canonical evidence", async () => {
    const harness = await dispatchRunCancel({
      report: cancelledReport("run_crash_window"),
      stopError: new Error("simulated crash before canonical terminal"),
    });

    const response = await harness.connection.dispatch(
      request("rc5", "run.cancel", {
        runId: "run_crash_window",
        reason: "operator",
      }),
    );

    expect(response).toMatchObject({
      error: { message: expect.stringContaining("simulated crash") },
    });
    expect(harness.cancelDurable).not.toHaveBeenCalled();
    expect(harness.recordRunTerminal).not.toHaveBeenCalled();
    expect(harness.order).toEqual([
      "canonical_cancel_admission",
      "interrupt",
      "canonical_terminal",
    ]);
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("coalesces concurrent live cancellation requests into one canonical terminal", async () => {
    const harness = await dispatchRunCancel({
      report: cancelledReport("run_concurrent_cancel"),
    });

    const [first, second] = await Promise.all([
      harness.agentManager.cancelRunTree({
        runId: "run_concurrent_cancel",
        reason: "operator",
      }),
      harness.agentManager.cancelRunTree({
        runId: "run_concurrent_cancel",
        reason: "operator",
      }),
    ]);

    expect(second).toEqual(first);
    expect(harness.stopAgent).toHaveBeenCalledTimes(1);
    expect(harness.prepareAgentCancellation).toHaveBeenCalledTimes(1);
    expect(harness.cancelDurable).toHaveBeenCalledTimes(1);
    expect(harness.recordRunTerminal).toHaveBeenCalledTimes(1);
    expect(
      harness.order.filter((step) => step === "canonical_terminal"),
    ).toHaveLength(1);
    await harness.dispatcher.closeConnection(harness.connection);
  });
});
