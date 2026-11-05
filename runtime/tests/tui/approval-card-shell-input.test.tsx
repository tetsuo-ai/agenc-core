import { homedir } from "node:os";
import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { APPROVED, type ReviewDecision } from "../../src/permissions/review-decision.js";
import { buildDaemonApprovalCtx } from "../../src/tui/daemon-approval-context.js";
import { createRoot } from "../../src/tui/ink.js";
import instances from "../../src/tui/ink/instances.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";

/**
 * A card shows the shell input a person approves as the shell gets it:
 * the text typed into a running process with its paths as given, and the
 * whole of a long or multiline command, on the card or in its full view,
 * with the answer rows always on screen.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const HOME = homedir().replace(/[\\/]+$/u, "");

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

const compact = (text: string) => text.replace(/[\s│]+/gu, "");

/** A request as the daemon TUI receives it from `event.permission_request`. */
function daemonRequest(
  toolName: string,
  input: Record<string, unknown>,
  resolve: (decision: ReviewDecision) => void = () => {},
): PendingRequest {
  const ctx = buildDaemonApprovalCtx(
    { id: "session" },
    { callId: "request-1", turnId: "turn-1", permissions: ["tool.use"], input },
    toolName,
    new AbortController().signal,
  );
  return { id: "request-1", ctx, input, description: "Run a command", resolve };
}

async function renderCard(request: PendingRequest, size: { readonly columns: number; readonly rows: number }) {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; ref: () => void; setRawMode: (mode: boolean) => void; unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, { ...size, isTTY: true });
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(<AgenCPermissionOverlay request={request} tools={[{ name: request.ctx.toolName }]} />);
  await sleep();
  return {
    /** A full redraw, without the spaces and borders the renderer draws with cursor moves. */
    frame: async () => {
      instances.get(stdout as unknown as NodeJS.WriteStream)?.forceRedraw();
      await sleep();
      return compact(lastFrame(output));
    },
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

function expectAnswerRows(frame: string): void {
  expect(frame).toContain("1approveonce");
  expect(frame).toContain("2approveforsession");
  expect(frame).toContain("3deny");
}

describe("text typed into a running process", () => {
  // A shell reading the session's stdin does not expand ~ inside quotes, so a
  // shortened path would read as a different command.
  test.each([
    ["the home directory in single quotes", `rm -rf '${HOME}'\n`],
    ["a home path in double quotes", `cat "${HOME}/notes/todo.txt"\n`],
  ])("keeps %s as given", async (_label, chars) => {
    expect(HOME.length).toBeGreaterThan(1);
    const card = await renderCard(daemonRequest("write_stdin", { session_id: 7, chars }), { columns: 120, rows: 40 });
    try {
      const frame = await card.frame();
      expect(frame).toContain(`$${compact(chars)}`);
      expect(frame).not.toMatch(/['"=]~/u);
    } finally {
      await card.close();
    }
  });
});

describe("a long or multiline shell command", () => {
  test("shows the last argument of a long single-line command", async () => {
    const cmd = `printf '%s\\n' ${Array.from({ length: 40 }, (_, index) => `argument-${index}`).join(" ")} final-argument-marker`;
    const card = await renderCard(daemonRequest("exec_command", { cmd }), { columns: 120, rows: 40 });
    try {
      const frame = await card.frame();
      expect(frame).toContain("$printf'%s\\n'argument-0argument-1");
      expect(frame).toContain("argument-39final-argument-marker");
      expectAnswerRows(frame);
    } finally {
      await card.close();
    }
  });

  test("shows every line of a short multiline command", async () => {
    const cmd = "cat > notes.txt <<'EOF'\nfirst-heredoc-line\nsecond-heredoc-line\nEOF\nwc -l notes.txt";
    const card = await renderCard(daemonRequest("exec_command", { cmd }), { columns: 120, rows: 40 });
    try {
      const frame = await card.frame();
      expect(frame).toContain("$cat>notes.txt<<'EOF'first-heredoc-linesecond-heredoc-lineEOFwc-lnotes.txt");
      expect(frame).not.toContain("morelines");
      expectAnswerRows(frame);
    } finally {
      await card.close();
    }
  });

  test.each([
    ["a tall terminal", { columns: 120, rows: 40 }],
    ["a 24-row terminal", { columns: 100, rows: 24 }],
    ["a short terminal", { columns: 120, rows: 16 }],
  ])("marks a command too long for the card on %s and shows all of it on ctrl+w d", async (_label, size) => {
    const decisions: ReviewDecision[] = [];
    const cmd = Array.from({ length: 30 }, (_, index) => `echo step-${index + 1}-of-30`).join("\n");
    const card = await renderCard(daemonRequest("exec_command", { cmd }, (decision) => decisions.push(decision)), size);
    try {
      const frame = await card.frame();
      expectAnswerRows(frame);
      expect(frame).toMatch(/(?:\+\d+morelines|\$…\d+lines)·ctrl\+wdfullcommand/u);
      expect(frame).not.toContain("step-30-of-30");
      await card.press("\x17");
      await card.press("d");
      const fullView = await card.frame();
      expect(fullView).toContain("FULLAPPROVALCOMMAND");
      expect(fullView).toContain("$echostep-1-of-30");
      await card.press("G");
      expect(await card.frame()).toContain("echostep-30-of-30");
      await card.press("\r");
      expect(decisions).toEqual([]);
      expectAnswerRows(await card.frame());
      await card.press("1");
      expect(decisions).toEqual([APPROVED]);
    } finally {
      await card.close();
    }
  });
});
