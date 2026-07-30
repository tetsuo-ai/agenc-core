import { describe, expect, it, vi } from "vitest";

import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";

function request(id: string, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

async function initialize(connection: {
  dispatch(message: JsonObject): Promise<JsonObject>;
}): Promise<JsonObject> {
  return await connection.dispatch(
    request("init", "initialize", {
      protocol: { version: "1.0.0" },
    }),
  );
}

function predictionParams(): JsonObject {
  return {
    requestId: "prediction-1",
    sessionId: "session-1",
    editorInstanceId: "editor-1",
    bufferHandle: 1,
    generation: 4,
    changedtick: 12,
    path: "/workspace/src/main.ts",
    fileBytes: 18,
    language: "typescript",
    cursor: { line: 2, byteColumn: 4 },
    prefix: "const answer = ",
    suffix: ";\n",
  };
}

describe("workspace editor prediction daemon protocol", () => {
  it("advertises capability only when the isolated prediction service exists", async () => {
    const withoutService = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
    }).createConnection();
    const unavailable = await initialize(withoutService);
    expect(
      ((unavailable.result as JsonObject).capabilities as JsonObject)[
        AGENC_DAEMON_METHOD_CAPABILITIES_KEY
      ],
    ).toMatchObject({
      "workspace.editor.predict": false,
      "workspace.editor.cancelPrediction": false,
      "workspace.editor.predictionFeedback": false,
    });

    const service = {
      complete: vi.fn(),
      cancel: vi.fn(),
      feedback: vi.fn(),
    };
    const withService = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: service as never,
    }).createConnection();
    const available = await initialize(withService);
    expect(
      ((available.result as JsonObject).capabilities as JsonObject)[
        AGENC_DAEMON_METHOD_CAPABILITIES_KEY
      ],
    ).toMatchObject({
      "workspace.editor.predict": true,
      "workspace.editor.cancelPrediction": true,
      "workspace.editor.predictionFeedback": true,
    });
  });

  it("routes complete, explicit cancel, and content-free feedback", async () => {
    const complete = vi.fn(async (params) => ({
      status: "completed",
      requestId: params.requestId,
      generation: params.generation,
      changedtick: params.changedtick,
      text: "42",
      provider: "test",
      model: "prediction-model",
      latencyMs: 12,
      cached: false,
    }));
    const cancel = vi.fn(() => true);
    const feedback = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: { complete, cancel, feedback } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("predict", "workspace.editor.predict", predictionParams()),
      ),
    ).resolves.toMatchObject({
      id: "predict",
      result: {
        status: "completed",
        requestId: "prediction-1",
        text: "42",
      },
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "prediction-1",
        cursor: { line: 2, byteColumn: 4 },
      }),
      expect.any(AbortSignal),
    );

    await expect(
      connection.dispatch(
        request("cancel", "workspace.editor.cancelPrediction", {
          sessionId: "session-1",
          editorInstanceId: "editor-1",
          requestId: "prediction-1",
        }),
      ),
    ).resolves.toMatchObject({
      result: { requestId: "prediction-1", cancelled: true },
    });
    expect(cancel).toHaveBeenCalledWith({
      sessionId: "session-1",
      editorInstanceId: "editor-1",
      requestId: "prediction-1",
    });

    await expect(
      connection.dispatch(
        request("feedback", "workspace.editor.predictionFeedback", {
          sessionId: "session-1",
          editorInstanceId: "editor-1",
          requestId: "prediction-1",
          kind: "accepted",
          acceptedCharacters: 2,
          latencyMs: 30,
        }),
      ),
    ).resolves.toMatchObject({ result: { recorded: true } });
    expect(feedback).toHaveBeenCalledWith({
      sessionId: "session-1",
      editorInstanceId: "editor-1",
      requestId: "prediction-1",
      kind: "accepted",
      acceptedCharacters: 2,
      latencyMs: 30,
    });
  });

  it("rejects malformed revision identity before provider dispatch", async () => {
    const complete = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: {
        complete,
        cancel: vi.fn(),
        feedback: vi.fn(),
      } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("bad-predict", "workspace.editor.predict", {
          ...predictionParams(),
          changedtick: -1,
        }),
      ),
    ).resolves.toMatchObject({
      id: "bad-predict",
      error: { code: -32602 },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("requires a truthful whole-buffer byte count before provider dispatch", async () => {
    const complete = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: {
        complete,
        cancel: vi.fn(),
        feedback: vi.fn(),
      } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    const missing = predictionParams();
    delete missing.fileBytes;
    for (const [id, params] of [
      ["missing-file-bytes", missing],
      ["understated-file-bytes", { ...predictionParams(), fileBytes: 1 }],
    ] as const) {
      await expect(
        connection.dispatch(request(id, "workspace.editor.predict", params)),
      ).resolves.toMatchObject({
        id,
        error: { code: -32602 },
      });
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied prediction consent", async () => {
    const complete = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: {
        complete,
        cancel: vi.fn(),
        feedback: vi.fn(),
      } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("untrusted-consent", "workspace.editor.predict", {
          ...predictionParams(),
          consentGranted: true,
        }),
      ),
    ).resolves.toMatchObject({
      id: "untrusted-consent",
      error: { code: -32602 },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("propagates request.cancel into the provider request signal", async () => {
    const complete = vi.fn(
      async (params: Record<string, unknown>, signal: AbortSignal) =>
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                status: "suppressed",
                requestId: params.requestId,
                generation: params.generation,
                changedtick: params.changedtick,
                reason: "cancelled",
              }),
            { once: true },
          );
        }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
      codePrediction: {
        complete,
        cancel: vi.fn(),
        feedback: vi.fn(),
      } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    const pending = connection.dispatch(
      request("prediction-rpc", "workspace.editor.predict", predictionParams()),
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await expect(
      connection.dispatch(
        request("cancel-rpc", "request.cancel", {
          requestId: "prediction-rpc",
          reason: "cursor moved",
        }),
      ),
    ).resolves.toMatchObject({
      result: { requestId: "prediction-rpc", cancelled: true },
    });
    await expect(pending).resolves.toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "prediction-rpc",
          reason: "cursor moved",
        },
      },
    });
  });
});
