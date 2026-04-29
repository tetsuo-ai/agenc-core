import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import React from "react";
import { describe, expect, test } from "vitest";

import instances from "../ink/instances.js";
import { createRoot } from "../ink/root.js";
import { charInCellAt } from "../ink/screen.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { MessageList } from "../transcript/MessageList.js";
import { normalizeTranscriptMessages } from "../transcript/normalize.js";
import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "./events-to-messages.js";

const GOLDEN_ROLLOUT_PATH =
  process.env.AGENC_TUI_PARITY_ROLLOUT ??
  fileURLToPath(new URL("fixtures/conv-mojpvw10-rollout.jsonl", import.meta.url));

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

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 48;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

function latestFrameText(stdout: PassThrough): string {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { frontFrame?: { screen?: { width: number; height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    let row = "";
    for (let x = 0; x < screen.width; x += 1) {
      row += charInCellAt(screen, x, y) ?? " ";
    }
    rows.push(row.trimEnd());
  }
  return rows.join("\n");
}

async function renderToFrame(element: React.ReactElement): Promise<string> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const frame = latestFrameText(stdout);
  root.unmount();
  instances.delete(stdout as unknown as NodeJS.WriteStream);
  stdin.end();
  stdout.end();
  return frame;
}

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

function stripSourceIdentifierTokens(text: string): string {
  return text.replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9][A-Za-z0-9._-]*\b/gu, "");
}

describe("OpenClaude real-log replay parity gate", () => {
  test("collapses conv-mojpvw10 into a clean, ordered transcript", async () => {
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
    const rawReadToolRows = messages.filter(
      (message) =>
        message.kind === "tool_call" &&
        message.isError !== true &&
        /^(?:fileread|read|readfile|read_file|grep|glob|ls|listdir|list_dir|system\.grep|system\.glob|system\.listdir)$/iu.test(
          message.toolName ?? "",
        ),
    );
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
    expect(rawReadToolRows).toHaveLength(0);
    expect(trailingToolRows).toHaveLength(0);
    expect(rendered).not.toContain("llm_request_metadata");
    expect(stripSourceIdentifierTokens(assistantText)).not.toMatch(
      /\b(?:let me|still failing|wait|i need to|i will run|i'll run)\b/iu,
    );

    const frame = await renderToFrame(
      React.createElement(
        KeybindingProvider,
        null,
        React.createElement(MessageList, { messages }),
      ),
    );
    expect(frame).not.toContain("#ifndef AGENC_INPUT_H");
    expect(frame).not.toContain("Lexer *lexer_create");
    expect(frame).not.toContain("cmake_minimum_required");
  });
});
