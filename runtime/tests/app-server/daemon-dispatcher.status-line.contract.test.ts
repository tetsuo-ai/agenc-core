import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { isDaemonControlMessage, isDaemonPriorityMessage } from "./overload.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  type SessionStatusLineExecuteParams,
} from "./protocol/index.js";

const method = "session.statusLine.execute";
const request = { jsonrpc: "2.0", id: "status-line", method, params: { sessionId: "owner" } };

async function connect(
  executeSessionStatusLine?: (
    params: SessionStatusLineExecuteParams,
    signal: AbortSignal,
  ) => Promise<unknown>,
  version = AGENC_DAEMON_PROTOCOL_VERSION,
) {
  const connection = new AgenCDaemonJsonRpcDispatcher({
    agentManager: { executeSessionStatusLine } as never,
  }).createConnection();
  const initialized = await connection.dispatch({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocol: { version } },
  });
  return { connection, initialized };
}

describe("daemon-owned status line execution", () => {

  it("does not advertise execution without a live implementation", async () => {
    const { connection, initialized } = await connect();
    expect(initialized).toMatchObject({ result: { capabilities: {
      [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: { [method]: false },
    } } });
    await expect(connection.dispatch(request)).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("rejects old protocol clients", async () => {
    const execute = vi.fn(async () => ({ status: "disabled" }));
    const { connection } = await connect(execute, "1.10.0");
    await expect(connection.dispatch(request)).resolves.toMatchObject({ error: { code: -32601 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds daemon output and rejects inconsistent results", async () => {
    for (const result of [
      null, { status: "ready" }, { status: "rendered" },
      { status: "blocked", text: "leaked" },
      { status: "rendered", text: 12 },
      { status: "rendered", text: "😀".repeat(16_385) },
      { status: "error", reason: "x".repeat(257) },
      { status: "disabled", command: "leaked" },
    ]) {
      const { connection } = await connect(async () => result);
      await expect(connection.dispatch(request)).resolves.toMatchObject({ error: { code: -32603 } });
    }
  });

  it.each(["request", "disconnect"])("propagates %s cancellation", async (cause) => {
    let observedSignal: AbortSignal | undefined;
    const { connection } = await connect(async (_params, signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "unavailable", reason: "cancelled" };
    });
    const pending = connection.dispatch(request);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    if (cause === "disconnect") {
      await connection.close();
    } else {
      await expect(connection.dispatch({
        jsonrpc: "2.0", id: "cancel", method: "request.cancel",
        params: { requestId: request.id, reason: "refresh" },
      })).resolves.toMatchObject({ result: { cancelled: true } });
    }
    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ error: { data: { code: "REQUEST_CANCELLED" } } });
  });
});
