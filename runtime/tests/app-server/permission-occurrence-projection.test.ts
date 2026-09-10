import { describe, expect, it } from "vitest";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { promptEventFromNotification } from "../../../packages/agenc-sdk/src/events.js";

describe("permission occurrence projection", () => {
  const payload = { callId: "tool-call", toolName: "request_permissions", permissions: ["tool.use"] };
  it("keeps canonical occurrence, call and event identities separate across SDK parsing", () => {
    for (const sequence of [1, 2]) {
      const eventId = `permission-event-${sequence}`;
      const notification = notificationFromDaemonEvent("session", "agent", {
        id: "tool-call", eventId, sequence, type: "request_permissions", payload,
      });
      expect(promptEventFromNotification(notification)).toMatchObject({
        type: "permission_request", requestId: eventId, callId: "tool-call", eventId, sequence,
      });
    }
  });
  it("preserves the explicit child occurrence and its source event identity", () => {
    const notification = notificationFromDaemonEvent("parent", "agent", {
      id: "child-forward", eventId: "child-request-event", type: "request_permissions",
      payload: { ...payload, requestId: "child-approval:child-request-event" },
    });
    expect(promptEventFromNotification(notification)).toMatchObject({
      requestId: "child-approval:child-request-event", callId: "tool-call", eventId: "child-request-event",
    });
  });
  it("retains only the genuinely unsequenced legacy invocation-ID contract", () => {
    expect(notificationFromDaemonEvent("session", "agent", {
      id: "legacy-message", type: "request_permissions", payload,
    }).params).toMatchObject({ requestId: "tool-call", callId: "tool-call" });
    expect(() => notificationFromDaemonEvent("session", "agent", {
      id: "tool-call", sequence: 1, type: "request_permissions", payload,
    })).toThrow("canonical permission request has no event identity");
  });
  it("does not change tool invocation/cancellation correlation", () => {
    expect(notificationFromDaemonEvent("session", "agent", {
      id: "tool-event", eventId: "tool-event", sequence: 1,
      type: "tool_call_started", payload: { callId: "tool-call", toolName: "Read", input: {} },
    }).params).toMatchObject({ requestId: "tool-call", eventId: "tool-event" });
  });
});
