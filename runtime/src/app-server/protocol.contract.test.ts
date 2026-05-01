import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  AGENC_DAEMON_PROTOCOL_PUBLISH_TARGET,
  AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
  AGENC_DAEMON_PROTOCOL_SCHEMA_ID,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_METHOD_SPECS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
  AGENC_DAEMON_NOTIFICATION_SPECS,
  JSON_RPC_VERSION,
  isAgenCDaemonMethod,
  isAgenCDaemonNotificationMethod,
  type AgenCDaemonRequest,
  type AgenCDaemonNotification,
} from "./protocol/index.js";

interface ProtocolSchema {
  readonly $id: string;
  readonly definitions: {
    readonly AgenCDaemonRequest: object;
  };
  readonly "x-agenc-package": {
    readonly name: string;
    readonly export: string;
  };
  readonly "x-agenc-methods": readonly string[];
  readonly "x-agenc-notifications": readonly string[];
}

interface ProtocolPackageManifest {
  readonly name?: string;
  readonly publishConfig?: {
    readonly access?: string;
  };
}

const expectedMethods = [
  "initialize",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "message.send",
  "message.stream",
  "tool.approve",
  "tool.deny",
  "permission.list",
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

const expectedNotifications = [
  "commandExec.outputDelta",
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

function compileNotificationValidator(schema: ProtocolSchema) {
  const ajv = new Ajv({ strict: false });
  return ajv.compile({
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: schema.definitions,
    $ref: "#/definitions/AgenCDaemonNotification",
  });
}

function readSiblingProtocolPackage(): ProtocolPackageManifest | null {
  const packagePath = [
    resolve(
      process.cwd(),
      "..",
      "..",
      "agenc-protocol",
      "packages",
      "protocol",
      "package.json",
    ),
    resolve(
      process.cwd(),
      "..",
      "agenc-protocol",
      "packages",
      "protocol",
      "package.json",
    ),
  ].find(existsSync);
  if (packagePath === undefined) return null;
  return JSON.parse(
    readFileSync(packagePath, "utf8"),
  ) as ProtocolPackageManifest;
}

describe("AgenC daemon protocol surface", () => {
  it("exports the exact initial daemon method list", () => {
    expect(AGENC_DAEMON_METHODS).toEqual(expectedMethods);
    expect(Object.keys(AGENC_DAEMON_METHOD_SPECS)).toEqual(expectedMethods);
    expect(AGENC_DAEMON_NOTIFICATION_METHODS).toEqual(expectedNotifications);
    expect(Object.keys(AGENC_DAEMON_NOTIFICATION_SPECS)).toEqual(
      expectedNotifications,
    );

    for (const method of expectedMethods) {
      expect(AGENC_DAEMON_METHOD_SPECS[method].method).toBe(method);
      expect(AGENC_DAEMON_METHOD_SPECS[method].direction).toBe(
        "client-to-server",
      );
      expect(isAgenCDaemonMethod(method)).toBe(true);
    }
    for (const method of expectedNotifications) {
      expect(AGENC_DAEMON_NOTIFICATION_SPECS[method].method).toBe(method);
      expect(AGENC_DAEMON_NOTIFICATION_SPECS[method].direction).toBe(
        "server-to-client",
      );
      expect(isAgenCDaemonNotificationMethod(method)).toBe(true);
    }

    expect(isAgenCDaemonMethod("thread/start")).toBe(false);
    expect(isAgenCDaemonMethod("account/login/start")).toBe(false);
    expect(isAgenCDaemonNotificationMethod("command/exec/outputDelta")).toBe(
      false,
    );
  });

  it("publishes a schema with the same method list and package target", () => {
    const schema = readProtocolSchema();

    expect(schema.$id).toBe(AGENC_DAEMON_PROTOCOL_SCHEMA_ID);
    expect(schema["x-agenc-package"]).toEqual({
      name: AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
      export: AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
    });
    expect(schema["x-agenc-methods"]).toEqual(expectedMethods);
    expect(schema["x-agenc-notifications"]).toEqual(expectedNotifications);
    expect(AGENC_DAEMON_PROTOCOL_PUBLISH_TARGET).toEqual({
      packageName: "@tetsuo-ai/protocol",
      schemaExport: "./daemon-json-rpc.schema.json",
      schemaId: "urn:agenc:app-server:protocol",
    });

    const siblingPackage = readSiblingProtocolPackage();
    if (siblingPackage !== null) {
      expect(siblingPackage.name).toBe(AGENC_DAEMON_PROTOCOL_PACKAGE_NAME);
      expect(siblingPackage.publishConfig?.access).toBe("public");
    }
  });

  it("validates all request-bearing methods through the published schema", () => {
    const validate = compileRequestValidator(readProtocolSchema());
    const samples: readonly AgenCDaemonRequest[] = [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "1.0.0",
          clientName: "contract-test",
          capabilities: {},
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: {
          objective: "Inspect daemon status",
          cwd: "/workspace",
          model: "grok-4",
          unattendedAllow: ["FileRead", "system.grep"],
          unattendedDeny: ["exec_command"],
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 3,
        method: "agent.list",
        params: { limit: 20 },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 4,
        method: "agent.attach",
        params: { agentId: "agent_1", clientId: "tui_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 5,
        method: "agent.stop",
        params: { agentId: "agent_1", reason: "user requested stop" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 6,
        method: "session.create",
        params: { agentId: "agent_1", initialPrompt: "Inspect status" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 7,
        method: "session.list",
        params: { agentId: "agent_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 8,
        method: "session.attach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 9,
        method: "session.detach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 10,
        method: "session.terminate",
        params: { sessionId: "session_1", reason: "user requested stop" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 11,
        method: "message.send",
        params: { sessionId: "session_1", content: "Run tests" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 12,
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [{ type: "text", text: "Run tests" }],
          streamId: "stream_1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 13,
        method: "tool.approve",
        params: { sessionId: "session_1", requestId: "approval_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 14,
        method: "tool.deny",
        params: {
          sessionId: "session_1",
          requestId: "approval_2",
          reason: "outside workspace",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 15,
        method: "permission.list",
        params: { sessionId: "session_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 16,
        method: "fs.fuzzy_search",
        params: {
          query: "src",
          roots: ["/workspace"],
          cancellationToken: "search_1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 17,
        method: "commandExec.start",
        params: {
          command: ["node", "-e", "process.stdout.write('ok')", "", " "],
          processId: "proc_1",
          streamStdoutStderr: true,
          timeoutMs: 1000,
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 18,
        method: "commandExec.write",
        params: {
          processId: "proc_1",
          deltaBase64: "aGVsbG8=",
          closeStdin: true,
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 19,
        method: "commandExec.resize",
        params: {
          processId: "proc_1",
          size: { rows: 40, cols: 120 },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 20,
        method: "commandExec.terminate",
        params: { processId: "proc_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 21,
        method: "health.ping",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 22,
        method: "health.ready",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 23,
        method: "health.stats",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 24,
        method: "auth.login",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 25,
        method: "auth.whoami",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 26,
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
        id: "missing-detach-target",
        method: "session.detach",
        params: { sessionId: "session_1" },
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        method: "agent.list",
        params: {},
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "empty-command-program",
        method: "commandExec.start",
        params: { command: [""] },
      }),
    ).toBe(false);
  });

  it("validates server notification envelopes through the published schema", () => {
    const validate = compileNotificationValidator(readProtocolSchema());
    const samples: readonly AgenCDaemonNotification[] = [
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "commandExec.outputDelta",
        params: {
          processId: "proc_1",
          stream: "stdout",
          deltaBase64: "aGVsbG8=",
          capReached: false,
        },
      },
    ];

    for (const sample of samples) {
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    }

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        method: "commandExec.outputDelta",
        params: {
          processId: "proc_1",
          stream: "stdin",
          deltaBase64: "aGVsbG8=",
          capReached: false,
        },
      }),
    ).toBe(false);
  });
});
