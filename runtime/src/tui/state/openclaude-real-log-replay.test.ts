import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { normalizeTranscriptMessages } from "../transcript/normalize.js";
import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "./events-to-messages.js";

const GOLDEN_ROLLOUT_PATH =
  process.env.AGENC_TUI_PARITY_ROLLOUT ??
  "/home/tetsuo/.agenc/projects/home-tetsuo-git-stream-test-agenc-shell-843ca075/sessions/conv-mojpvw10/rollout-2026-04-29T07-12-01-769Z-conv-mojpvw10.jsonl";

const TRANSCRIPT_EVENT_TYPES = new Set([
  "session_configured",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "user_message",
  "agent_message",
  "agent_message_delta",
  "tool_call_started",
  "tool_call_completed",
  "tool_progress",
  "exec_command_begin",
  "exec_command_end",
  "context_compacted",
  "warning",
  "error",
  "stream_error",
  "deprecation_notice",
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
  "collab_resume_begin",
  "collab_resume_end",
  "plan_started",
  "plan_delta",
  "plan_item_completed",
  "plan_exited",
]);

function readGoldenRolloutEvents(): TranscriptSourceEvent[] {
  if (!existsSync(GOLDEN_ROLLOUT_PATH)) {
    throw new Error(
      `Missing required OpenClaude parity golden rollout: ${GOLDEN_ROLLOUT_PATH}`,
    );
  }
  const events: TranscriptSourceEvent[] = [];
  for (const line of readFileSync(GOLDEN_ROLLOUT_PATH, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      payload?: {
        id?: string;
        seq?: number;
        msg?: { type?: string; payload?: unknown };
      };
    };
    if (entry.type !== "event_msg") continue;
    const msg = entry.payload?.msg;
    if (!msg?.type || !TRANSCRIPT_EVENT_TYPES.has(msg.type)) continue;
    events.push({
      id: entry.payload?.id,
      seq: entry.payload?.seq,
      type: msg.type,
      payload: msg.payload,
    } as TranscriptSourceEvent);
  }
  return events;
}

describe("OpenClaude real-log replay parity gate", () => {
  test("collapses conv-mojpvw10 into a clean, ordered transcript", () => {
    const messages = normalizeTranscriptMessages(
      eventsToMessages(readGoldenRolloutEvents()),
    );
    const kindCounts = messages.reduce<Record<string, number>>((counts, message) => {
      counts[message.kind] = (counts[message.kind] ?? 0) + 1;
      return counts;
    }, {});
    const assistantText = messages
      .filter((message) => message.kind === "assistant")
      .map((message) => message.content)
      .join("\n");
    const rendered = JSON.stringify(messages).toLowerCase();
    const lastAssistantIndex = messages.findLastIndex(
      (message) => message.kind === "assistant",
    );
    const trailingToolRows =
      lastAssistantIndex >= 0
        ? messages.slice(lastAssistantIndex + 1).filter((message) =>
            message.kind === "tool_call" ||
            message.kind === "tool_group" ||
            message.kind === "activity"
          )
        : [];

    expect(messages.length).toBeLessThanOrEqual(30);
    expect(kindCounts.assistant ?? 0).toBeLessThanOrEqual(5);
    expect(kindCounts.tool_call ?? 0).toBeLessThanOrEqual(12);
    expect(kindCounts.tool_group ?? 0).toBeGreaterThanOrEqual(1);
    expect(trailingToolRows).toHaveLength(0);
    expect(rendered).not.toContain("llm_request_metadata");
    expect(assistantText).not.toMatch(
      /\b(?:let me|still failing|wait|i need to|i will run|i'll run)\b/iu,
    );
  });
});
