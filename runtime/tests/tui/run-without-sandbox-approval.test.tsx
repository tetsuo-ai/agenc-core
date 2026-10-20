import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { APPROVED, DENIED, type ReviewDecision } from "../../src/permissions/review-decision.js";
import { buildDaemonApprovalCtx } from "../../src/tui/daemon-approval-context.js";
import { createRoot } from "../../src/tui/ink.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";

/**
 * The separate approval asked before a call the sandbox refused runs without
 * it must read as that question in every client, including on a terminal so
 * short that the card drops its reason text: the daemon passes the request's
 * `run_without_sandbox` permission on, and the card's title says it.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

const QUESTION =
  "Run Write without the sandbox? The sandbox refused it: sandbox workspace_write blocked write outside " +
  "workspace: /home/user/outside-proof.txt. If you approve, it runs once more with the sandbox off, so the " +
  "sandbox's limits on files and network do not apply to it. Your earlier approval only let it run inside " +
  "the sandbox.";

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
  root.render(<AgenCPermissionOverlay request={request} tools={[{ name: "Write" }]} />);
  await sleep();
  return {
    frame: () => lastFrame(output),
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

/** The request as the daemon TUI receives it from `event.permission_request`. */
function daemonRequest(
  permissions: readonly string[],
  resolve: (decision: ReviewDecision) => void,
): PendingRequest {
  const input = { file_path: "/home/user/outside-proof.txt", content: "outside-ok\n", sandbox_permissions: "require_escalated" };
  const ctx = buildDaemonApprovalCtx(
    { id: "session" },
    {
      callId: "request-2",
      toolCallId: "call-1",
      turnId: "turn-1",
      permissions: [...permissions],
      input,
      reason: QUESTION,
    },
    "Write",
    new AbortController().signal,
  );
  return { id: "request-2", ctx, input, description: QUESTION, resolve };
}

describe("the approval to run a refused call without the sandbox", () => {
  test("is marked on the daemon approval context only when the request names it", () => {
    const resolve = () => {};
    expect(daemonRequest(["tool.use", "run_without_sandbox"], resolve).ctx.runsWithoutSandbox).toBe(true);
    expect(daemonRequest(["tool.use"], resolve).ctx.runsWithoutSandbox).toBeUndefined();
    expect(daemonRequest([], resolve).ctx.runsWithoutSandbox).toBeUndefined();
  });

  test.each([40, 16])("says so in its title on a %i-row terminal, and approves once on 1", async (rows) => {
    const decisions: ReviewDecision[] = [];
    const card = await renderCard(daemonRequest(["tool.use", "run_without_sandbox"], (d) => decisions.push(d)), rows);
    try {
      // Frames are drawn with cursor moves, not spaces, and wrapped rows end
      // in the popup border: compare without either.
      const frame = card.frame().replace(/[\s│]+/gu, "");
      expect(frame).toContain("TOOL·WRITE·RUNWITHOUTTHESANDBOX?");
      if (rows >= 24) {
        // A tall card also shows the refusal and what approving changes.
        expect(frame).toContain("runwithoutthesandbox?·Write");
        expect(frame).toContain("SANDBOXwouldbeoff");
        expect(frame).toContain("RunWritewithoutthesandbox?Thesandboxrefusedit:sandboxworkspace_writeblockedwrite");
        expect(frame).toContain("thesandbox'slimitsonfilesandnetworkdonotapplytoit.");
        expect(frame).toContain("Existingcontentunavailable;thiswritemayoverwriteafile.");
      } else {
        // Too short for the reason row: the title still asks the question.
        expect(frame).not.toContain("Thesandboxrefusedit");
      }
      await card.press("1");
      expect(decisions).toEqual([APPROVED]);
    } finally {
      await card.close();
    }
  });

  test("declines on 3", async () => {
    const decisions: ReviewDecision[] = [];
    const card = await renderCard(daemonRequest(["tool.use", "run_without_sandbox"], (d) => decisions.push(d)), 40);
    try {
      await card.press("3");
      expect(decisions).toEqual([{ ...DENIED, decidedBy: "user" }]);
    } finally {
      await card.close();
    }
  });

  test("leaves an ordinary approval card as it was", async () => {
    const card = await renderCard(daemonRequest(["tool.use"], () => {}), 40);
    try {
      const frame = card.frame().replace(/[\s│]+/gu, "");
      expect(frame).not.toContain("RUNWITHOUTTHESANDBOX");
      expect(frame).toContain("TOOL·WRITE·MEDIUM-RISKAPPROVAL");
      expect(frame).toContain("SCOPEmedium");
      // An ordinary Write card keeps its preview warning in place of the reason.
      expect(frame).toContain("note·Existingcontentunavailable;thiswritemayoverwriteafile.");
      expect(frame).not.toContain("Thesandboxrefusedit");
    } finally {
      await card.close();
    }
  });
});
