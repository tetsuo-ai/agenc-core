import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => ({
  Box: () => null,
  Text: () => null,
}));

import type {
  McpElicitationRequestEvent,
  McpPrimitiveSchemaDefinition,
  RequestUserInputEvent,
} from "../elicitation/types.js";
import {
  installElicitationResolvers,
  settlePendingOnSubmit,
  type McpFormPending,
  type McpUrlPending,
  type PendingElicitation,
} from "./elicitation.js";

function createBridgeSession(): Parameters<typeof installElicitationResolvers>[0] {
  return { services: {} } as Parameters<typeof installElicitationResolvers>[0];
}

function userRequest(callId: string): RequestUserInputEvent {
  return {
    requestId: callId,
    callId,
    turnId: "turn-1",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Pick one",
        options: [
          { label: "Yes", description: "Accept" },
          { label: "No", description: "Decline" },
        ],
      },
    ],
  };
}

function formPending(
  schema: McpPrimitiveSchemaDefinition,
  resolve = vi.fn(),
): McpFormPending {
  return {
    kind: "mcp-form",
    request: {
      turnId: "turn-1",
      serverName: "srv",
      requestId: "request-1",
      request: {
        mode: "form",
        message: "Provide value",
        requestedSchema: {
          type: "object",
          properties: { value: schema },
        },
      },
    },
    resolve,
    fields: ["value"],
    content: {},
    index: 0,
  };
}

function mcpFormRequest(callId: string): McpElicitationRequestEvent {
  return {
    turnId: "turn-1",
    serverName: "srv",
    requestId: callId,
    request: {
      mode: "form",
      message: "Provide value",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  };
}

function expectInvalidFormValue(
  schema: McpPrimitiveSchemaDefinition,
  raw: string,
  expectedMessage: string,
): void {
  const resolve = vi.fn();
  const next = settlePendingOnSubmit(formPending(schema, resolve), raw);

  expect(resolve).not.toHaveBeenCalled();
  expect(next).not.toBeNull();
  expect(next?.kind).toBe("mcp-form");
  expect((next as McpFormPending).index).toBe(0);
  expect((next as McpFormPending).content).toEqual({});
  expect((next as McpFormPending).error).toContain(expectedMessage);
}

describe("elicitation bridge", () => {
  test("queues resolver requests that arrive before the first submit", async () => {
    const session = createBridgeSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );

    const first = session.services.requestUserInputResolver!.request(userRequest("first"));
    const second = session.services.requestUserInputResolver!.request(userRequest("second"));

    expect(prompted.at(-1)?.kind).toBe("user");
    expect((prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId)
      .toBe("first");

    expect(controller.submit("2")).toBe(true);
    await expect(first).resolves.toEqual({
      answers: { choice: { answers: ["No"] } },
    });
    expect(prompted.at(-1)?.kind).toBe("user");
    expect((prompted.at(-1) as PendingElicitation & { kind: "user" }).request.callId)
      .toBe("second");

    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    expect(controller.submit("Yes")).toBe(true);
    await expect(second).resolves.toEqual({
      answers: { choice: { answers: ["Yes"] } },
    });
    controller.cleanup();
  });

  test("cleanup cancels unresolved user-input resolver requests", async () => {
    const session = createBridgeSession();
    const controller = installElicitationResolvers(session, () => {});
    const pending = session.services.requestUserInputResolver!.request(
      userRequest("cancelled"),
    );

    controller.cleanup();

    await expect(pending).resolves.toBeNull();
  });

  test("aborts unresolved direct user-input resolver requests", async () => {
    const session = createBridgeSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );
    const abort = new AbortController();

    const pending = session.services.requestUserInputResolver!.request(
      userRequest("aborted"),
      abort.signal,
    );
    expect(prompted.at(-1)?.kind).toBe("user");

    abort.abort();

    await expect(pending).resolves.toBeNull();
    expect(prompted.at(-1)).toBeNull();
    controller.cleanup();
  });

  test("aborts unresolved direct MCP resolver requests", async () => {
    const session = createBridgeSession();
    const prompted: (PendingElicitation | null)[] = [];
    const controller = installElicitationResolvers(
      session,
      (pending) => prompted.push(pending),
    );
    const abort = new AbortController();

    const pending = session.services.mcpElicitationResolver!.request(
      mcpFormRequest("aborted"),
      abort.signal,
    );
    expect(prompted.at(-1)?.kind).toBe("mcp-form");

    abort.abort();

    await expect(pending).resolves.toBeNull();
    expect(prompted.at(-1)).toBeNull();
    controller.cleanup();
  });

  test("rejects invalid boolean MCP form input", () => {
    expectInvalidFormValue({ type: "boolean" }, "sometimes", "true or false");
  });

  test("rejects non-integral integer MCP form input", () => {
    expectInvalidFormValue({ type: "integer" }, "1.5", "integer");
  });

  test("rejects string MCP form input outside enum values", () => {
    expectInvalidFormValue(
      { type: "string", enum: ["red", "blue"] },
      "green",
      "one of",
    );
  });

  test("accepts string MCP form input from titled enum values", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(
      formPending({
        type: "string",
        oneOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      }, resolve),
      "red",
    );

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: "red" },
    });
    expectInvalidFormValue(
      {
        type: "string",
        oneOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      },
      "green",
      "one of",
    );
  });

  test("rejects array MCP form input outside item enum values", () => {
    expectInvalidFormValue(
      {
        type: "array",
        items: { type: "string", enum: ["read", "write"] },
        minItems: 1,
      },
      "read, delete",
      "delete",
    );
  });

  test("accepts array MCP form input from titled enum values", () => {
    const resolve = vi.fn();
    const schema: McpPrimitiveSchemaDefinition = {
      type: "array",
      items: {
        anyOf: [
          { const: "read", title: "Read" },
          { const: "write", title: "Write" },
        ],
      },
      minItems: 1,
    };

    const next = settlePendingOnSubmit(formPending(schema, resolve), "read, write");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: ["read", "write"] },
    });
    expectInvalidFormValue(schema, "read, delete", "delete");
  });

  test("omits blank optional string MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional number MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "number" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("omits blank optional boolean MCP form input", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "boolean" }, resolve), "");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "accept", content: {} });
  });

  test("accepts valid MCP form input with collected content", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "done");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({
      action: "accept",
      content: { value: "done" },
    });
  });

  test("declines MCP URL prompts when requested", () => {
    const resolve = vi.fn();
    const pending: McpUrlPending = {
      kind: "mcp-url",
      request: {
        turnId: "turn-1",
        serverName: "srv",
        requestId: "request-1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url-1",
          url: "https://127.0.0.1/auth",
        },
      },
      resolve,
    };

    expect(settlePendingOnSubmit(pending, "decline")).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "decline" });
  });

  test("cancels MCP form prompts when requested", () => {
    const resolve = vi.fn();
    const next = settlePendingOnSubmit(formPending({ type: "string" }, resolve), "cancel");

    expect(next).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ action: "cancel" });
  });
});
