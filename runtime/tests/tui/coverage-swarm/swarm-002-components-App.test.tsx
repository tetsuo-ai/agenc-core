import { describe, expect, test, vi } from "vitest";

import type {
  McpElicitationRequestEvent,
  McpPrimitiveSchemaDefinition,
  RequestUserInputEvent,
} from "../../elicitation/types.js";
import { getCommandQueue, resetCommandQueue } from "../../utils/messageQueueManager.js";
import {
  createElicitationQueue,
  enqueueSlashPromptResult,
  installElicitationResolvers,
  parseMcpField,
  settlePendingOnSubmit,
  type McpFormPending,
  type McpUrlPending,
  type UserPending,
} from "../components/App.js";

function userRequest(questions: RequestUserInputEvent["questions"]): RequestUserInputEvent {
  return {
    callId: "call-1",
    questions,
  };
}

function mcpUrlRequest(requestId = "url-1"): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "auth",
    requestId,
    request: {
      mode: "url",
      message: "Authorize access",
      elicitationId: requestId,
      url: "https://auth.example.test/start",
    },
  };
}

function mcpFormRequest(
  properties: Record<string, McpPrimitiveSchemaDefinition>,
  required: string[] = [],
): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "forms",
    requestId: "form-1",
    request: {
      mode: "form",
      message: "Provide values",
      requestedSchema: {
        type: "object",
        required,
        properties,
      },
    },
  };
}

function formPending(
  properties: Record<string, McpPrimitiveSchemaDefinition>,
  resolve = vi.fn(),
  required: string[] = [],
): McpFormPending {
  return {
    kind: "mcp-form",
    request: mcpFormRequest(properties, required),
    resolve,
    fields: Object.keys(properties),
    content: {},
    index: 0,
  };
}

describe("App coverage swarm row 002", () => {
  test("parses string and collection MCP schema edges", () => {
    expect(
      parseMcpField("green", {
        type: "string",
        anyOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      }),
    ).toEqual({
      ok: false,
      message: "must be one of: red, blue",
    });
    expect(parseMcpField("ab", { type: "string", minLength: 3 })).toEqual({
      ok: false,
      message: "must be at least 3 characters",
    });
    expect(parseMcpField("abcd", { type: "string", maxLength: 3 })).toEqual({
      ok: false,
      message: "must be at most 3 characters",
    });
    expect(
      parseMcpField("read, write", {
        type: "array",
        items: { type: "string", enum: ["read", "write"] },
      }),
    ).toEqual({
      ok: true,
      value: ["read", "write"],
    });
  });

  test("settles user prompts with default, missing, and later questions", () => {
    const firstResolve = vi.fn();
    const firstPending: UserPending = {
      kind: "user",
      request: userRequest([
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
        },
        {
          id: "note",
          header: "Note",
          question: "Add note",
          options: [],
        },
      ]),
      resolve: firstResolve,
      answers: {},
      index: 0,
    };

    const next = settlePendingOnSubmit(firstPending, "");

    expect(firstResolve).not.toHaveBeenCalled();
    expect(next).toMatchObject({
      kind: "user",
      answers: { choice: { answers: ["Alpha"] } },
      index: 1,
    });

    expect(settlePendingOnSubmit(next as UserPending, "details")).toBeNull();
    expect(firstResolve).toHaveBeenCalledWith({
      answers: {
        choice: { answers: ["Alpha"] },
        note: { answers: ["details"] },
      },
    });

    const missingResolve = vi.fn();
    const missingQuestion: UserPending = {
      kind: "user",
      request: userRequest([]),
      resolve: missingResolve,
      answers: { previous: { answers: ["kept"] } },
      index: 0,
    };

    expect(settlePendingOnSubmit(missingQuestion, "ignored")).toBeNull();
    expect(missingResolve).toHaveBeenCalledWith({
      answers: { previous: { answers: ["kept"] } },
    });
  });

  test("settles MCP forms with no fields and skipped optional fields", () => {
    const emptyResolve = vi.fn();
    const emptyPending: McpFormPending = {
      kind: "mcp-form",
      request: mcpFormRequest({}),
      resolve: emptyResolve,
      fields: [],
      content: { existing: "value" },
      index: 0,
    };

    expect(settlePendingOnSubmit(emptyPending, "")).toBeNull();
    expect(emptyResolve).toHaveBeenCalledWith({
      action: "accept",
      content: { existing: "value" },
    });

    const resolve = vi.fn();
    const pending = formPending(
      {
        optional: { type: "string" },
        required: { type: "integer" },
      },
      resolve,
      ["required"],
    );

    const next = settlePendingOnSubmit(pending, "");
    expect(resolve).not.toHaveBeenCalled();
    expect(next).toMatchObject({
      kind: "mcp-form",
      content: {},
      index: 1,
      error: undefined,
    });

    expect(settlePendingOnSubmit(next as McpFormPending, "7")).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { required: 7 },
    });
  });

  test("manages elicitation queue cancellation and URL completion branches", () => {
    const queue = createElicitationQueue();
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const unrelatedResolve = vi.fn();
    const first: McpUrlPending = {
      kind: "mcp-url",
      request: mcpUrlRequest("url-1"),
      resolve: firstResolve,
    };
    const second: McpUrlPending = {
      kind: "mcp-url",
      request: mcpUrlRequest("url-2"),
      resolve: secondResolve,
    };
    const unrelated: McpUrlPending = {
      kind: "mcp-url",
      request: mcpUrlRequest("missing"),
      resolve: unrelatedResolve,
    };

    expect(queue.enqueue(first)).toBe(first);
    expect(queue.enqueue(second)).toBe(first);
    expect(queue.cancel(unrelated)).toEqual({
      handled: false,
      current: first,
    });

    expect(queue.cancel(second)).toEqual({
      handled: true,
      current: first,
    });
    expect(secondResolve).not.toHaveBeenCalled();

    expect(queue.completeMcpUrl("auth", "url-1", { action: "decline" })).toEqual({
      handled: true,
      current: null,
    });
    expect(firstResolve).toHaveBeenCalledWith({ action: "decline" });
    expect(queue.completeMcpUrl("auth", "url-2")).toEqual({
      handled: false,
      current: null,
    });
    expect(queue.clear()).toEqual([]);
  });

  test("resolvers handle pre-aborted signals, event-log completions, and cleanup", async () => {
    const previousUser = { request: vi.fn() };
    const previousMcp = { request: vi.fn() };
    const unsubscribe = vi.fn();
    let eventListener:
      | ((event: {
          msg: {
            type?: unknown;
            payload: { serverName: string; elicitationId: string };
          };
        }) => void)
      | undefined;
    const session = {
      services: {
        requestUserInputResolver: previousUser,
        mcpElicitationResolver: previousMcp,
      },
      eventLog: {
        subscribe: vi.fn((listener: NonNullable<typeof eventListener>) => {
          eventListener = listener;
          return unsubscribe;
        }),
      },
    };
    const prompted: unknown[] = [];
    const controller = installElicitationResolvers(session, pending => {
      prompted.push(pending);
    });

    const preAborted = new AbortController();
    preAborted.abort();
    const abortedRequest = session.services.requestUserInputResolver.request(
      userRequest([
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [],
        },
      ]),
      preAborted.signal,
    );

    await expect(abortedRequest).resolves.toBeNull();
    expect(prompted.at(-1)).toBeNull();

    const pendingUrl = session.services.mcpElicitationResolver.request(
      mcpUrlRequest("url-3"),
    );
    expect(prompted.at(-1)).toMatchObject({ kind: "mcp-url" });

    eventListener?.({
      msg: {
        type: "other",
        payload: { serverName: "auth", elicitationId: "url-3" },
      },
    });
    let resolved = false;
    void pendingUrl.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    eventListener?.({
      msg: {
        type: "mcp_elicitation_complete",
        payload: { serverName: "auth", elicitationId: "url-3" },
      },
    });

    await expect(pendingUrl).resolves.toEqual({ action: "accept" });
    expect(prompted.at(-1)).toBeNull();

    controller.cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(session.services.requestUserInputResolver).toBe(previousUser);
    expect(session.services.mcpElicitationResolver).toBe(previousMcp);
  });

  test("enqueueSlashPromptResult ignores blank content and queues trimmed work", () => {
    const scheduleQueueDrain = vi.fn();
    resetCommandQueue();

    try {
      expect(enqueueSlashPromptResult("   ", scheduleQueueDrain)).toBe(false);
      expect(getCommandQueue()).toEqual([]);
      expect(scheduleQueueDrain).not.toHaveBeenCalled();

      expect(enqueueSlashPromptResult("  queued content  ", scheduleQueueDrain)).toBe(
        true,
      );
      expect(getCommandQueue()).toMatchObject([
        {
          value: "  queued content  ",
          preExpansionValue: "  queued content  ",
          mode: "prompt",
        },
      ]);
      expect(scheduleQueueDrain).toHaveBeenCalledTimes(1);
    } finally {
      resetCommandQueue();
    }
  });
});
