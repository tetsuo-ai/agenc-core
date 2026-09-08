import { describe, expect, it } from "vitest";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  type AdaptedTranscript,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

type InputMode = "replay" | "live" | "batch";

function event(id: string, type: string, payload: Record<string, unknown>): SessionTranscriptEvent {
  return { id, type, payload };
}

function project(events: readonly SessionTranscriptEvent[], mode: InputMode): AdaptedTranscript {
  if (mode === "replay") return adaptTranscriptEvents(createSessionTranscriptStateForTesting(events).events);
  let state = createSessionTranscriptStateForTesting([]);
  if (mode === "batch") state = appendSessionTranscriptBatchForTesting(state, events);
  else for (const entry of events) state = appendSessionTranscriptEventForTesting(state, entry);
  return adaptTranscriptEvents(state.events);
}

function assistantRows(transcript: AdaptedTranscript): readonly { readonly uuid: string; readonly content: unknown }[] {
  return transcript.messages.filter(message => message.type === "assistant").map(message => ({
    uuid: message.uuid, content: message.message.content,
  }));
}

const answer = [{ type: "text", text: "Done." }];

describe.each<InputMode>(["replay", "live", "batch"])("assistant output correlation through %s input", mode => {
  it.each(["turn_start", "turn_started"])("preserves identical answers with distinct %s, event, and message identities", startType => {
    const events = [1, 2].flatMap(turn => [
      event(`start-${turn}`, startType, { turnId: `turn-${turn}` }),
      event(`user-${turn}`, "user_message", { messageId: `message-${turn}`, message: `prompt ${turn}` }),
      event(`agent-${turn}`, "agent_message", { message: "Done." }),
      event(`complete-${turn}`, "turn_complete", { turnId: `turn-${turn}`, lastAgentMessage: "Done." }),
    ]);
    const expected = [
      { uuid: "id:agent-1:0", content: answer },
      { uuid: "id:agent-2:0", content: answer },
    ];
    expect(assistantRows(project(events, mode))).toEqual(expected);
    expect(assistantRows(project([...events, ...events], mode))).toEqual(expected);
    const sequenced = events.map((entry, index) => ({ ...entry, seq: index + 1 }));
    expect(assistantRows(project([...sequenced].reverse().concat(sequenced), mode))).toEqual([
      { uuid: "seq:3:0", content: answer },
      { uuid: "seq:7:0", content: answer },
    ]);
  });

  it.each([
    { type: "turn_start", payload: { turnId: "next" } },
    { type: "turn_started", payload: { turnId: "next" } },
    { type: "user_message", payload: { messageId: "next-message", message: "again" } },
    { type: "queued_command", payload: { uuid: "next-queued", commandMode: "prompt", originKind: "human", content: "again" } },
    { type: "realtime_transcript_done", payload: { role: "user", text: "again" } },
  ])("resets assistant correlation at a $type boundary without other lifecycle events", boundary => {
    const events = [
      event("first", "agent_message", { message: "Done." }),
      event("boundary", boundary.type, boundary.payload),
      event("second", "agent_message", { message: "Done." }),
      event("complete", "turn_complete", { turnId: "next", lastAgentMessage: "Done." }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([
      { uuid: "id:first:0", content: answer },
      { uuid: "id:second:0", content: answer },
    ]);
  });

  it("flushes prior streaming text before resetting at the next user message", () => {
    const events = [
      event("delta", "agent_message_delta", { delta: "Done." }),
      event("user", "user_message", { message: "again" }),
      event("agent", "agent_message", { message: "Done." }),
      event("complete", "turn_complete", { turnId: "next", lastAgentMessage: "Done." }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([
      { uuid: "id:user:0", content: answer },
      { uuid: "id:agent:0", content: answer },
    ]);
  });

  it.each([
    { type: "user_message", payload: { message: "again" } },
    { type: "queued_command", payload: { uuid: "queued-next", commandMode: "prompt", content: "again" } },
    { type: "realtime_transcript_done", payload: { role: "user", text: "again" } },
  ])("does not repeat the active turn's late terminal answer after $type", boundary => {
    const events = [
      event("start-first", "turn_started", { turnId: "first" }),
      event("agent-first", "agent_message", { message: "Done." }),
      event("boundary", boundary.type, boundary.payload),
      event("complete-first", "turn_complete", { turnId: "first", lastAgentMessage: "Done." }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([
      { uuid: "id:agent-first:0", content: answer },
    ]);
    expect(assistantRows(project([
      ...events,
      event("start-next", "turn_started", { turnId: "next" }),
      event("agent-next", "agent_message", { message: "Done." }),
      event("complete-next", "turn_complete", { turnId: "next", lastAgentMessage: "Done." }),
    ], mode))).toEqual([
      { uuid: "id:agent-first:0", content: answer },
      { uuid: "id:agent-next:0", content: answer },
    ]);
  });

  it.each(["turn_start", "turn_started"])("keeps fallback correlation when %s repeats the active turn ID", startType => {
    const events = [
      event("start", startType, { turnId: "same" }),
      event("agent", "agent_message", { message: "Done." }),
      event("repeated-start", startType, { turnId: "same" }),
      event("complete", "turn_complete", { turnId: "same", lastAgentMessage: "Done." }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([
      { uuid: "id:agent:0", content: answer },
    ]);
  });

  it.each([
    { type: "agent_message_delta", payload: { delta: "Done." }, uuid: "id:user:0" },
    { type: "realtime_transcript_done", payload: { role: "assistant", text: "Done." }, uuid: "id:output:0" },
  ])("retains active-turn correlation for $type across a user boundary", output => {
    const events = [
      event("start", "turn_started", { turnId: "active" }),
      event("output", output.type, output.payload),
      event("user", "user_message", { message: "next" }),
      event("complete", "turn_complete", { turnId: "active", lastAgentMessage: "Done." }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([{ uuid: output.uuid, content: answer }]);
  });

  it.each(["agent-first", "terminal-first"])("keeps one row for a same-turn answer and terminal fallback in %s order", order => {
    const agent = event("agent", "agent_message", { message: "Done." });
    const terminal = event("terminal", "turn_complete", { turnId: "turn", lastAgentMessage: "Done." });
    const output = order === "agent-first" ? [agent, terminal] : [terminal, agent];
    const events = [event("start", "turn_started", { turnId: "turn" }), ...output, ...output];
    const rows = assistantRows(project(events, mode));
    expect(rows).toEqual([{ uuid: `id:${order === "agent-first" ? "agent" : "terminal"}:0`, content: answer }]);
  });

  it.each([
    { name: "empty final", payload: { lastAgentMessage: "" } },
    { name: "blank final", payload: { lastAgentMessage: "   " } },
    { name: "empty content", payload: { content: "" } },
  ])("does not replace an explicit $name with buffered text", terminal => {
    const events = [
      event("first", "agent_message", { message: "Done." }),
      event("next", "turn_started", { turnId: "next" }),
      event("delta", "agent_message_delta", { delta: "Done." }),
      event("complete", "turn_complete", { turnId: "next", ...terminal.payload }),
    ];
    const transcript = project(events, mode);
    expect(assistantRows(transcript)).toEqual([{ uuid: "id:first:0", content: answer }]);
    expect(transcript.streamingText).toBeNull();
  });

  it.each([
    { name: "final message", payload: { lastAgentMessage: "Done." } },
    { name: "content", payload: { content: "Done." } },
    { name: "streamed text", payload: {} },
  ])("preserves a repeated terminal-only answer from $name in a new turn", terminal => {
    const events = [
      event("first", "agent_message", { message: "Done." }),
      event("next", "turn_started", { turnId: "next" }),
      event("delta", "agent_message_delta", { delta: "Done." }),
      event("complete", "turn_complete", { turnId: "next", ...terminal.payload }),
    ];
    expect(assistantRows(project(events, mode))).toEqual([
      { uuid: "id:first:0", content: answer },
      { uuid: "id:complete:0", content: answer },
    ]);
  });

  it("does not create empty assistant rows for an empty turn", () => {
    const transcript = project([
      event("start", "turn_started", { turnId: "empty" }),
      event("empty-agent", "agent_message", { message: "   " }),
      event("complete", "turn_complete", { turnId: "empty" }),
    ], mode);
    expect(assistantRows(transcript)).toEqual([]);
    expect(transcript.streamingText).toBeNull();
  });

  it("preserves identical realtime answers separated by a user reply", () => {
    const events = [
      event("first", "realtime_transcript_done", { role: "assistant", text: "Done." }),
      event("user", "realtime_transcript_done", { role: "user", text: "again" }),
      event("second", "realtime_transcript_done", { role: "assistant", text: "Done." }),
    ];
    expect(assistantRows(project([...events, ...events], mode))).toEqual([
      { uuid: "id:first:0", content: answer },
      { uuid: "id:second:0", content: answer },
    ]);
  });
});
