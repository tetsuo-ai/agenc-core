import { describe, expect, it } from "vitest";

import { SlackChannelAdapter } from "../../src/gateway/slack-channel.js";
import type { OutboundChannelMessage } from "../../src/gateway/types.js";

// gateway #editTargets minor (core-todo.md): SlackChannelAdapter.#editTargets grew one
// entry per non-edit send and nothing ever deleted, an unbounded leak on a long-lived
// gateway (same in Discord/Telegram). Fixed by capping the map and evicting oldest-first.
// Edit-in-place only ever targets a recent message, so evicting old handles is safe.

const MAX_EDIT_TARGETS = 512; // mirrors slack-channel.ts

class FakeTransport {
  posted: Array<{ channel: string }> = [];
  updated: Array<{ ts: string }> = [];
  #ts = 0;
  async authTest() {
    return { userId: "UBOT" };
  }
  async postMessage(channel: string) {
    this.posted.push({ channel });
    return { ts: String(++this.#ts) };
  }
  async updateMessage(_channel: string, ts: string) {
    this.updated.push({ ts });
  }
}

function out(text: string, editMessageId?: string): OutboundChannelMessage {
  return {
    conversationId: "C1",
    text,
    ...(editMessageId !== undefined ? { editMessageId } : {}),
  } as OutboundChannelMessage;
}

describe("SlackChannelAdapter #editTargets is bounded", () => {
  it("evicts the oldest edit target once the cap is exceeded", async () => {
    const transport = new FakeTransport();
    const adapter = new SlackChannelAdapter({
      transport: transport as never,
      token: "xoxb-test",
    });

    const handles: string[] = [];
    for (let i = 0; i < MAX_EDIT_TARGETS + 2; i += 1) {
      handles.push(await adapter.send(out(`m${i}`)));
    }

    const postedBefore = transport.posted.length;
    const updatedBefore = transport.updated.length;

    // The oldest handle was evicted -> editing it posts a NEW message, not an edit.
    await adapter.send(out("edit-oldest", handles[0]));
    expect(transport.updated.length).toBe(updatedBefore);
    expect(transport.posted.length).toBe(postedBefore + 1);

    // The newest handle is retained -> editing it updates in place.
    await adapter.send(out("edit-newest", handles[handles.length - 1]));
    expect(transport.updated.length).toBe(updatedBefore + 1);
  });
});
