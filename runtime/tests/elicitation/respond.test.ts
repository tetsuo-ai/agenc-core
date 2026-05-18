import { describe, expect, it, vi } from "vitest";

import {
  normalizeMcpElicitationResponse,
  normalizeRequestUserInputResponse,
  respondToSessionElicitation,
} from "./respond.js";

describe("respondToSessionElicitation", () => {
  it("normalizes and forwards request_user_input responses", async () => {
    const session = {
      notifyUserInputResponse: vi.fn().mockResolvedValue(true),
      notifyMcpElicitationResponse: vi.fn(),
    };
    await expect(
      respondToSessionElicitation(session, {
        kind: "request_user_input",
        requestId: "turn-1",
        response: {
          answers: { choice: { answers: ["Yes", "Other detail"] } },
        },
      }),
    ).resolves.toBe(true);
    expect(session.notifyUserInputResponse).toHaveBeenCalledWith(
      "turn-1",
      {
        answers: { choice: { answers: ["Yes", "Other detail"] } },
      },
    );
    expect(session.notifyMcpElicitationResponse).not.toHaveBeenCalled();
  });

  it("normalizes request_user_input cancellation responses", async () => {
    const session = {
      notifyUserInputResponse: vi.fn().mockResolvedValue(true),
      notifyMcpElicitationResponse: vi.fn(),
    };
    await expect(
      respondToSessionElicitation(session, {
        kind: "request_user_input",
        requestId: "call-1",
        response: { action: "cancel" },
      }),
    ).resolves.toBe(true);
    expect(session.notifyUserInputResponse).toHaveBeenCalledWith("call-1", null);
  });

  it("normalizes and forwards MCP elicitation responses", async () => {
    const session = {
      notifyUserInputResponse: vi.fn(),
      notifyMcpElicitationResponse: vi.fn().mockResolvedValue(true),
    };
    await expect(
      respondToSessionElicitation(session, {
        kind: "mcp",
        serverName: "srv",
        requestId: 7,
        response: {
          action: "accept",
          content: { ok: true },
          _meta: { trace: "t1" },
        },
      }),
    ).resolves.toBe(true);
    expect(session.notifyMcpElicitationResponse).toHaveBeenCalledWith(
      "srv",
      7,
      {
        action: "accept",
        content: { ok: true },
        meta: { trace: "t1" },
      },
    );
  });

  it("rejects malformed responses before touching the session", async () => {
    expect(() =>
      normalizeRequestUserInputResponse({ answers: { x: { answers: [1] } } }),
    ).toThrow("answers.x.answers must be an array of strings");
    expect(() =>
      normalizeMcpElicitationResponse({ action: "maybe" }),
    ).toThrow("MCP elicitation response action must be accept, decline, or cancel");
    expect(() =>
      normalizeMcpElicitationResponse({
        action: "accept",
        content: { nested: { nope: true } },
      }),
    ).toThrow(
      "MCP elicitation response content.nested must be string, number, boolean, or string[]",
    );
    expect(() =>
      normalizeMcpElicitationResponse({
        action: "accept",
        content: { missing: null },
      }),
    ).toThrow(
      "MCP elicitation response content.missing must be string, number, boolean, or string[]",
    );
    expect(() =>
      normalizeMcpElicitationResponse({
        action: "accept",
        content: { list: [1] },
      }),
    ).toThrow(
      "MCP elicitation response content.list must be string, number, boolean, or string[]",
    );
    await expect(
      respondToSessionElicitation(
        {
          notifyUserInputResponse: vi.fn(),
          notifyMcpElicitationResponse: vi.fn(),
        },
        {
          kind: "mcp",
          requestId: "mcp-1",
          response: { action: "cancel" },
        },
      ),
    ).rejects.toThrow("MCP elicitation response requires serverName");
  });
});
