import { PassThrough } from "node:stream";

import React, { useEffect } from "react";
import { describe, expect, test, vi } from "vitest";

import type { AppState } from "./state/AppState.js";
import { ABORT, APPROVED, APPROVED_FOR_SESSION, DENIED } from "../permissions/review-decision.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  clearAskUserQuestionResponsesForTest,
  createAskUserQuestionTool,
} from "../tools/ask-user-question/tool.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { createRoot, Text } from "./ink.js";
import type { PendingRequest } from "./permission-requests.js";
import {
  buildToolUseConfirmQueue,
  usePermissionRequests,
} from "./permission-requests.js";
import type { AgenCBridgeSession } from "./session-types.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type ProjectedConfirm = {
  readonly input: unknown;
  readonly toolUseID: string;
  onAbort(): void;
  onAllow(updatedInput: unknown, permissionUpdates?: readonly unknown[]): void;
  onReject(feedback?: string): void;
  onUserInteraction(): void;
  recheckPermission(): Promise<void>;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, {
    columns: 120,
    rows: 24,
    isTTY: true,
  });

  return { stdin, stdout };
}

async function sleep(ms = 10): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep();
    }
  }

  throw lastError;
}

function createCtx(
  callId: string,
  toolName: string,
  payload: unknown,
  retryReason?: string,
): ApprovalCtx {
  return {
    callId,
    toolName,
    turnId: "turn-038",
    retryReason,
    invocation: {
      callId,
      payload,
      toolName: { name: toolName },
    },
  } as ApprovalCtx;
}

function createSession(
  previousResolver: ApprovalResolver,
  previousBridge: NonNullable<AgenCBridgeSession["appStateBridge"]>,
): AgenCBridgeSession {
  return {
    conversationId: "conversation-038",
    services: {
      approvalResolver: previousResolver,
      permissionModeRegistry: {
        current: () => ({ mode: "default" }),
      },
    },
    appStateBridge: previousBridge,
  } as AgenCBridgeSession;
}

describe("permission request bridge coverage", () => {
  test("derives queued inputs and settles approval decisions", async () => {
    clearAskUserQuestionResponsesForTest();

    const askInput = {
      questions: [
        {
          question: "Continue planning?",
          header: "Planning",
          options: [
            { label: "Plan now", description: "Use existing context" },
            { label: "Discuss first", description: "Clarify before planning" },
          ],
        },
      ],
    };
    const previousResolver: ApprovalResolver = {
      request: vi.fn(async () => DENIED),
    };
    const previousBridge: NonNullable<AgenCBridgeSession["appStateBridge"]> = {
      setModel: vi.fn(),
    };
    const session = createSession(previousResolver, previousBridge);
    const setModel = vi.fn<(next: string) => void>();
    const setExpandedView = vi.fn<(next: "none" | "tasks") => void>();
    const setAppState = vi.fn<(updater: (prev: AppState) => AppState) => void>();
    let latestRequests: readonly PendingRequest[] = [];

    function Harness() {
      const requests = usePermissionRequests(
        session,
        setModel,
        setExpandedView,
        setAppState,
      );

      useEffect(() => {
        latestRequests = requests;
      }, [requests]);

      return <Text>{String(requests.length)}</Text>;
    }

    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<Harness />);
      await waitFor(() => {
        expect(session.services.approvalResolver).not.toBe(previousResolver);
        expect(session.appStateBridge).not.toBe(previousBridge);
      });

      session.appStateBridge?.setModel?.("model-next");
      session.appStateBridge?.setExpandedView?.("tasks");
      session.appStateBridge?.setAppState?.(state => state);

      expect(setModel).toHaveBeenCalledWith("model-next");
      expect(setExpandedView).toHaveBeenCalledWith("tasks");
      expect(setAppState).toHaveBeenCalledTimes(1);

      const resolver = session.services.approvalResolver;
      expect(resolver).toBeDefined();

      const functionDecision = resolver!.request(
        createCtx(
          "function-bad-json",
          "Shell",
          { kind: "function", arguments: "{not json" },
          "Retry shell command?",
        ),
      );
      const mcpDecision = resolver!.request(
        createCtx("mcp-read", "Read", {
          kind: "mcp",
          rawArguments: "{\"path\":\"src/app.ts\"}",
        }),
      );
      const customDecision = resolver!.request(
        createCtx("custom-empty", "CustomTool", {
          kind: "custom",
          input: 42,
        }),
      );
      const shellDecision = resolver!.request(
        createCtx("local-shell", "Shell", {
          kind: "local_shell",
          params: { command: ["pwd"], cwd: "/tmp/agenc" },
        }),
      );
      const askDecision = resolver!.request(
        createCtx("ask-skip", ASK_USER_QUESTION_TOOL_NAME, {
          kind: "function",
          arguments: JSON.stringify(askInput),
        }),
      );

      await waitFor(() => {
        expect(latestRequests).toHaveLength(5);
      });
      expect(
        latestRequests.map(request => ({
          id: request.id,
          input: request.input,
          description: request.description,
        })),
      ).toEqual([
        {
          id: "function-bad-json",
          input: { input: "{not json" },
          description: "Retry shell command?",
        },
        {
          id: "mcp-read",
          input: { path: "src/app.ts" },
          description: "Permission required to use Read",
        },
        {
          id: "custom-empty",
          input: { input: "" },
          description: "Permission required to use CustomTool",
        },
        {
          id: "local-shell",
          input: { command: ["pwd"], cwd: "/tmp/agenc" },
          description: "Permission required to use Shell",
        },
        {
          id: "ask-skip",
          input: askInput,
          description: `Permission required to use ${ASK_USER_QUESTION_TOOL_NAME}`,
        },
      ]);

      const confirmQueue = buildToolUseConfirmQueue(latestRequests, [
        { name: "Shell" },
        { name: "Read" },
        { name: ASK_USER_QUESTION_TOOL_NAME },
      ]) as readonly ProjectedConfirm[];
      const confirms = new Map(
        confirmQueue.map(confirm => [confirm.toolUseID, confirm]),
      );

      expect(confirms.has("custom-empty")).toBe(false);
      await expect(customDecision).resolves.toEqual(DENIED);

      const functionConfirm = confirms.get("function-bad-json");
      expect(functionConfirm).toBeDefined();
      functionConfirm!.onUserInteraction();
      await functionConfirm!.recheckPermission();
      functionConfirm!.onAllow(functionConfirm!.input, []);
      await expect(functionDecision).resolves.toEqual(APPROVED);

      const shellConfirm = confirms.get("local-shell");
      expect(shellConfirm).toBeDefined();
      shellConfirm!.onAllow(shellConfirm!.input, [{ scope: "session" }]);
      await expect(shellDecision).resolves.toEqual(APPROVED_FOR_SESSION);

      const mcpConfirm = confirms.get("mcp-read");
      expect(mcpConfirm).toBeDefined();
      mcpConfirm!.onAbort();
      await expect(mcpDecision).resolves.toEqual(ABORT);

      const askConfirm = confirms.get("ask-skip");
      expect(askConfirm).toBeDefined();
      askConfirm!.onReject("The user provided enough answers for the plan interview");
      await expect(askDecision).resolves.toEqual(APPROVED);

      const askTool = createAskUserQuestionTool();
      const askResult = await askTool.execute({
        __callId: "ask-skip",
        ...askInput,
      });
      expect(askResult).toMatchObject({
        codeModeResult: {
          planInterviewAction: "skip_plan_interview",
        },
      });

      await waitFor(() => {
        expect(latestRequests).toHaveLength(0);
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      clearAskUserQuestionResponsesForTest();
      await sleep();
    }

    expect(session.services.approvalResolver).toBe(previousResolver);
    expect(session.appStateBridge).toBe(previousBridge);
  });
});
