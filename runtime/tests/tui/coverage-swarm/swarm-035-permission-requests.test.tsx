import { PassThrough } from "node:stream";

import React, { useEffect } from "react";
import { describe, expect, test, vi } from "vitest";

import { ABORT, APPROVED, DENIED } from "src/permissions/review-decision.js";
import type { ReviewDecision } from "src/permissions/review-decision.js";
import type { AppState } from "src/tui/state/AppState.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  clearAskUserQuestionResponsesForTest,
  createAskUserQuestionTool,
} from "src/tools/ask-user-question/tool.js";
import type { ApprovalCtx, ApprovalResolver } from "src/tools/orchestrator.js";
import { createRoot, Text } from "src/tui/ink.js";
import type { PendingRequest } from "src/tui/permission-requests.js";
import {
  buildToolUseConfirm,
  buildToolUseConfirmQueue,
  usePermissionRequests,
} from "src/tui/permission-requests.js";
import type { AgenCBridgeSession } from "src/tui/session-types.js";

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
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  options: {
    readonly retryReason?: string;
    readonly signal?: AbortSignal;
  } = {},
): ApprovalCtx {
  return {
    callId,
    toolName,
    turnId: "turn-035",
    retryReason: options.retryReason,
    signal: options.signal,
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
    conversationId: "conversation-035",
    services: {
      approvalResolver: previousResolver,
      permissionModeRegistry: {
        current: () => ({ mode: "default" }),
      },
    },
    appStateBridge: previousBridge,
  } as AgenCBridgeSession;
}

function createPendingRequest(
  toolName: string,
  input: Record<string, unknown>,
  resolve: (decision: ReviewDecision) => void,
): PendingRequest {
  return {
    id: `request-${toolName}`,
    ctx: createCtx(`call-${toolName}`, toolName, {
      kind: "function",
      arguments: JSON.stringify(input),
    }),
    input,
    description: `Permission required to use ${toolName}`,
    resolve,
  };
}

const askInput = {
  questions: [
    {
      question: "Which path should planning take?",
      header: "Plan",
      options: [
        { label: "Clarify", description: "Discuss the decision first" },
        { label: "Continue", description: "Proceed with the current plan" },
      ],
    },
  ],
};

describe("permission request swarm coverage", () => {
  test("derives edge-case approval inputs and restores the session bridge", async () => {
    const previousResolver: ApprovalResolver = {
      request: vi.fn(async () => DENIED),
    };
    const previousBridge: NonNullable<AgenCBridgeSession["appStateBridge"]> = {
      setModel: vi.fn(),
    };
    const session = createSession(previousResolver, previousBridge);
    const setModel = vi.fn<(next: string) => void>();
    const setExpandedView = vi.fn<(next: "none" | "tasks") => void>();
    const setAppState =
      vi.fn<(updater: (prev: AppState) => AppState) => void>();
    const getAppState = vi.fn<() => AppState>(() => ({}) as AppState);
    let latestRequests: readonly PendingRequest[] = [];

    function Harness() {
      const requests = usePermissionRequests(
        session,
        setModel,
        setExpandedView,
        setAppState,
        getAppState,
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

      session.appStateBridge?.setModel?.("next-model");
      session.appStateBridge?.setExpandedView?.("tasks");
      session.appStateBridge?.setAppState?.((state) => state);
      expect(setModel).toHaveBeenCalledWith("next-model");
      expect(setExpandedView).toHaveBeenCalledWith("tasks");
      expect(setAppState).toHaveBeenCalledTimes(1);

      const resolver = session.services.approvalResolver;
      expect(resolver).toBeDefined();

      const abortController = new AbortController();
      const preAbortedController = new AbortController();
      preAbortedController.abort();
      const preAbortedDecision = resolver!.request(
        createCtx(
          "pre-aborted-shell",
          "Shell",
          {
            kind: "local_shell",
            params: { command: ["pwd"] },
          },
          { signal: preAbortedController.signal },
        ),
      );
      const missingPayloadDecision = resolver!.request(
        createCtx("missing-payload", "Read", undefined),
      );
      const arrayPayloadDecision = resolver!.request(
        createCtx("array-json", "Write", {
          kind: "function",
          arguments: '["not", "an", "object"]',
        }),
      );
      const blankMcpDecision = resolver!.request(
        createCtx("blank-mcp", "McpTool", {
          kind: "mcp",
          rawArguments: "  ",
        }),
      );
      const customTextDecision = resolver!.request(
        createCtx("custom-text", "CustomTool", {
          kind: "custom",
          input: "freeform request",
        }),
      );
      const badShellDecision = resolver!.request(
        createCtx(
          "bad-shell",
          "Shell",
          {
            kind: "local_shell",
            params: ["pwd"],
          },
          { signal: abortController.signal },
        ),
      );

      await waitFor(() => {
        expect(latestRequests).toHaveLength(5);
      });
      await expect(preAbortedDecision).resolves.toEqual(ABORT);
      expect(latestRequests.map((request) => request.id)).not.toContain(
        "pre-aborted-shell",
      );
      expect(
        latestRequests.map((request) => ({
          id: request.id,
          input: request.input,
          description: request.description,
        })),
      ).toEqual([
        {
          id: "missing-payload",
          input: {},
          description: "Permission required to use Read",
        },
        {
          id: "array-json",
          input: {},
          description: "Permission required to use Write",
        },
        {
          id: "blank-mcp",
          input: {},
          description: "Permission required to use McpTool",
        },
        {
          id: "custom-text",
          input: { input: "freeform request" },
          description: "Permission required to use CustomTool",
        },
        {
          id: "bad-shell",
          input: {},
          description: "Permission required to use Shell",
        },
      ]);

      abortController.abort();
      await expect(badShellDecision).resolves.toEqual(ABORT);
      await waitFor(() => {
        expect(latestRequests.map((request) => request.id)).not.toContain(
          "bad-shell",
        );
      });

      const confirmQueue = buildToolUseConfirmQueue(latestRequests, [
        { name: "Read" },
        { name: "Write" },
        { name: "McpTool" },
        { name: "CustomTool" },
      ]) as readonly ProjectedConfirm[];
      const confirms = new Map(
        confirmQueue.map((confirm) => [confirm.toolUseID, confirm]),
      );

      confirms.get("missing-payload")!.onAllow({}, []);
      confirms.get("array-json")!.onReject("No thanks");
      confirms.get("blank-mcp")!.onAbort();
      confirms
        .get("custom-text")!
        .onAllow(confirms.get("custom-text")!.input, []);

      await expect(missingPayloadDecision).resolves.toEqual(APPROVED);
      await expect(arrayPayloadDecision).resolves.toEqual(DENIED);
      await expect(blankMcpDecision).resolves.toEqual(ABORT);
      await expect(customTextDecision).resolves.toEqual(APPROVED);
      await waitFor(() => {
        expect(latestRequests).toHaveLength(0);
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }

    expect(session.services.approvalResolver).toBe(previousResolver);
    expect(session.appStateBridge).toBe(previousBridge);
  });

  test("denies missing tools and records ask-user-question chat feedback", async () => {
    clearAskUserQuestionResponsesForTest();

    const deniedDecisions: ReviewDecision[] = [];
    const missingToolRequest = createPendingRequest(
      "MissingTool",
      {},
      (decision) => {
        deniedDecisions.push(decision);
      },
    );

    expect(
      buildToolUseConfirm(missingToolRequest, [{ name: "OtherTool" }]),
    ).toBeNull();
    expect(deniedDecisions).toEqual([DENIED]);

    const invalidAskDecisions: ReviewDecision[] = [];
    const invalidAskRequest = createPendingRequest(
      ASK_USER_QUESTION_TOOL_NAME,
      {},
      (decision) => {
        invalidAskDecisions.push(decision);
      },
    );
    const invalidAskConfirm = buildToolUseConfirm(invalidAskRequest, [
      { name: ASK_USER_QUESTION_TOOL_NAME },
    ]) as ProjectedConfirm;

    invalidAskConfirm.onReject("The user wants to clarify these questions");
    expect(invalidAskDecisions).toEqual([DENIED]);

    const askDecisions: ReviewDecision[] = [];
    const askRequest = createPendingRequest(
      ASK_USER_QUESTION_TOOL_NAME,
      askInput,
      (decision) => {
        askDecisions.push(decision);
      },
    );
    const askConfirm = buildToolUseConfirm(askRequest, [
      { name: ASK_USER_QUESTION_TOOL_NAME },
    ]) as ProjectedConfirm;

    await askConfirm.recheckPermission();
    askConfirm.onReject(
      "The user wants to clarify these questions before answering",
    );
    expect(askDecisions).toEqual([APPROVED]);

    const askTool = createAskUserQuestionTool();
    const askResult = await askTool.execute({
      __callId: askRequest.ctx.callId,
      ...askInput,
    });

    expect(askResult).toMatchObject({
      codeModeResult: {
        planInterviewAction: "chat_about_this",
      },
    });

    clearAskUserQuestionResponsesForTest();
  });
});
