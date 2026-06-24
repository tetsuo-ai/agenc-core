import { describe, expect, test } from "vitest";

import type { StreamingToolUse } from "../../llm/types.js";
import { adaptTranscriptEvents } from "../session-transcript.js";

type Evt = { id: string; msg: { type: string; payload?: Record<string, unknown> } };

function turnStart(turnId = "t1"): Evt {
  return {
    id: `turn-start-${turnId}`,
    msg: { type: "turn_started", payload: { turnId } },
  };
}

function blockStart(
  callId: string,
  index: number,
  toolName = "Bash",
  contentBlock?: Partial<StreamingToolUse["contentBlock"]>,
): Evt {
  return {
    id: `bs-${callId}-${index}`,
    msg: {
      type: "tool_input_block_start",
      payload: {
        callId,
        index,
        toolName,
        contentBlock:
          contentBlock !== undefined
            ? { type: "tool_use", id: callId, name: toolName, input: {}, ...contentBlock }
            : undefined,
      },
    },
  };
}

function delta(callId: string, index: number, partialJson: string): Evt {
  return {
    id: `d-${callId}-${index}-${partialJson}-${Math.random()}`,
    msg: {
      type: "tool_input_delta",
      payload: { callId, index, partialJson },
    },
  };
}

function complete(callId: string): Evt {
  return {
    id: `complete-${callId}`,
    msg: {
      type: "tool_call_completed",
      payload: { callId, isError: false, output: "{}" },
    },
  };
}

describe("R5 streamingToolUses accumulator (session-transcript)", () => {
  test("E5.1 empty event sequence yields streamingToolUses=[]", () => {
    const t = adaptTranscriptEvents([]);
    expect(t.streamingToolUses).toEqual([]);
  });

  test("E5.2 single tool block_start + single delta yields one element with the delta concatenated into unparsedToolInput", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, '{"command": "ls'),
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.index).toBe(0);
    expect(t.streamingToolUses[0]?.contentBlock.id).toBe("c1");
    expect(t.streamingToolUses[0]?.contentBlock.name).toBe("Bash");
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe('{"command": "ls');
  });

  test("E5.2b multiple deltas to the same tool index concatenate in arrival order", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, '{"command":'),
      delta("c1", 0, ' "ls"'),
      delta("c1", 0, "}"),
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe('{"command": "ls"}');
  });

  test("E5.3 two concurrent tools at indices 0 and 1 with interleaved deltas accumulate independently", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c-a", 0, "Read"),
      blockStart("c-b", 1, "Grep"),
      delta("c-a", 0, '{"file": "/a'),
      delta("c-b", 1, '{"pattern":'),
      delta("c-a", 0, '"}'),
      delta("c-b", 1, ' "x"}'),
    ]);
    expect(t.streamingToolUses).toHaveLength(2);
    const a = t.streamingToolUses.find((s) => s.index === 0);
    const b = t.streamingToolUses.find((s) => s.index === 1);
    expect(a?.unparsedToolInput).toBe('{"file": "/a"}');
    expect(b?.unparsedToolInput).toBe('{"pattern": "x"}');
    expect(a?.contentBlock.name).toBe("Read");
    expect(b?.contentBlock.name).toBe("Grep");
  });

  test("E5.4 out-of-order delta (delta arrives before its block_start) does not throw and does not create a phantom element — array unchanged", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      delta("c1", 7, '{"x":1}'),
    ]);
    expect(t.streamingToolUses).toEqual([]);
  });

  test("E5.5 delta with empty partial_json string is appended as empty string (no exception, no array change beyond identity update)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, "abc"),
      delta("c1", 0, ""),
      delta("c1", 0, "def"),
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe("abcdef");
  });

  test("E5.6c turn_aborted clears streamingToolUses (parity with REPL.tsx:1609 setStreamingToolUses([]) on stream cancellation)", () => {
    const t = adaptTranscriptEvents([
      turnStart("t1"),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, "{partial"),
      {
        id: "abort",
        msg: { type: "turn_aborted", payload: { reason: "user_cancel" } },
      },
    ]);
    expect(t.streamingToolUses).toEqual([]);
    expect(t.isStreaming).toBe(false);
  });

  test("E5.6a stream cancelled / new turn boundary clears streamingToolUses; subsequent stream starts from []", () => {
    const t = adaptTranscriptEvents([
      turnStart("t1"),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, "{partial"),
      // New turn boundary — upstream parity at REPL.tsx:1609/2940 clears.
      turnStart("t2"),
    ]);
    expect(t.streamingToolUses).toEqual([]);
  });

  test("E5.6b a tool that completes within the same turn is removed from streamingToolUses (mirrors upstream Messages.tsx:446 filter)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, '{"x":1}'),
      complete("c1"),
    ]);
    expect(t.streamingToolUses).toEqual([]);
  });

  test("E5.6d completion after streamed block_start pairs without raw recovery text", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "FileRead"),
      delta("c1", 0, '{"file_path":"/tmp/secret.txt"}'),
      {
        id: "complete-c1",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "c1", isError: false, result: "read-ok" },
        },
      },
    ]);

    const allText = JSON.stringify(t.messages);
    expect(t.streamingToolUses).toEqual([]);
    expect(t.inProgressToolUseIDs.size).toBe(0);
    expect(allText).toContain("read-ok");
    expect(allText).not.toContain("arrived out of order and was recovered");
  });

  test("E5.7 snapshot identity differs across distinct event sequences (sanity check for accumulator-immutability of element shape)", () => {
    const a = adaptTranscriptEvents([turnStart(), blockStart("c1", 0)]);
    const b = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0),
      delta("c1", 0, "x"),
    ]);
    expect(a.streamingToolUses).not.toBe(b.streamingToolUses);
    // After the delta, the modified slot is a new object (immutable update via {...previous, unparsedToolInput})
    expect(b.streamingToolUses[0]).not.toBe(a.streamingToolUses[0]);
  });

  test("E5.8 a single delta with a multi-kilobyte partial_json appends in O(n) without regex-scanning the entire accumulated string", () => {
    // The accumulator does immutable string concat only; no regex over the
    // full unparsedToolInput per delta. This test exercises a sufficiently
    // large input to fail-fast if a future refactor introduces O(n^2)
    // behavior on the cumulative input length.
    const events: Evt[] = [turnStart(), blockStart("c1", 0)];
    const chunkSize = 4096;
    const chunkCount = 64; // 256 KB cumulative
    for (let i = 0; i < chunkCount; i++) {
      events.push(delta("c1", 0, "x".repeat(chunkSize)));
    }
    const start = Date.now();
    const t = adaptTranscriptEvents(events);
    const elapsedMs = Date.now() - start;
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.unparsedToolInput.length).toBe(
      chunkSize * chunkCount,
    );
    // Generous bound; on a normal machine this is well under 100ms.
    // The test exists to break loudly if anyone replaces the concat with
    // a per-delta full-string scan (O(n^2) territory).
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("B5.2 contentBlock falls back to a synthetic tool_use shape when the provider event omits it (covers AgenC providers that emit a minimal tool_input_block_start)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      {
        id: "bs-min",
        msg: {
          type: "tool_input_block_start",
          payload: { callId: "c1", index: 0, toolName: "Read" },
        },
      },
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.contentBlock.type).toBe("tool_use");
    expect(t.streamingToolUses[0]?.contentBlock.id).toBe("c1");
    expect(t.streamingToolUses[0]?.contentBlock.name).toBe("Read");
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe("");
  });

  test("B5.3 deltas missing a known index are dropped; deltas with non-string partialJson are dropped (parity with the provider `if (!element) return _` and `typeof partial_json === 'string'` guards)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, "real"),
      // Non-string partialJson (e.g. number) is ignored
      {
        id: "d-bogus",
        msg: { type: "tool_input_delta", payload: { callId: "c1", index: 0, partialJson: 42 } },
      },
      // Index that has no live block — ignored
      {
        id: "d-missing",
        msg: { type: "tool_input_delta", payload: { callId: "c1", index: 99, partialJson: "phantom" } },
      },
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe("real");
  });

  test("B5.5 input_json_delta with snake_case partial_json field is also accepted (provider-native field name)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      {
        id: "d-snake",
        msg: { type: "tool_input_delta", payload: { callId: "c1", index: 0, partial_json: "{\"k\":1}" } },
      },
    ]);
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe('{"k":1}');
  });

  test("B5.4 duplicate tool_input_block_start with same (index, contentBlock.id) does not append a duplicate slot (retried-stream guard)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      blockStart("c1", 0, "Bash"),
      blockStart("c1", 0, "Bash"),
      delta("c1", 0, "x"),
    ]);
    expect(t.streamingToolUses).toHaveLength(1);
    expect(t.streamingToolUses[0]?.unparsedToolInput).toBe("x");
  });
});
