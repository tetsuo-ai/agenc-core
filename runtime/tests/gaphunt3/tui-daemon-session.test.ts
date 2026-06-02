import { describe, expect, it } from "vitest";

import {
  createDaemonTuiSession,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "src/tui/daemon-session.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "src/app-server/protocol/index.js";

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {},
  };
}

/**
 * Minimal daemon client whose `message.stream` handler can be swapped per call
 * so we can simulate a transient socket failure (rejection) followed by a
 * successful submit. Records every request for assertions.
 */
function createClient(): AgenCDaemonTuiClient & {
  readonly requests: Array<{ method: string; params?: JsonObject }>;
  streamShouldReject: boolean;
} {
  const requests: Array<{ method: string; params?: JsonObject }> = [];
  return {
    requests,
    streamShouldReject: false,
    async request(
      method: AgenCDaemonMethod,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[AgenCDaemonMethod]> {
      requests.push({ method, params });
      if (method === "message.stream" && this.streamShouldReject) {
        throw new Error("daemon socket dropped");
      }
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
    },
    subscribeToSessionEvents: () => () => {},
  };
}

describe("gaphunt3 #16 — queued idle inputs survive a failed message.stream", () => {
  it("re-queues drained idle input when the first submit's message.stream rejects, so the next submit re-sends it", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    // Enqueue real user content: a pasted image plus text (an attachment-style
    // idle input). enqueueIdleInput returns the new queued count.
    const count = session.enqueueIdleInput({
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/screenshot.png" },
        },
      ],
    });
    expect(count).toBe(1);

    // First submit hits a transient/dropped socket: message.stream rejects.
    client.streamShouldReject = true;
    await expect(session.submit("")).rejects.toThrow("daemon socket dropped");

    // The drained blocks must NOT be lost: a follow-up submit (now that the
    // socket recovered) must re-send the originally-queued image+text.
    client.streamShouldReject = false;
    await session.submit("");

    const streamRequests = client.requests.filter(
      (r) => r.method === "message.stream",
    );
    expect(streamRequests).toHaveLength(2);

    // The retried (second) message.stream must carry the originally-queued
    // blocks. Before the fix, the splice(0) drained them and the catch path
    // never restored them, so the second submit sent nothing (early return) or
    // empty content.
    const retried = streamRequests[1]?.params;
    expect(retried?.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "file:///tmp/screenshot.png" } },
    ]);
  });

  it("restores the queued count after a failed submit so the buffer is not silently emptied", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    session.enqueueIdleInput({ role: "user", content: "queued startup message" });

    client.streamShouldReject = true;
    await expect(session.submit("")).rejects.toThrow();

    // Re-enqueuing after the failure should report a count that includes the
    // restored block (2), proving the drained block was rolled back rather than
    // discarded. Before the fix the count would be 1 (only the new block).
    const countAfter = session.enqueueIdleInput({
      role: "user",
      content: "another message",
    });
    expect(countAfter).toBe(2);

    client.streamShouldReject = false;
    await session.submit("");

    const streamRequests = client.requests.filter(
      (r) => r.method === "message.stream",
    );
    const lastSucceeded = streamRequests[streamRequests.length - 1]?.params;
    expect(lastSucceeded?.content).toEqual([
      { type: "text", text: "queued startup message" },
      { type: "text", text: "another message" },
    ]);
  });
});
