import { describe, expect, test } from "vitest";

import { REDACTED_SECRET } from "../secrets/sanitizer.js";
import { REJECT_MESSAGE } from "../utils/messages.js";
import type { RolloutItem } from "./rollout-item.js";
import {
  buildDpoPairs,
  buildSftExample,
  classifyTrajectory,
  isDpoEligible,
  isSftEligible,
  parseTrajectoryExportContents,
  reduceTrajectoryHistory,
  renderTrajectoryJsonl,
  responseItemText,
  toChatMessage,
} from "./trajectory-curate.js";
import { TRAJECTORY_EXPORT_SCHEMA_VERSION } from "./trajectory-export.js";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers — build the exact record shape the export sink writes
// ─────────────────────────────────────────────────────────────────────

function exportLine(sessionId: string, item: RolloutItem): string {
  return JSON.stringify({
    schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION,
    exportedAtUnixMs: 1_720_000_000_000,
    sessionId,
    rolloutPath: `/tmp/sessions/${sessionId}/rollout.jsonl`,
    item,
  });
}

function userItem(text: string): RolloutItem {
  return { type: "response_item", payload: { role: "user", content: text } };
}

function assistantItem(text: string): RolloutItem {
  return {
    type: "response_item",
    payload: { role: "assistant", content: text },
  };
}

function toolResultItem(text: string, toolCallId = "call-1"): RolloutItem {
  return {
    type: "response_item",
    payload: { role: "tool", content: text, toolCallId, toolName: "Bash" },
  };
}

let eventCounter = 0;
function eventItem(msg: unknown): RolloutItem {
  eventCounter += 1;
  return {
    type: "event_msg",
    payload: { id: `evt-${eventCounter}`, msg },
  } as unknown as RolloutItem;
}

function turnStarted(turnId: string): RolloutItem {
  return eventItem({ type: "turn_started", payload: { turnId } });
}

function turnComplete(turnId: string): RolloutItem {
  return eventItem({ type: "turn_complete", payload: { turnId } });
}

function turnAborted(turnId: string, reason: string): RolloutItem {
  return eventItem({ type: "turn_aborted", payload: { turnId, reason } });
}

function errorEvent(message: string): RolloutItem {
  return eventItem({ type: "error", payload: { cause: "test", message } });
}

function streamErrorEvent(message: string): RolloutItem {
  return eventItem({
    type: "stream_error",
    payload: { cause: "provider", message },
  });
}

function rolledBack(numTurns: number): RolloutItem {
  return eventItem({ type: "thread_rolled_back", payload: { numTurns } });
}

function cleanSessionItems(): RolloutItem[] {
  return [
    turnStarted("t1"),
    userItem("Fix the failing parser test"),
    assistantItem("Fixed the tokenizer boundary check."),
    turnComplete("t1"),
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Parsing + grouping
// ─────────────────────────────────────────────────────────────────────

describe("parseTrajectoryExportContents", () => {
  test("groups records by sessionId across files, in order", () => {
    const fileA = [
      exportLine("sess-a", turnStarted("t1")),
      exportLine("sess-b", turnStarted("t9")),
      exportLine("sess-a", userItem("hello")),
    ].join("\n");
    const fileB = exportLine("sess-a", turnComplete("t1"));

    const parsed = parseTrajectoryExportContents([fileA, fileB]);

    expect(parsed.recordCount).toBe(4);
    expect([...parsed.sessions.keys()].sort()).toEqual(["sess-a", "sess-b"]);
    const sessA = parsed.sessions.get("sess-a")!;
    expect(sessA).toHaveLength(3);
    expect(sessA[0]!.type).toBe("event_msg");
    expect(sessA[1]!.type).toBe("response_item");
    expect(sessA[2]!.type).toBe("event_msg");
  });

  test("counts malformed lines and unsupported schema versions without throwing", () => {
    const good = exportLine("sess-a", userItem("ok"));
    const futureSchema = JSON.stringify({
      schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION + 1,
      sessionId: "sess-future",
      item: userItem("nope"),
    });
    const parsed = parseTrajectoryExportContents([
      ["not json at all", good, "{\"sessionId\": 42}", futureSchema, ""].join(
        "\n",
      ),
    ]);

    expect(parsed.recordCount).toBe(1);
    expect(parsed.malformedLineCount).toBe(2);
    expect(parsed.unsupportedSchemaCount).toBe(1);
    expect(parsed.sessions.has("sess-future")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────

describe("classifyTrajectory filtering", () => {
  test("a clean completed session is SFT eligible", () => {
    const c = classifyTrajectory(cleanSessionItems());
    expect(c.hasTurnComplete).toBe(true);
    expect(isSftEligible(c)).toBe(true);
  });

  test("a session with a terminal error event is excluded", () => {
    const c = classifyTrajectory([
      ...cleanSessionItems(),
      errorEvent("provider exploded"),
    ]);
    expect(c.hasErrorEvent).toBe(true);
    expect(isSftEligible(c)).toBe(false);
    expect(isDpoEligible(c)).toBe(false);
  });

  test("an aborted/interrupted session is excluded", () => {
    const c = classifyTrajectory([
      turnStarted("t1"),
      userItem("do the thing"),
      turnAborted("t1", "interrupted"),
      turnStarted("t2"),
      userItem("ok try again"),
      assistantItem("done"),
      turnComplete("t2"),
    ]);
    expect(c.hasTurnAborted).toBe(true);
    expect(isSftEligible(c)).toBe(false);
    expect(isDpoEligible(c)).toBe(false);
  });

  test("a session with no completed turn is excluded", () => {
    const c = classifyTrajectory([turnStarted("t1"), userItem("hello")]);
    expect(c.hasTurnComplete).toBe(false);
    expect(isSftEligible(c)).toBe(false);
  });

  test("a user tool-use rejection marker excludes the session", () => {
    const c = classifyTrajectory([
      turnStarted("t1"),
      userItem("edit the file"),
      toolResultItem(REJECT_MESSAGE),
      assistantItem("Understood, waiting."),
      turnComplete("t1"),
    ]);
    expect(c.hasUserRejection).toBe(true);
    expect(isSftEligible(c)).toBe(false);
  });

  test("a permission-denied tool result excludes the session", () => {
    const c = classifyTrajectory([
      turnStarted("t1"),
      userItem("run it"),
      toolResultItem("Permission request denied by user."),
      turnComplete("t1"),
    ]);
    expect(c.hasUserRejection).toBe(true);
    expect(isSftEligible(c)).toBe(false);
  });

  test("a 'Rejected by user' tool result excludes the session", () => {
    const c = classifyTrajectory([
      turnStarted("t1"),
      userItem("run it"),
      toolResultItem("Rejected by user"),
      turnComplete("t1"),
    ]);
    expect(c.hasUserRejection).toBe(true);
    expect(isSftEligible(c)).toBe(false);
  });

  test("a recovered stream_error does not exclude the session", () => {
    const c = classifyTrajectory([
      turnStarted("t1"),
      userItem("hello"),
      streamErrorEvent("529 overloaded"),
      assistantItem("hi"),
      turnComplete("t1"),
    ]);
    expect(c.hasErrorEvent).toBe(false);
    expect(isSftEligible(c)).toBe(true);
  });

  test("a thread rollback routes the session to DPO, not SFT", () => {
    const c = classifyTrajectory([...cleanSessionItems(), rolledBack(1)]);
    expect(c.hasThreadRollback).toBe(true);
    expect(isSftEligible(c)).toBe(false);
    expect(isDpoEligible(c)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// SFT emission
// ─────────────────────────────────────────────────────────────────────

describe("buildSftExample", () => {
  test("emits standard chat schema with tool calls and tool results", () => {
    const items: RolloutItem[] = [
      turnStarted("t1"),
      userItem("List the files"),
      {
        type: "response_item",
        payload: {
          role: "assistant",
          content: [{ type: "text", text: "Listing now." }],
          toolCalls: [
            { id: "call-1", name: "Bash", arguments: '{"command":"ls"}' },
          ],
        },
      },
      toolResultItem("README.md\nsrc", "call-1"),
      assistantItem("Two entries: README.md and src."),
      turnComplete("t1"),
    ];

    const example = buildSftExample("sess-sft", items);
    expect(example).not.toBeNull();
    expect(example!.meta.sessionId).toBe("sess-sft");
    expect(example!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(example!.messages[1]!.content).toBe("Listing now.");
    expect(example!.messages[1]!.tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "Bash", arguments: '{"command":"ls"}' },
      },
    ]);
    expect(example!.messages[2]!.tool_call_id).toBe("call-1");
    expect(example!.messages[2]!.name).toBe("Bash");
  });

  test("returns null when there is nothing trainable", () => {
    expect(
      buildSftExample("sess-empty", [
        turnStarted("t1"),
        userItem("hello?"),
        turnComplete("t1"),
      ]),
    ).toBeNull();
  });

  test("applies compaction replacement history via the reducer", () => {
    const items: RolloutItem[] = [
      userItem("old prompt"),
      assistantItem("old answer"),
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [
            { role: "user", content: "compact summary of the session" },
          ],
        },
      },
      userItem("new prompt"),
      assistantItem("new answer"),
      turnComplete("t2"),
    ];
    const history = reduceTrajectoryHistory(items);
    expect(history.map((item) => responseItemText(item.content))).toEqual([
      "compact summary of the session",
      "new prompt",
      "new answer",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// DPO emission
// ─────────────────────────────────────────────────────────────────────

describe("buildDpoPairs", () => {
  function regenerationItems(rePrompt: string): RolloutItem[] {
    return [
      turnStarted("t1"),
      userItem("Set up the project"),
      assistantItem("Scaffolded with defaults."),
      turnComplete("t1"),
      turnStarted("t2"),
      userItem("Write the parser"),
      assistantItem("Here is a regex-based parser."),
      turnComplete("t2"),
      rolledBack(1),
      turnStarted("t3"),
      userItem(rePrompt),
      assistantItem("Here is a recursive-descent parser."),
      turnComplete("t3"),
    ];
  }

  test("derives a pair from a same-prompt rollback regeneration", () => {
    const { pairs, rollbackCount } = buildDpoPairs(
      "sess-dpo",
      regenerationItems("Write the parser"),
    );

    expect(rollbackCount).toBe(1);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair.meta.sessionId).toBe("sess-dpo");
    // Prompt: surviving prefix + the shared user message.
    expect(pair.prompt.map((m) => m.content)).toEqual([
      "Set up the project",
      "Scaffolded with defaults.",
      "Write the parser",
    ]);
    expect(pair.chosen.map((m) => m.content)).toEqual([
      "Here is a recursive-descent parser.",
    ]);
    expect(pair.rejected.map((m) => m.content)).toEqual([
      "Here is a regex-based parser.",
    ]);
  });

  test("does not fabricate a pair when the re-prompt differs", () => {
    const { pairs, rollbackCount } = buildDpoPairs(
      "sess-dpo",
      regenerationItems("Actually, write a lexer instead"),
    );
    expect(rollbackCount).toBe(1);
    expect(pairs).toHaveLength(0);
  });

  test("does not fabricate a pair when the rejected side has no assistant output", () => {
    const { pairs } = buildDpoPairs("sess-dpo", [
      turnStarted("t1"),
      userItem("Write the parser"),
      turnComplete("t1"),
      rolledBack(1),
      turnStarted("t2"),
      userItem("Write the parser"),
      assistantItem("Done."),
      turnComplete("t2"),
    ]);
    expect(pairs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Redaction on emission
// ─────────────────────────────────────────────────────────────────────

describe("renderTrajectoryJsonl", () => {
  test("re-applies the export sink's redaction to emitted rows", () => {
    const items: RolloutItem[] = [
      turnStarted("t1"),
      userItem("configure it with api_key='sk-plant-1234567890'"),
      assistantItem("Set OPENAI_API_KEY=abcd1234efgh5678 in the env."),
      turnComplete("t1"),
    ];
    const example = buildSftExample("sess-secret", items);
    expect(example).not.toBeNull();

    const jsonl = renderTrajectoryJsonl([example]);

    expect(jsonl).not.toContain("sk-plant-1234567890");
    expect(jsonl).not.toContain("abcd1234efgh5678");
    expect(jsonl).toContain(REDACTED_SECRET);
    // Still valid one-row JSONL in chat schema.
    const rows = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].messages[0].role).toBe("user");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Chat mapping
// ─────────────────────────────────────────────────────────────────────

describe("toChatMessage", () => {
  test("flattens text content blocks and omits absent tool fields", () => {
    const message = toChatMessage({
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "image_url", image_url: { url: "data:..." } },
        { type: "text", text: "part two" },
      ],
    });
    expect(message).toEqual({
      role: "assistant",
      content: "part one\npart two",
    });
    expect("tool_calls" in message).toBe(false);
    expect("tool_call_id" in message).toBe(false);
  });
});
