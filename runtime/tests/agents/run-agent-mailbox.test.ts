import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import { Mailbox } from "./mailbox.js";
import type { LiveAgent } from "./control.js";
import {
  clearChildConversationHistory,
  drainChildMailboxForTesting,
} from "./run-agent.js";

function liveWithInbox(): Pick<
  LiveAgent,
  "agentId" | "agentPath" | "downInbox" | "messages"
> {
  return {
    agentId: "agent_live",
    agentPath: "/root/agent_live",
    downInbox: new Mailbox({ threadId: "agent_live-down" }),
    messages: [{ role: "assistant", content: "old child reply" }],
  };
}

describe("runAgent mailbox history boundaries", () => {
  it("drops pre-clear mailbox history and keeps only fresh follow-up input", () => {
    const live = liveWithInbox();
    live.downInbox.send({
      author: "/root",
      recipient: live.agentPath,
      content: "stale follow-up",
      triggerTurn: true,
      direction: "down",
      metadata: { kind: "user_input" },
    });
    live.downInbox.send({
      author: live.agentPath,
      recipient: live.agentPath,
      content: "",
      triggerTurn: false,
      direction: "down",
      metadata: { kind: "history_clear" },
    });
    live.downInbox.send({
      author: "/root",
      recipient: live.agentPath,
      content: "fresh follow-up",
      triggerTurn: true,
      direction: "down",
      metadata: { kind: "user_input" },
    });

    expect(drainChildMailboxForTesting(live as LiveAgent)).toEqual({
      clearHistory: true,
      nextUserMessage: "fresh follow-up",
    });
  });

  it("clears child session state, provider continuation, local history, and live messages", async () => {
    const persistedHistory = [{ role: "assistant", content: "old reply" }];
    const initialHistory: LLMMessage[] = [
      { role: "user", content: "old question" },
    ];
    const live = liveWithInbox();
    const clearProviderResponseId = vi.fn();
    const childSession = {
      state: {
        with: vi.fn(async (fn: (state: { history: unknown[] }) => void) =>
          fn({ history: persistedHistory }),
        ),
      },
      clearProviderResponseId,
    };

    await clearChildConversationHistory(
      childSession,
      live,
      initialHistory,
    );

    expect(persistedHistory).toEqual([]);
    expect(initialHistory).toEqual([]);
    expect(live.messages).toEqual([]);
    expect(clearProviderResponseId).toHaveBeenCalledTimes(1);
  });
});
