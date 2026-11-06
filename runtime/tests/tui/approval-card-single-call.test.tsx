import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { APPROVED_FOR_SESSION, type ReviewDecision } from "../../src/permissions/review-decision.js";
import { buildDaemonApprovalCtx } from "../../src/tui/daemon-approval-context.js";
import { createRoot } from "../../src/tui/ink.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";

/**
 * A call a safety check asked about cannot be covered by a session grant:
 * the daemon names it with the `single_call` permission, and the card's
 * session choice reads as approving this call only, in full and short cards.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const INPUT = { file_path: "/repo/.git/config", old_string: "bare = false", new_string: "bare = true" };

function lastFrame(output: string): string {
  let frame: string | null = null;
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;
    const end = output.indexOf(SYNC_END, start + SYNC_START.length);
    if (end === -1) break;
    const content = output.slice(start + SYNC_START.length, end);
    if (content.trim().length > 0) frame = content;
    cursor = end + SYNC_END.length;
  }
  return stripAnsi(frame ?? output);
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** An Edit request as the daemon TUI receives it from `event.permission_request`. */
function editRequest(permissions: readonly string[], resolve: (decision: ReviewDecision) => void = () => {}): PendingRequest {
  const ctx = buildDaemonApprovalCtx(
    { id: "session" },
    { callId: "request-1", turnId: "turn-1", permissions: [...permissions], input: INPUT },
    "Edit",
    new AbortController().signal,
  );
  return { id: "request-1", ctx, input: INPUT, description: "Edit a protected file", resolve };
}

async function renderCard(request: PendingRequest, rows: number) {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; ref: () => void; setRawMode: (mode: boolean) => void; unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, { columns: 120, rows, isTTY: true });
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(<AgenCPermissionOverlay request={request} tools={[{ name: "Edit" }]} />);
  await sleep();
  return {
    frame: () => lastFrame(output).replace(/[\s│]+/gu, ""),
    press: async (key: string) => {
      stdin.write(key);
      await sleep();
    },
    close: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
  };
}

describe("a request no session grant can cover", () => {
  test("is marked on the daemon approval context only when the request names it", () => {
    expect(editRequest(["tool.use", "single_call"]).ctx.safetyCheck).toBe(true);
    expect(editRequest(["tool.use"]).ctx.safetyCheck).toBeUndefined();
    expect(editRequest([]).ctx.safetyCheck).toBeUndefined();
  });

  test.each([
    ["a full card", 40, "2approveforsessionthiscallonly,safetycheck"],
    ["a short card", 16, "2approveforsession·thiscallonly"],
  ])("says the session choice approves this call only on %s", async (_label, rows, row) => {
    const decisions: ReviewDecision[] = [];
    const card = await renderCard(editRequest(["tool.use", "single_call"], (decision) => decisions.push(decision)), rows);
    try {
      const frame = card.frame();
      expect(frame).toContain(row);
      expect(frame).not.toContain("thisfileonly");
      await card.press("2");
      expect(decisions).toEqual([APPROVED_FOR_SESSION]);
    } finally {
      await card.close();
    }
  });

  test("keeps the file scope on an ordinary Edit card", async () => {
    const card = await renderCard(editRequest(["tool.use"]), 40);
    try {
      expect(card.frame()).toContain("2approveforsessionEditthisfileonly");
    } finally {
      await card.close();
    }
  });
});
