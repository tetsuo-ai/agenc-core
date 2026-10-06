import { afterEach, describe, expect, it } from "vitest";

import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { isUndeliverableApproval, sessionEventDelivery } from "../../src/app-server/approval-delivery.js";
import {
  AGENC_PENDING_APPROVALS_LIST_CAPABILITY,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

// The daemon's broadcast result is what tells the approval broker whether a
// forwarded sub-agent request reached anyone who can show it. Clients that
// reconcile pending requests through permission.list count as able to show it.

const workspaces = createTempWorkspaceFixture("agenc-child-approval-delivery-daemon-");
afterEach(async () => { await workspaces.cleanup(); });

describe("daemon delivery result for a forwarded approval", () => {
  function permissionRequest(sessionId: string): JsonObject {
    return { jsonrpc: "2.0", method: "event.permission_request", params: {
      sessionId, requestId: "child-approval:ns:event:14", sourceConversationId: "child-1", permissions: ["tool.use"],
    } };
  }
  async function harness() {
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: () => "session_1",
      createAttachmentId: () => `attachment_${Math.random().toString(36).slice(2)}`,
    });
    const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager });
    await sessionManager.createSession({ agentId: "agent_1", cwd: await workspaces.create() });
    const deliver = async (event: JsonObject) => await sessionEventDelivery(
      event,
      await multiplexer.broadcastSessionEvent("session_1", event),
      () => multiplexer.hasClientWithCapability(AGENC_PENDING_APPROVALS_LIST_CAPABILITY),
    );
    return { multiplexer, deliver };
  }

  it("reports no recipient when no client is attached", async () => {
    const { deliver } = await harness();
    const delivery = await deliver(permissionRequest("session_1"));
    expect(delivery).toEqual({ deliveredClientIds: [], pendingListing: false });
    expect(isUndeliverableApproval(delivery)).toBe(true);
  });

  it("reports no recipient when the attached client does not take approvals", async () => {
    const { multiplexer, deliver } = await harness();
    const received: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "old-client", send: (message) => { received.push(message as JsonObject); },
      acceptsSessionEvent: (event) => event.method !== "event.permission_request",
    });
    await multiplexer.attachClientToSession("session_1", "old-client");
    expect(await deliver(permissionRequest("session_1"))).toEqual({ deliveredClientIds: [], pendingListing: false });
    expect(received.some((message) => message.method === "event.permission_request")).toBe(false);
  });

  it("counts a connected client that lists pending requests, even when it is not attached", async () => {
    const { multiplexer, deliver } = await harness();
    await multiplexer.registerClient({
      clientId: "lister", send: () => {}, capabilities: { [AGENC_PENDING_APPROVALS_LIST_CAPABILITY]: true },
    });
    const delivery = await deliver(permissionRequest("session_1"));
    expect(delivery).toEqual({ deliveredClientIds: [], pendingListing: true });
    expect(isUndeliverableApproval(delivery)).toBe(false);
  });

  it("reports the attached client that received it", async () => {
    const { multiplexer, deliver } = await harness();
    await multiplexer.registerClient({ clientId: "desktop", send: () => {} });
    await multiplexer.attachClientToSession("session_1", "desktop");
    expect(await deliver(permissionRequest("session_1"))).toMatchObject({ deliveredClientIds: ["desktop"] });
  });

  it("never calls a legacy binding without a result undeliverable", () => {
    expect(isUndeliverableApproval(undefined)).toBe(false);
    expect(isUndeliverableApproval({ deliveredClientIds: ["desktop"] })).toBe(false);
  });
});
