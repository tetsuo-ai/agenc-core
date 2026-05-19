import { describe, expect, it, vi } from "vitest";

import {
  canAutoAcceptMcpElicitation,
  configureMcpElicitationClient,
  createSessionMcpElicitationHandlers,
  mcpElicitationAutoAcceptedByPolicy,
  mcpElicitationRejectedByPolicy,
  normalizeMcpElicitationRequestParams,
  restoreMcpElicitationContextMeta,
  serializeMcpElicitationResponse,
} from "./mcp.js";
import type { McpElicitationRequest } from "./types.js";

describe("MCP elicitation", () => {
  it("restores context metadata while dropping progress tokens", () => {
    const request = normalizeMcpElicitationRequestParams(
      {
        mode: "form",
        message: "Need details",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        _meta: { direct: true },
      },
      { progressToken: "p1", trace: "abc" },
    );
    expect(request).toMatchObject({
      mode: "form",
      meta: { direct: true, trace: "abc" },
    });
    expect(request.meta).not.toHaveProperty("progressToken");

    const restored = restoreMcpElicitationContextMeta(request, {
      progressToken: "p2",
      session: "s1",
    });
    expect(restored.meta).toEqual({
      direct: true,
      trace: "abc",
      session: "s1",
    });
  });

  it("serializes response metadata as protocol _meta", () => {
    expect(
      serializeMcpElicitationResponse({
        action: "accept",
        content: { ok: true },
        meta: { echoed: 1 },
      }),
    ).toEqual({
      action: "accept",
      content: { ok: true },
      _meta: { echoed: 1 },
    });
  });

  it("applies policy and empty-form auto-accept helpers", () => {
    const emptyForm: McpElicitationRequest = {
      mode: "form",
      message: "Confirm",
      requestedSchema: { type: "object", properties: {} },
    };
    const nonEmptyForm: McpElicitationRequest = {
      mode: "form",
      message: "Name",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    };
    expect(canAutoAcceptMcpElicitation(emptyForm)).toBe(true);
    expect(canAutoAcceptMcpElicitation(nonEmptyForm)).toBe(false);
    expect(
      mcpElicitationAutoAcceptedByPolicy(emptyForm, "on_request"),
    ).toBe(false);
    expect(
      mcpElicitationAutoAcceptedByPolicy(emptyForm, "granular", {
        allowsMcpElicitations: () => true,
      }),
    ).toBe(true);
    expect(mcpElicitationRejectedByPolicy("never")).toBe(true);
    expect(mcpElicitationRejectedByPolicy("on_request")).toBe(false);
    expect(mcpElicitationRejectedByPolicy("granular")).toBe(true);
    expect(
      mcpElicitationRejectedByPolicy("granular", {
        allowsMcpElicitations: () => true,
      }),
    ).toBe(false);
  });

  it("rejects malformed URL and form request params", () => {
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "url",
        message: "Sign in",
        elicitationId: "el-1",
      }),
    ).toThrow("MCP elicitation request requires url");
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "url",
        message: "Sign in",
        url: "https://127.0.0.1/login",
      }),
    ).toThrow("MCP elicitation request requires elicitationId");
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      }),
    ).toThrow("MCP elicitation request requires message");
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "form",
        message: "Need details",
        requestedSchema: { type: "object" },
      }),
    ).toThrow("MCP elicitation request requires requestedSchema.properties");
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "form",
        message: "Need details",
        requestedSchema: {
          type: "object",
          properties: { name: {} },
        },
      }),
    ).toThrow(
      "MCP elicitation request requires requestedSchema.properties.name.type to be valid",
    );
    expect(() =>
      normalizeMcpElicitationRequestParams({
        mode: "form",
        message: "Need details",
        requestedSchema: {
          type: "object",
          properties: {
            color: {
              type: "string",
              oneOf: [{ title: "Red" }],
            },
          },
        },
      }),
    ).toThrow(
      "MCP elicitation request requires requestedSchema.properties.color.oneOf.0.const",
    );
  });

  it("normalizes titled enum schemas for string and array fields", () => {
    expect(
      normalizeMcpElicitationRequestParams({
        mode: "form",
        message: "Need details",
        requestedSchema: {
          type: "object",
          properties: {
            color: {
              type: "string",
              oneOf: [
                { const: "red", title: "Red" },
                { const: "blue", title: "Blue" },
              ],
            },
            scopes: {
              type: "array",
              items: {
                anyOf: [
                  { const: "read", title: "Read" },
                  { const: "write", title: "Write" },
                ],
              },
            },
          },
        },
      }),
    ).toMatchObject({
      mode: "form",
      requestedSchema: {
        properties: {
          color: {
            oneOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
          scopes: {
            items: {
              anyOf: [
                { const: "read", title: "Read" },
                { const: "write", title: "Write" },
              ],
            },
          },
        },
      },
    });
  });

  it("registers SDK request and completion handlers", async () => {
    let requestHandler:
      | ((request: unknown, extra: unknown) => Promise<unknown>)
      | undefined;
    let notificationHandler:
      | ((notification: unknown) => Promise<void>)
      | undefined;
    const client = {
      setRequestHandler: vi.fn((_schema, handler) => {
        requestHandler = handler;
      }),
      setNotificationHandler: vi.fn((_schema, handler) => {
        notificationHandler = handler;
      }),
    };
    const handlers = {
      handleRequest: vi.fn().mockResolvedValue({ action: "decline" }),
      handleComplete: vi.fn(),
    };

    await configureMcpElicitationClient(client, "srv", handlers);
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setNotificationHandler).toHaveBeenCalledTimes(1);

    await expect(
      requestHandler?.(
        {
          params: {
            mode: "url",
            message: "Sign in",
            elicitationId: "el-1",
            url: "https://127.0.0.1/login",
          },
        },
        { requestId: 99, _meta: { progressToken: "p", trace: "t" } },
      ),
    ).resolves.toEqual({ action: "decline" });
    expect(handlers.handleRequest).toHaveBeenCalledWith({
      serverName: "srv",
      requestId: "el-1",
      request: {
        mode: "url",
        message: "Sign in",
        elicitationId: "el-1",
        url: "https://127.0.0.1/login",
      },
      contextMeta: { progressToken: "p", trace: "t" },
      signal: undefined,
    });

    await notificationHandler?.({
      params: { elicitationId: "el-1" },
    });
    expect(handlers.handleComplete).toHaveBeenCalledWith({
      serverName: "srv",
      elicitationId: "el-1",
      notification: { params: { elicitationId: "el-1" } },
    });
  });

  it("creates session handlers that decline rejected policy requests", async () => {
    const session = {
      sessionConfiguration: {
        approvalPolicy: { value: "never" },
      },
      requestMcpElicitation: vi.fn(),
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      notifyMcpElicitationResponse: vi.fn(),
    };
    const handlers = createSessionMcpElicitationHandlers(session as never);
    await expect(
      handlers.handleRequest({
        serverName: "srv",
        requestId: 1,
        request: {
          mode: "form",
          message: "Need details",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({ action: "decline" });
    expect(session.requestMcpElicitation).not.toHaveBeenCalled();
  });

  it("prompts on_request empty forms but honors granular allow and deny", async () => {
    const request = {
      mode: "form" as const,
      message: "Confirm",
      requestedSchema: { type: "object" as const, properties: {} },
    };
    const onRequestSession = {
      sessionConfiguration: {
        approvalPolicy: { value: "on_request" },
      },
      requestMcpElicitation: vi.fn().mockResolvedValue({
        action: "accept",
        content: {},
      }),
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      notifyMcpElicitationResponse: vi.fn(),
    };
    await expect(
      createSessionMcpElicitationHandlers(onRequestSession as never)
        .handleRequest({
          serverName: "srv",
          requestId: "mcp-1",
          request,
        }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(onRequestSession.requestMcpElicitation).toHaveBeenCalledWith(
      "srv",
      "mcp-1",
      request,
      undefined,
    );
    const urlRequest = {
      mode: "url" as const,
      message: "Authorize",
      elicitationId: "url-1",
      url: "https://127.0.0.1/auth",
    };
    onRequestSession.requestMcpElicitation.mockClear();
    await expect(
      createSessionMcpElicitationHandlers(onRequestSession as never)
        .handleRequest({
          serverName: "srv",
          requestId: "jsonrpc-1",
          request: urlRequest,
        }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(onRequestSession.requestMcpElicitation).toHaveBeenCalledWith(
      "srv",
      "url-1",
      urlRequest,
      undefined,
    );

    const granularSession = {
      ...onRequestSession,
      sessionConfiguration: {
        approvalPolicy: { value: "granular" },
      },
      requestMcpElicitation: vi.fn(),
    };
    await expect(
      createSessionMcpElicitationHandlers(granularSession as never, {
        allowsMcpElicitations: () => false,
      }).handleRequest({
        serverName: "srv",
        requestId: "mcp-2",
        request,
      }),
    ).resolves.toEqual({ action: "decline" });
    expect(granularSession.requestMcpElicitation).not.toHaveBeenCalled();

    await expect(
      createSessionMcpElicitationHandlers(granularSession as never, {
        allowsMcpElicitations: () => true,
      }).handleRequest({
        serverName: "srv",
        requestId: "mcp-3",
        request,
      }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(granularSession.requestMcpElicitation).not.toHaveBeenCalled();
  });
});
