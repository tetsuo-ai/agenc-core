import { describe, expect, it } from "vitest";

import {
  terminalStatusFromNotification,
} from "../../../packages/agenc-sdk/src/events";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";

/**
 * A turn the user stopped (a Stop, or a denied permission request) closes as
 * turn_aborted. The daemon projects that terminal into event.agent_status; the
 * projection and every parser must keep it a stop (code 130), never a
 * completed turn.
 */

function projected(type: string, payload: Record<string, unknown>) {
  return notificationFromDaemonEvent("session_1", "session_1", {
    id: `${type}-1`,
    eventId: `${type}-1`,
    type,
    payload: { turnId: "turn_1", ...payload },
  }) as unknown as { method: string; params: Record<string, unknown> };
}

describe("aborted turn status projection", () => {
  it("projects turn_aborted as a stopped run on an idle agent", () => {
    const notification = projected("turn_aborted", { reason: "approval_denied" });
    expect(notification.method).toBe("event.agent_status");
    expect(notification.params).toMatchObject({
      status: "idle",
      runStatus: "stopped",
      turnId: "turn_1",
      message: "approval_denied",
      turnEvent: { type: "turn_aborted", payload: { turnId: "turn_1", reason: "approval_denied" } },
    });
  });

  it("keeps a completed turn completed", () => {
    expect(projected("turn_complete", { lastAgentMessage: "done" }).params)
      .toMatchObject({ status: "idle", runStatus: "completed" });
  });

  it.each(["approval_denied", "interrupted"])("reads the projected %s abort as a stop in the SDK", (reason) => {
    expect(terminalStatusFromNotification(projected("turn_aborted", { reason }) as never, "turn_1"))
      .toEqual({ code: 130, message: reason });
  });

  it("honors the embedded terminal over a generic idle status", () => {
    // An older daemon projected every abort as runStatus completed; the
    // embedded turn event is the authority.
    expect(terminalStatusFromNotification({
      method: "event.agent_status",
      params: {
        sessionId: "session_1", turnId: "turn_1", status: "idle", runStatus: "completed", message: "approval_denied",
        turnEvent: { type: "turn_aborted", payload: { turnId: "turn_1", reason: "approval_denied" } },
      },
    }, "turn_1")).toEqual({ code: 130, message: "approval_denied" });
    expect(terminalStatusFromNotification(projected("turn_complete", { lastAgentMessage: "done" }) as never, "turn_1"))
      .toEqual({ code: 0, message: "done" });
  });
});
