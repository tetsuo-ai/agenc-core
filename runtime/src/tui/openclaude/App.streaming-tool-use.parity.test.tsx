import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents, type AdaptedTranscript } from "./message-adapter.js";
import type { StreamingToolUse } from "../../agenc/upstream/utils/messages.js";

const APP_SOURCE_PATH = path.resolve(
  import.meta.dirname,
  "App.tsx",
);
const MESSAGE_ADAPTER_SOURCE_PATH = path.resolve(
  import.meta.dirname,
  "message-adapter.ts",
);

function readSource(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("R1 streamingToolUses prop wiring (App.tsx + transcript)", () => {
  test("B1.1 adaptTranscriptEvents result exposes streamingToolUses field", () => {
    const transcript = adaptTranscriptEvents([]);
    expect(transcript).toHaveProperty("streamingToolUses");
    expect(Array.isArray(transcript.streamingToolUses)).toBe(true);
  });

  test("B1.2/E1.1 empty event sequence yields an empty streamingToolUses array (matches upstream REPL.tsx:853 initial state)", () => {
    const transcript = adaptTranscriptEvents([]);
    expect(transcript.streamingToolUses).toEqual([]);
    expect(transcript.streamingToolUses.length).toBe(0);
  });

  test("B1.2 realistic non-streaming event sequence still yields an empty streamingToolUses (population is owned by R5, not R1)", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "user",
        msg: { type: "user_message", payload: { message: "hi" } },
      },
      {
        id: "delta",
        msg: { type: "agent_message_delta", payload: { delta: "hello" } },
      },
    ]);
    expect(transcript.streamingToolUses).toEqual([]);
  });

  test("E1.2 a synthesized AdaptedTranscript carrying a single StreamingToolUse element preserves identity through field read", () => {
    const sole: StreamingToolUse = {
      index: 0,
      contentBlock: {
        type: "tool_use",
        id: "su-1",
        name: "Bash",
        input: {},
      } as StreamingToolUse["contentBlock"],
      unparsedToolInput: '{"command": "ls',
    };
    const synthesized = mergeStreamingToolUses(adaptTranscriptEvents([]), [sole]);
    expect(synthesized.streamingToolUses).toHaveLength(1);
    expect(synthesized.streamingToolUses[0]).toBe(sole);
    expect(synthesized.streamingToolUses[0]?.unparsedToolInput).toBe(
      '{"command": "ls',
    );
  });

  test("E1.3 a synthesized AdaptedTranscript carrying two concurrent StreamingToolUse elements at distinct indices preserves both with independent unparsedToolInput strings", () => {
    const a: StreamingToolUse = {
      index: 0,
      contentBlock: {
        type: "tool_use",
        id: "su-a",
        name: "Read",
        input: {},
      } as StreamingToolUse["contentBlock"],
      unparsedToolInput: '{"file": "/a',
    };
    const b: StreamingToolUse = {
      index: 1,
      contentBlock: {
        type: "tool_use",
        id: "su-b",
        name: "Grep",
        input: {},
      } as StreamingToolUse["contentBlock"],
      unparsedToolInput: '{"pattern":',
    };
    const synthesized = mergeStreamingToolUses(adaptTranscriptEvents([]), [a, b]);
    expect(synthesized.streamingToolUses).toHaveLength(2);
    expect(synthesized.streamingToolUses[0]?.index).toBe(0);
    expect(synthesized.streamingToolUses[0]?.unparsedToolInput).toBe('{"file": "/a');
    expect(synthesized.streamingToolUses[1]?.index).toBe(1);
    expect(synthesized.streamingToolUses[1]?.unparsedToolInput).toBe('{"pattern":');
  });

  test("E1.4 App.tsx no longer hardcodes streamingToolUses={[]}", () => {
    const source = readSource(APP_SOURCE_PATH);
    expect(source).not.toMatch(/streamingToolUses\s*=\s*\{\s*\[\s*\]\s*\}/);
  });

  test("E1.5 App.tsx wires streamingToolUses from transcript.streamingToolUses", () => {
    const source = readSource(APP_SOURCE_PATH);
    expect(source).toMatch(/streamingToolUses\s*=\s*\{\s*transcript\.streamingToolUses[^}]*\}/);
  });

  test("E1.6 message-adapter.ts imports StreamingToolUse from runtime/src/agenc/upstream/utils/messages so the AgenC transcript field type matches the upstream <Messages> consumer prop type", () => {
    const source = readSource(MESSAGE_ADAPTER_SOURCE_PATH);
    expect(source).toMatch(
      /import\s+type\s*\{\s*StreamingToolUse\s*\}\s+from\s+["']\.\.\/\.\.\/agenc\/upstream\/utils\/messages\.js["']/,
    );
  });
});

function mergeStreamingToolUses(
  base: AdaptedTranscript,
  next: readonly StreamingToolUse[],
): AdaptedTranscript {
  return { ...base, streamingToolUses: next };
}
