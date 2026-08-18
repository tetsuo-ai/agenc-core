import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import type { AgenCBackgroundAgentRunner } from "./background-agent-runner.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

function request(
  id: string,
  method: "message.send" | "message.stream",
  params: JsonObject,
): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

function editorInteraction(
  kind: "ask" | "explain" | "fix" | "edit" | "refactor",
  policy: "read_only" | "proposal_only",
): JsonObject {
  return {
    interactionId: `interaction-${kind}`,
    kind,
    policy,
    editorInstanceId: "editor-contract",
    bufferHandle: 7,
    changedtick: 12,
    contentSha256: "a".repeat(64),
    path: "/workspace/src/main.ts",
    range: {
      start: { line: 2, column: 3 },
      end: { line: 4, column: 0 },
    },
    selectionMode: kind === "explain" ? "character" : "block",
  };
}

async function createHarness(
  createParams: JsonObject = {},
  options: { readonly skipCreate?: boolean } = {},
): Promise<{
  readonly connection: ReturnType<
    AgenCDaemonJsonRpcDispatcher["createConnection"]
  >;
  readonly started: ReturnType<typeof vi.fn>;
  readonly submitted: ReturnType<typeof vi.fn>;
}> {
  const started = vi.fn(async () => ({
    agentId: "agent-editor-contract",
    startedAt: "2026-07-29T12:00:00.000Z",
    status: "running" as const,
  }));
  const submitted = vi.fn(async () => {});
  const runner: AgenCBackgroundAgentRunner = {
    startAgent: started,
    submitAgentMessage: submitted,
  };
  const sessions = new AgenCDaemonSessionManager({
    createSessionId: () => "session-editor-contract",
    now: () => "2026-07-29T12:00:00.000Z",
  });
  const agents = new AgenCDaemonAgentManager({
    now: () => "2026-07-29T12:00:00.000Z",
    runner,
    sessionManager: sessions,
  });
  const connection = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents,
    sessionManager: sessions,
    now: () => "2026-07-29T12:00:01.000Z",
  }).createConnection();

  await expect(
    connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "initialize",
      method: "initialize",
      params: { protocol: { version: "1.0.0" } },
    }),
  ).resolves.toMatchObject({
    result: {
      type: "initialized",
      protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
    },
  });
  if (options.skipCreate !== true) {
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create-agent",
        method: "agent.create",
        params: {
          cwd: process.cwd(),
          objective: "exercise editor message metadata",
          ...createParams,
        },
      }),
    ).resolves.toMatchObject({
      result: {
        agentId: "agent-editor-contract",
        activeSessionIds: ["session-editor-contract"],
      },
    });
  }

  return { connection, started, submitted };
}

describe("daemon editor interaction message metadata", () => {
  it("validates and forwards Editor policy for the atomic first turn", async () => {
    const explain = editorInteraction("explain", "read_only");
    const { started } = await createHarness({
      initialContent: "internal editor prompt",
      initialDisplayUserMessage: "Explain the selected code",
      initialEditorInteraction: explain,
    });

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        initialContent: "internal editor prompt",
        initialDisplayUserMessage: "Explain the selected code",
        initialEditorInteraction: explain,
      }),
    );
  });

  it("validates and forwards a deferred cold session with no initial turn", async () => {
    const { started } = await createHarness({
      deferInitialTurn: true,
    });

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "exercise editor message metadata",
        deferInitialTurn: true,
      }),
    );
  });

  it("rejects deferred startup combined with initial turn content", async () => {
    const { connection, started } = await createHarness(
      {},
      { skipCreate: true },
    );

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create-invalid-deferred-agent",
        method: "agent.create",
        params: {
          cwd: process.cwd(),
          objective: "must not start",
          deferInitialTurn: true,
          initialContent: "hidden first turn",
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(started).not.toHaveBeenCalled();
  });

  it("rejects malformed first-turn Editor policy before starting an agent", async () => {
    const { connection, started } = await createHarness(
      {},
      { skipCreate: true },
    );

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "create-invalid-editor-agent",
        method: "agent.create",
        params: {
          cwd: process.cwd(),
          objective: "must not start",
          initialContent: "internal editor prompt",
          initialDisplayUserMessage: "Explain the selected code",
          initialEditorInteraction: editorInteraction(
            "explain",
            "proposal_only",
          ),
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "create-invalid-editor-agent",
      error: {
        code: -32602,
        message:
          "agent.create param 'initialEditorInteraction'.policy must be read_only for explain",
        data: { code: "INVALID_ARGUMENT" },
      },
    });
    expect(started).not.toHaveBeenCalled();
  });

  it("forwards validated metadata through message.stream and message.send", async () => {
    const { connection, submitted } = await createHarness();
    const explain = editorInteraction("explain", "read_only");
    const edit = editorInteraction("edit", "proposal_only");

    await expect(
      connection.dispatch(
        request("stream", "message.stream", {
          sessionId: "session-editor-contract",
          content: "Explain the selected code.",
          clientMessageId: "message-stream",
          streamId: "stream-editor",
          metadata: { editorInteraction: explain },
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "stream",
      result: {
        messageId: "message-stream",
        streamId: "stream-editor",
        acceptedAt: "2026-07-29T12:00:01.000Z",
      },
    });
    await expect(
      connection.dispatch(
        request("send", "message.send", {
          sessionId: "session-editor-contract",
          content: "Prepare an exact edit proposal.",
          clientMessageId: "message-send",
          metadata: { editorInteraction: edit },
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "send",
      result: {
        messageId: "message-send",
        acceptedAt: "2026-07-29T12:00:01.000Z",
      },
    });

    expect(submitted).toHaveBeenNthCalledWith(
      1,
      "agent-editor-contract",
      expect.objectContaining({
        sessionId: "session-editor-contract",
        content: "Explain the selected code.",
        originalContent: "Explain the selected code.",
        editorInteraction: explain,
        messageId: "message-stream",
        streamId: "stream-editor",
      }),
    );
    expect(submitted).toHaveBeenNthCalledWith(
      2,
      "agent-editor-contract",
      expect.objectContaining({
        sessionId: "session-editor-contract",
        content: "Prepare an exact edit proposal.",
        originalContent: "Prepare an exact edit proposal.",
        editorInteraction: edit,
        messageId: "message-send",
        streamId: "message-send",
      }),
    );
  });

  it("rejects inconsistent policies and malformed revision identity before dispatch", async () => {
    const { connection, submitted } = await createHarness();
    const cases = [
      {
        id: "stream-policy-mismatch",
        method: "message.stream" as const,
        interaction: editorInteraction("explain", "proposal_only"),
        message:
          "message.stream metadata 'editorInteraction'.policy must be read_only for explain",
      },
      {
        id: "send-policy-mismatch",
        method: "message.send" as const,
        interaction: editorInteraction("edit", "read_only"),
        message:
          "message.send metadata 'editorInteraction'.policy must be proposal_only for edit",
      },
      {
        id: "send-malformed-revision",
        method: "message.send" as const,
        interaction: {
          ...editorInteraction("fix", "proposal_only"),
          contentSha256: "not-a-digest",
        },
        message:
          "message.send metadata 'editorInteraction'.contentSha256 must be a lowercase SHA-256 hex digest",
      },
      {
        id: "stream-inverted-range",
        method: "message.stream" as const,
        interaction: {
          ...editorInteraction("ask", "read_only"),
          range: {
            start: { line: 8, column: 0 },
            end: { line: 7, column: 0 },
          },
        },
        message:
          "message.stream metadata 'editorInteraction'.range must not be inverted",
      },
      {
        id: "send-invalid-selection-mode",
        method: "message.send" as const,
        interaction: {
          ...editorInteraction("edit", "proposal_only"),
          selectionMode: "visual",
        },
        message:
          "message.send metadata 'editorInteraction'.selectionMode must be character, line, or block when provided",
      },
    ];

    for (const testCase of cases) {
      await expect(
        connection.dispatch(
          request(testCase.id, testCase.method, {
            sessionId: "session-editor-contract",
            content: "This must not reach the model.",
            metadata: { editorInteraction: testCase.interaction },
          }),
        ),
      ).resolves.toEqual({
        jsonrpc: JSON_RPC_VERSION,
        id: testCase.id,
        error: {
          code: -32602,
          message: testCase.message,
          data: { code: "INVALID_ARGUMENT" },
        },
      });
    }

    expect(submitted).not.toHaveBeenCalled();
  });
});
