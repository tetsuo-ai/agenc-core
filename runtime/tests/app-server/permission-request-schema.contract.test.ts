import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../helpers/source-path.ts";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";

// Clients validate daemon notifications against the published schema, and
// Desktop vendors it. A forwarded sub-agent approval carries its invocation
// id and the requesting sub-agent; the schema must accept those optional
// fields, and still accept a request from an older daemon without them.

function validator() {
  const schema = JSON.parse(readFileSync(sourceUrl("app-server/protocol/schema.json"), "utf8")) as {
    definitions: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };
  const ajv = new Ajv({ strict: false });
  return {
    schema,
    validate: ajv.compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: schema.definitions,
      $ref: "#/definitions/AgenCDaemonNotification",
    }),
  };
}

describe("event.permission_request schema", () => {
  it("accepts a typed cross-provider consent disclosure and additive approval marker", () => {
    const { schema, validate } = validator();
    const disclosure = { kind: "cross_provider_spawn", provider: "deepseek", model: "deepseek-v4-pro",
      endpoint: "https://api.deepseek.com/v1", billingSource: "byok", taskId: "task-1",
      taskText: "Read the design", attachments: ["design.pdf"], workspace: "/workspace",
      sandboxMode: "workspace_write", fileReadAllowlist: ["/workspace"], fileReadDenylist: [],
      dataScope: "task_only", tools: ["Read", "WebSearch"], network: true, search: true,
      price: { inputUsdPer1K: 0.2, outputUsdPer1K: 0.8 }, futureToolResultsGoToProvider: true,
      maxModelCalls: 32,
      scopeKey: "scope", payloadKey: "payload", denialKey: "denial" };
    const notification = { jsonrpc: "2.0", method: "event.permission_request", params: {
      sessionId: "root", eventId: "event:1", requestId: "event:1", kind: "cross_provider_spawn",
      permissions: ["cross_provider_spawn"], crossProvider: disclosure,
    } };
    expect(validate(notification), JSON.stringify(validate.errors)).toBe(true);
    expect(schema.definitions.ToolApproveParams?.properties?.approvalKind).toEqual({ const: "cross_provider_spawn" });
    expect(schema.definitions.EventPermissionRequestParams?.properties?.crossProvider)
      .toEqual({ $ref: "#/definitions/CrossProviderSpawnDisclosure" });
  });
  it("accepts a forwarded sub-agent request with its attribution", () => {
    const { validate } = validator();
    const notification = notificationFromDaemonEvent("conv-parent", "conv-parent", {
      id: "child-approval:ns:event:14:request_permissions",
      eventId: "child-approval:ns:event:14",
      type: "request_permissions",
      payload: {
        callId: "call_exec", toolName: "exec_command", turnId: "sub-child-1-0",
        permissions: ["tool.use"], input: { cmd: "echo SUBAGENT_OK" },
        reason: "Permission required to use exec_command",
        requestId: "child-approval:ns:event:14", sourceEventId: "event:14",
        sourceConversationId: "child-1", sourceAgentNickname: "Braindance", sourceAgentPath: "/root/echo_probe",
      },
      statusProjection: "session_only",
    });
    expect(notification.params).toMatchObject({ sourceAgentNickname: "Braindance", callId: "call_exec" });
    expect(validate(notification), JSON.stringify(validate.errors)).toBe(true);
  });

  it("keeps the attribution fields optional and typed", () => {
    const { schema, validate } = validator();
    const definition = schema.definitions.EventPermissionRequestParams!;
    for (const field of ["callId", "sourceConversationId", "sourceAgentNickname", "sourceAgentPath"]) {
      expect(definition.properties?.[field], field).toEqual({ type: "string", minLength: 1 });
      expect(definition.required).not.toContain(field);
    }
    const older = { jsonrpc: "2.0", method: "event.permission_request", params: {
      sessionId: "conv-parent", eventId: "event:46", requestId: "event:46", permissions: ["tool.use"],
    } };
    expect(validate(older), JSON.stringify(validate.errors)).toBe(true);
  });
});
