import { describe, expect, it } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const shown = (events: any[]): string =>
  JSON.stringify(adaptTranscriptEvents(events as never).messages.map((m: any) => m.content ?? m.message?.content));

// Audit finding 22: lifecycle events without nickname or role metadata (a
// resumed session before the agent names are rebuilt) named the agent by a
// shortened thread id.
describe("collaboration rows without agent metadata", () => {
  it("name agents by a stable local number, never by thread id", () => {
    const text = shown([
      { type: "collab_agent_spawn_end", payload: { callId: "c1", newThreadId: "019a7c2e-5b1d-7f00-9c3a-aaaaaaaaaaaa", prompt: "one" } },
      { type: "collab_agent_spawn_end", payload: { callId: "c2", newThreadId: "019a7c2e-5b1d-7f00-9c3a-bbbbbbbbbbbb", prompt: "two" } },
      { type: "collab_close_end", payload: { callId: "c3", receiverThreadId: "019a7c2e-5b1d-7f00-9c3a-aaaaaaaaaaaa" } },
    ]);
    expect(text).toContain("agent 1");
    expect(text).toContain("agent 2");
    expect(text).not.toContain("019a7c2e");
  });

  it("use the nickname, role or agent path when the events carry one", () => {
    const text = shown([
      { type: "collab_agent_spawn_end", payload: { callId: "c1", newThreadId: "t-1", newAgentNickname: "Ada", prompt: "x" } },
      { type: "collab_agent_spawn_end", payload: { callId: "c2", newThreadId: "t-2", newAgentPath: "/root/memory_extraction", prompt: "y" } },
    ]);
    expect(text).toContain("Ada");
    expect(text).toContain("memory extraction");
  });
});
