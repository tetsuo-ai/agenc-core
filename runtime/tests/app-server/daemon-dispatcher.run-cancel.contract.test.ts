// run.cancel (frozen Wave-B method): dispatcher routing, param validation,
// capability advertisement, and the durable-first flow — the state-DB
// cascade decides the outcome, the live interrupt/stop is best-effort
// second, and voided budget holds are reported.

import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import type { CancelAgentRunTreeReport } from "../../src/state/run-cancellation.js";

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
}) {
  const cancelDurable = vi.fn().mockResolvedValue(options.report);
  const voidHolds = vi.fn().mockResolvedValue(3);
  const interruptAgentTurn = vi
    .fn()
    .mockResolvedValue(options.interruptResult ?? true);
  const stopAgent = vi.fn().mockResolvedValue(undefined);
  const agentManager = new AgenCDaemonAgentManager({
    runner: {
      startAgent: vi.fn(),
      interruptAgentTurn,
      stopAgent,
    },
    cancelRunTreeDurable: cancelDurable,
    voidBudgetHoldsForAgents: voidHolds,
  });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager });
  const connection = dispatcher.createConnection({
    sendNotification: () => {},
  });
  const init = await connection.dispatch(
    request("init", "initialize", { protocol: { version: "1.0.0" } }),
  );
  return {
    connection,
    dispatcher,
    init,
    cancelDurable,
    voidHolds,
    interruptAgentTurn,
    stopAgent,
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
    // Durable first, with the caller's reason.
    expect(harness.cancelDurable).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_a", reason: "operator" }),
    );
    // Live propagation second (interrupt cascades in-runner, then stop).
    expect(harness.interruptAgentTurn).toHaveBeenCalledWith(
      "run_a",
      "operator",
    );
    expect(harness.stopAgent).toHaveBeenCalledWith("run_a", "operator");
    // Voided holds cover the FULL subtree (idempotent superset).
    expect(harness.voidHolds).toHaveBeenCalledWith(["run_a", "run_a_child"]);
    await harness.dispatcher.closeConnection(harness.connection);
  });

  it("maps a missing run to RUN_NOT_FOUND and requires runId", async () => {
    const harness = await dispatchRunCancel({
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
});
