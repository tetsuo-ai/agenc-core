import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_METHOD_SPECS,
  JSON_RPC_VERSION,
  isAgenCDaemonMethod,
  type AgenCDaemonRequest,
} from "./protocol/index.js";

interface ProtocolSchema {
  readonly definitions: {
    readonly AgenCDaemonRequest: object;
  };
  readonly "x-agenc-methods": readonly string[];
}

const expectedMethods = [
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "session.create",
  "session.list",
  "message.send",
  "message.stream",
  "tool.approve",
  "tool.deny",
  "permission.list",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

function readProtocolSchema(): ProtocolSchema {
  return JSON.parse(
    readFileSync(new URL("./protocol/schema.json", import.meta.url), "utf8"),
  ) as ProtocolSchema;
}

function compileRequestValidator(schema: ProtocolSchema) {
  const ajv = new Ajv({ strict: false });
  return ajv.compile({
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: schema.definitions,
    $ref: "#/definitions/AgenCDaemonRequest",
  });
}

describe("AgenC daemon protocol surface", () => {
  it("exports the exact initial daemon method list", () => {
    expect(AGENC_DAEMON_METHODS).toEqual(expectedMethods);
    expect(Object.keys(AGENC_DAEMON_METHOD_SPECS)).toEqual(expectedMethods);

    for (const method of expectedMethods) {
      expect(AGENC_DAEMON_METHOD_SPECS[method].method).toBe(method);
      expect(AGENC_DAEMON_METHOD_SPECS[method].direction).toBe(
        "client-to-server",
      );
      expect(isAgenCDaemonMethod(method)).toBe(true);
    }

    expect(isAgenCDaemonMethod("thread/start")).toBe(false);
    expect(isAgenCDaemonMethod("account/login/start")).toBe(false);
  });

  it("publishes a schema with the same method list", () => {
    const schema = readProtocolSchema();

    expect(schema["x-agenc-methods"]).toEqual(expectedMethods);
  });

  it("validates all request-bearing methods through the published schema", () => {
    const validate = compileRequestValidator(readProtocolSchema());
    const samples: readonly AgenCDaemonRequest[] = [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "agent.create",
        params: { cwd: "/workspace", model: "grok-4" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.list",
        params: { limit: 20 },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.attach",
        params: { agentId: "agent_1", clientId: "tui_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.stop",
        params: { agentId: "agent_1", reason: "user requested stop" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 5,
        method: "session.create",
        params: { agentId: "agent_1", initialPrompt: "Inspect status" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 6,
        method: "session.list",
        params: { agentId: "agent_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 7,
        method: "message.send",
        params: { sessionId: "session_1", content: "Run tests" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 8,
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [{ type: "text", text: "Run tests" }],
          streamId: "stream_1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 9,
        method: "tool.approve",
        params: { sessionId: "session_1", requestId: "approval_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 10,
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "approval_2",
          reason: "outside workspace",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 11,
        method: "permission.list",
        params: { sessionId: "session_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 12,
        method: "auth.login",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 13,
        method: "auth.whoami",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 14,
        method: "auth.logout",
      },
    ];

    for (const sample of samples) {
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects unlisted methods and malformed payloads outside the F-03a surface", () => {
    const validate = compileRequestValidator(readProtocolSchema());

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-session",
        method: "message.send",
        params: { content: "missing session" },
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "not-owned",
        method: "account/login/start",
        params: {},
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        method: "agent.list",
        params: {},
      }),
    ).toBe(false);
  });
});
