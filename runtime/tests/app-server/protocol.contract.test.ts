import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../helpers/source-path.ts";
import {
  AGENC_DAEMON_PROTOCOL_PACKAGE_NAME,
  AGENC_DAEMON_PROTOCOL_PUBLISH_TARGET,
  AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
  AGENC_DAEMON_PROTOCOL_SCHEMA_ID,
  AGENC_DAEMON_METHODS,
  AGENC_DAEMON_METHOD_SPECS,
  AGENC_DAEMON_INTERNAL_METHODS,
  AGENC_DAEMON_INTERNAL_METHOD_SPECS,
  AGENC_DAEMON_NOTIFICATION_METHODS,
  AGENC_DAEMON_NOTIFICATION_SPECS,
  JSON_RPC_VERSION,
  isAgenCDaemonMethod,
  isAgenCDaemonKnownMethod,
  isAgenCDaemonNotificationMethod,
  type AgenCDaemonRequest,
  type AgenCDaemonNotification,
  type AgenCDaemonInternalResultByMethod,
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
  readonly exports?: Record<
    string,
    | string
    | {
        readonly default?: string;
        readonly import?: string;
        readonly require?: string;
      }
  >;
  readonly files?: readonly string[];
  readonly publishConfig?: {
    readonly access?: string;
  };
}

interface ProtocolPackageRead {
  readonly manifest: ProtocolPackageManifest;
  readonly packageDir: string;
}

const expectedMethods = [
  "initialize",
  "request.cancel",
  "agent.create",
  "agent.list",
  "agent.attach",
  "agent.stop",
  "agent.logs",
  "run.cancel",
  "session.create",
  "session.list",
  "session.attach",
  "session.detach",
  "session.terminate",
  "session.clear",
  "session.snapshot",
  "session.transcript",
  "session.cancelTurn",
  "session.mcp.addServer",
  "message.send",
  "message.stream",
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/stop",
  "thread/realtime/listVoices",
  "tool.approve",
  "tool.deny",
  "tool.cancel",
  "elicitation.respond",
  "permission.list",
  "fs.fuzzy_search",
  "commandExec.start",
  "commandExec.write",
  "commandExec.resize",
  "commandExec.terminate",
  "health.ping",
  "health.ready",
  "health.stats",
  "daemon.reload",
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

const expectedNotifications = [
  "commandExec.outputDelta",
  "event.message_chunk",
  "event.tool_request",
  "event.permission_request",
  "event.user_input_request",
  "event.mcp_elicitation_request",
  "event.agent_status",
  "event.session_event",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
] as const;

const expectedInternalMethods = [
  "session.partialCompactFromMessage",
  "session.rewindConversationToMessage",
  "session.previewFileRewind",
  "session.rewindFilesToMessage",
  "session.setModel",
  "session.setPermissionMode",
  "session.hooks.status",
  "session.hooks.setDisabled",
  "session.applyConfig",
  "session.mcp.reconnectServer",
  "session.mcp.enableServer",
  "session.mcp.disableServer",
] as const;

function readProtocolSchema(): ProtocolSchema {
  return JSON.parse(
    readFileSync(sourceUrl("app-server/protocol/schema.json"), "utf8"),
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

function readSiblingProtocolPackage(): ProtocolPackageRead | null {
  const packagePathCandidates = [
    process.env.AGENC_PROTOCOL_PACKAGE_JSON,
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
  ].filter((candidate): candidate is string => typeof candidate === "string");
  const packagePath = packagePathCandidates.find(existsSync);
  if (packagePath === undefined) return null;
  return {
    manifest: JSON.parse(
      readFileSync(packagePath, "utf8"),
    ) as ProtocolPackageManifest,
    packageDir: dirname(packagePath),
  };
}

function protocolPackageExportTarget(
  manifest: ProtocolPackageManifest,
  exportPath: string,
): string | null {
  const target = manifest.exports?.[exportPath];
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    return target.default ?? target.require ?? target.import ?? null;
  }
  return null;
}

describe("AgenC daemon protocol surface", () => {
  it("exports the exact initial daemon method list", () => {
    expect(AGENC_DAEMON_METHODS).toEqual(expectedMethods);
    expect(Object.keys(AGENC_DAEMON_METHOD_SPECS)).toEqual(expectedMethods);
    expect(AGENC_DAEMON_INTERNAL_METHODS).toEqual(expectedInternalMethods);
    expect(Object.keys(AGENC_DAEMON_INTERNAL_METHOD_SPECS)).toEqual(
      expectedInternalMethods,
    );
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
      expect(isAgenCDaemonKnownMethod(method)).toBe(true);
    }
    for (const method of expectedInternalMethods) {
      expect(AGENC_DAEMON_INTERNAL_METHOD_SPECS[method].method).toBe(method);
      expect(AGENC_DAEMON_INTERNAL_METHOD_SPECS[method].direction).toBe(
        "client-to-server",
      );
      expect(isAgenCDaemonMethod(method)).toBe(false);
      expect(isAgenCDaemonKnownMethod(method)).toBe(true);
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
    expect(isAgenCDaemonKnownMethod("session.unknownInternal")).toBe(false);
    expect(isAgenCDaemonNotificationMethod("command/exec/outputDelta")).toBe(
      false,
    );
  });

  it("keeps internal TUI method result contracts typed", () => {
    const partial: AgenCDaemonInternalResultByMethod["session.partialCompactFromMessage"] = {
      sessionId: "session_contract",
      ok: true,
      eventAlreadyEmitted: true,
    };
    const rewind: AgenCDaemonInternalResultByMethod["session.rewindConversationToMessage"] = {
      sessionId: "session_contract",
      ok: false,
      eventAlreadyEmitted: false,
      code: "MESSAGE_NOT_FOUND",
      message: "missing",
    };

    expect(partial.ok).toBe(true);
    expect(rewind.message).toBe("missing");
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

    const siblingPackageRead = readSiblingProtocolPackage();
    if (siblingPackageRead === null) {
      throw new Error(
        "Missing sibling protocol package checkout for protocol package export contract.",
      );
    }

    const { manifest, packageDir } = siblingPackageRead;
    expect(manifest.name).toBe(AGENC_DAEMON_PROTOCOL_PACKAGE_NAME);
    expect(manifest.publishConfig?.access).toBe("public");

    const exportTarget = protocolPackageExportTarget(
      manifest,
      AGENC_DAEMON_PROTOCOL_SCHEMA_EXPORT,
    );
    expect(exportTarget).toBe("./src/generated/daemon-json-rpc.schema.json");
    expect(manifest.files).toContain("src/generated");

    const packagedSchema = JSON.parse(
      readFileSync(resolve(packageDir, exportTarget ?? ""), "utf8"),
    ) as ProtocolSchema;
    expect(packagedSchema.$id).toBe(schema.$id);
    expect(packagedSchema["x-agenc-package"]).toEqual(
      schema["x-agenc-package"],
    );
    expect(packagedSchema["x-agenc-methods"]).toEqual(
      schema["x-agenc-methods"],
    );
    expect(packagedSchema["x-agenc-notifications"]).toEqual(
      schema["x-agenc-notifications"],
    );
    expect(packagedSchema.definitions).toEqual(schema.definitions);
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
          protocol: { version: "1.0.0" },
          clientName: "contract-test",
          capabilities: {},
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel-search",
        method: "request.cancel",
        params: {
          requestId: "search_1",
          reason: "superseded",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "agent.create",
        params: {
          cwd: process.cwd(), objective: "Inspect daemon status",
          cwd: "/workspace",
          model: "grok-4",
          unattendedAllow: ["FileRead", "Grep"],
          unattendedDeny: ["exec_command"],
          envOverrides: {
            AGENC_MCP_SERVERS: "[]",
          },
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
        id: "agent-log",
        method: "agent.logs",
        params: { agentId: "agent_1" },
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
        method: "session.clear",
        params: { sessionId: "session_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 12,
        method: "session.snapshot",
        params: { sessionId: "session_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 13,
        method: "session.cancelTurn",
        params: { sessionId: "session_1", reason: "user_interrupt" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 14,
        method: "session.mcp.addServer",
        params: {
          sessionId: "session_1",
          config: {
            name: "audit-ping",
            transport: "stdio",
            command: "node",
            args: [".agenc/mcp/audit-ping.mjs"],
            enabled: true,
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 15,
        method: "message.send",
        params: { sessionId: "session_1", content: "Run tests" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 16,
        method: "message.stream",
        params: {
          sessionId: "session_1",
          content: [{ type: "text", text: "Run tests" }],
          streamId: "stream_1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-start",
        method: "thread/realtime/start",
        params: {
          threadId: "session_1",
          transport: null,
          realtimeSessionId: null,
          outputModality: "audio",
          voice: null,
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-audio",
        method: "thread/realtime/appendAudio",
        params: {
          threadId: "session_1",
          audio: {
            data: "AAAA",
            sampleRate: 24000,
            numChannels: 1,
            samplesPerChannel: 2,
            itemId: null,
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-audio-null",
        method: "thread/realtime/appendAudio",
        params: {
          threadId: "session_1",
          audio: {
            data: "BBBB",
            sampleRate: 24000,
            numChannels: 1,
            samplesPerChannel: null,
            itemId: null,
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-text",
        method: "thread/realtime/appendText",
        params: { threadId: "session_1", text: "continue" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-stop",
        method: "thread/realtime/stop",
        params: { threadId: "session_1" },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "rt-voices",
        method: "thread/realtime/listVoices",
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
        id: "cancel-tool",
        method: "tool.cancel",
        params: {
          sessionId: "session_1",
          requestId: "approval_3",
          reason: "user cancelled",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: "respond-elicitation",
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "turn_1",
          kind: "request_user_input",
          response: { answers: { choice: { answers: ["Yes"] } } },
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
        method: "daemon.reload",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 25,
        method: "auth.login",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 26,
        method: "auth.whoami",
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 27,
        method: "auth.logout",
      },
    ];

    for (const sample of samples) {
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("publishes nested protocol version metadata for initialize", () => {
    const schema = readProtocolSchema() as ProtocolSchema & {
      readonly definitions: ProtocolSchema["definitions"] & {
        readonly DaemonProtocolInfo: {
          readonly additionalProperties: false;
          readonly properties: {
            readonly version: {
              readonly type: "string";
              readonly minLength: 1;
            };
          };
          readonly required: readonly string[];
        };
        readonly InitializeParams: {
          readonly anyOf: readonly {
            readonly required: readonly string[];
          }[];
          readonly properties: {
            readonly protocol: { readonly $ref: string };
          };
        };
      };
    };

    expect(schema.definitions.InitializeParams.properties.protocol).toEqual({
      $ref: "#/definitions/DaemonProtocolInfo",
    });
    expect(schema.definitions.InitializeParams.anyOf).toEqual([
      { required: ["protocol"] },
      { required: ["protocolVersion"] },
    ]);
    expect(schema.definitions.DaemonProtocolInfo).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "string", minLength: 1 },
      },
      required: ["version"],
    });
  });

  it("rejects unlisted methods and malformed payloads outside the F-03a surface", () => {
    const validate = compileRequestValidator(readProtocolSchema());

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-initialize-protocol",
        method: "initialize",
        params: {},
      }),
    ).toBe(false);

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

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-realtime-transport",
        method: "thread/realtime/start",
        params: { threadId: "session_1", transport: { type: "webrtc" } },
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "missing-realtime-output-modality",
        method: "thread/realtime/start",
        params: { threadId: "session_1" },
      }),
    ).toBe(false);

    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-realtime-voice",
        method: "thread/realtime/start",
        params: {
          threadId: "session_1",
          outputModality: "audio",
          voice: "bad",
        },
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
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.message_chunk",
        params: {
          sessionId: "session_1",
          eventId: "event_1",
          messageId: "message_1",
          streamId: "stream_1",
          delta: "hello",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.tool_request",
        params: {
          sessionId: "session_1",
          eventId: "event_2",
          requestId: "tool_1",
          toolName: "FileRead",
          turnId: "turn_1",
          input: { path: "README.md" },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.permission_request",
        params: {
          sessionId: "session_1",
          eventId: "event_3",
          requestId: "permission_1",
          toolName: "Bash",
          turnId: "turn_1",
          permissions: ["tool.use"],
          input: { command: "pwd" },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.user_input_request",
        params: {
          sessionId: "session_1",
          eventId: "input_1",
          requestId: "turn_1",
          callId: "call_1",
          turnId: "turn_1",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Proceed?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Yes", description: "Continue." },
                { label: "No", description: "Stop." },
              ],
            },
          ],
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.mcp_elicitation_request",
        params: {
          sessionId: "session_1",
          eventId: "mcp_1",
          requestId: "mcp_1",
          serverName: "srv",
          turnId: "turn_1",
          request: {
            mode: "form",
            message: "Need details",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.agent_status",
        params: {
          sessionId: "session_1",
          eventId: "event_4",
          agentId: "agent_1",
          status: "running",
          turnId: "turn_1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          eventId: "event_5",
          event: {
            type: "turn_complete",
            payload: { turnId: "turn_1" },
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/started",
        params: {
          threadId: "session_1",
          realtimeSessionId: null,
          version: "v2",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/sdp",
        params: {
          threadId: "session_1",
          sdp: "v=0\r\n",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/outputAudio/delta",
        params: {
          threadId: "session_1",
          audio: {
            data: "AAAA",
            sampleRate: 24000,
            numChannels: 1,
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/transcript/delta",
        params: {
          threadId: "session_1",
          role: "assistant",
          delta: "hel",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/transcript/done",
        params: {
          threadId: "session_1",
          role: "assistant",
          text: "hello",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/itemAdded",
        params: {
          threadId: "session_1",
          item: "assistant-message",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/error",
        params: {
          threadId: "session_1",
          message: "provider failed",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/closed",
        params: {
          threadId: "session_1",
          reason: null,
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
    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.permission_request",
        params: {
          sessionId: "session_1",
          eventId: "event_bad",
          requestId: "permission_1",
          permissions: "tool.use",
        },
      }),
    ).toBe(false);
    expect(
      validate({
        jsonrpc: JSON_RPC_VERSION,
        method: "thread/realtime/transcript/delta",
        params: {
          threadId: "session_1",
          role: 1,
          delta: "bad",
        },
      }),
    ).toBe(false);
  });
});
