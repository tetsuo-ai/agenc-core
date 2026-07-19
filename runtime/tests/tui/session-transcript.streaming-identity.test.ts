import { describe, expect, test } from "vitest";

import {
  adaptTranscriptEvents,
  makeUserMessage,
} from "../../src/tui/session-transcript.js";

// M-TUI-1: message uuids minted during transcript projection must stay stable
// across re-projections. `useSessionTranscript` re-runs `adaptTranscriptEvents`
// on every coalesced streaming flush (~30/s); before this fix each run minted
// fresh `randomUUID()`s for every historical message, so every React key in the
// transcript changed per delta — remounting all rows and invalidating the
// virtual list's height cache. The fix derives each projected message's uuid
// from its source event key + a per-event block index (`${eventKey}:${index}`).

function deltaEvent(id: string, delta: string) {
  return {
    id,
    msg: { type: "agent_message_delta", payload: { delta } },
  } as never;
}

function streamingPrefix() {
  return [
    {
      id: "turn",
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    } as never,
    {
      id: "user",
      msg: { type: "user_message", payload: { message: "hello" } },
    } as never,
    deltaEvent("delta-0", "tok0 "),
    deltaEvent("delta-1", "tok1 "),
  ];
}

function messageUuids(transcript: { readonly messages: readonly any[] }): string[] {
  return transcript.messages.map((message) => message.uuid as string);
}

describe("session transcript streaming identity (M-TUI-1)", () => {
  test("two consecutive flushes of the same stream keep identical uuids for already-projected messages", () => {
    const flush1 = adaptTranscriptEvents(streamingPrefix());
    const flush2 = adaptTranscriptEvents([
      ...streamingPrefix(),
      deltaEvent("delta-2", "tok2 "),
      deltaEvent("delta-3", "tok3 "),
    ]);

    expect(flush1.messages.length).toBeGreaterThan(0);
    expect(flush2.messages.length).toBe(flush1.messages.length);
    expect(messageUuids(flush2)).toEqual(messageUuids(flush1));
    // The streamed text itself is not a projected message yet; it keeps
    // accumulating in the streaming accumulator between flushes.
    expect(flush1.streamingText).toBe("tok0 tok1 ");
    expect(flush2.streamingText).toBe("tok0 tok1 tok2 tok3 ");
  });

  test("re-deriving the same events twice yields identical, unique message uuids", () => {
    const events = [
      ...streamingPrefix(),
      {
        id: "tool-begin",
        msg: {
          type: "tool_call_started",
          payload: { callId: "call-1", toolName: "Bash", args: "{}" },
        },
      } as never,
      {
        id: "tool-end",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-1", result: "ok" },
        },
      } as never,
      {
        id: "thinking",
        msg: { type: "agent_thinking", payload: { text: "hmm" } },
      } as never,
      {
        id: "done",
        msg: { type: "turn_complete", payload: { turnId: "t1" } },
      } as never,
    ];

    const first = adaptTranscriptEvents(events);
    const second = adaptTranscriptEvents(events);

    const firstUuids = messageUuids(first);
    expect(messageUuids(second)).toEqual(firstUuids);
    expect(new Set(firstUuids).size).toBe(firstUuids.length);
  });

  test("derived uuids follow the `${eventKey}:${blockIndex}` scheme for seq- and id-keyed events", () => {
    const transcript = adaptTranscriptEvents([
      { seq: 7, type: "user_message", payload: { message: "hi" } } as never,
      { id: "warn", msg: { type: "error", payload: { message: "boom" } } } as never,
    ]);

    expect(messageUuids(transcript)).toEqual(["seq:7:0", "id:warn:0"]);
  });

  test("one event fanning out to several messages gets collision-free per-event block indices", () => {
    // An `error` event mid-stream projects TWO messages from the same source
    // event: the error row itself and the preserved partial assistant text.
    const events = [
      { id: "turn", msg: { type: "turn_started", payload: { turnId: "t1" } } } as never,
      deltaEvent("delta-0", "partial "),
      { id: "err", msg: { type: "error", payload: { message: "boom" } } } as never,
    ];

    const first = adaptTranscriptEvents(events);
    const second = adaptTranscriptEvents(events);

    const uuids = messageUuids(first);
    expect(uuids).toEqual(["id:err:0", "id:err:1"]);
    expect(new Set(uuids).size).toBe(2);
    expect(messageUuids(second)).toEqual(uuids);
  });

  test("tool rows projected from started/completed events keep their uuids as later events arrive", () => {
    const toolEvents = [
      {
        id: "tool-begin",
        msg: {
          type: "tool_call_started",
          payload: { callId: "call-1", toolName: "Bash", args: "{}" },
        },
      } as never,
      {
        id: "tool-end",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-1", result: "ok" },
        },
      } as never,
    ];

    const flush1 = adaptTranscriptEvents(toolEvents);
    const flush2 = adaptTranscriptEvents([
      ...toolEvents,
      { id: "note", msg: { type: "context_compacted", payload: {} } } as never,
    ]);

    expect(messageUuids(flush1)).toEqual(["id:tool-begin:0", "id:tool-end:0"]);
    expect(messageUuids(flush2).slice(0, flush1.messages.length)).toEqual(
      messageUuids(flush1),
    );
  });

  test("startup messages get stable positional uuids across re-projections", () => {
    const startup = [{ role: "user", content: "restored" }] as never;
    const first = adaptTranscriptEvents([], startup);
    const second = adaptTranscriptEvents([], startup);

    expect(messageUuids(first)).toEqual(["startup:0"]);
    expect(messageUuids(second)).toEqual(["startup:0"]);
  });

  test("makers still default to randomUUID for one-shot external callers", () => {
    const a = makeUserMessage("hi");
    const b = makeUserMessage("hi");
    expect(a.uuid).not.toBe(b.uuid);
    expect(makeUserMessage("hi", "fixed:0").uuid).toBe("fixed:0");
  });
});
