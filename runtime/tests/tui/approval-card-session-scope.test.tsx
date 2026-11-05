import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { APPROVED_FOR_SESSION, type ReviewDecision } from "../../src/permissions/review-decision.js";
import { buildDaemonApprovalCtx } from "../../src/tui/daemon-approval-context.js";
import { createRoot } from "../../src/tui/ink.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";

/**
 * The session choice says what its grant covers in every card layout. A
 * short terminal drops the action descriptions and a narrow one cuts rows at
 * the end, so the scope words come first and a short form of them stays on
 * the row when the full words do not fit.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const TOOL = "mcp.inventory.get_stock";

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

/** A request as the daemon TUI receives it from `event.permission_request`. */
function daemonRequest(
  toolName: string,
  permissions: readonly string[],
  input: Record<string, unknown>,
  resolve: (decision: ReviewDecision) => void = () => {},
): PendingRequest {
  const ctx = buildDaemonApprovalCtx(
    { id: "session" },
    { callId: "request-1", turnId: "turn-1", permissions: [...permissions], input },
    toolName,
    new AbortController().signal,
  );
  return { id: "request-1", ctx, input, description: "Look up stock", resolve };
}

/** The card's rows, each without the spaces and borders the renderer draws with cursor moves. */
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

describe("the session choice on a short or narrow card", () => {
  test.each([
    ["a short terminal", { columns: 120, rows: 16 }],
    ["a narrow terminal", { columns: 40, rows: 40 }],
    ["a short and narrow terminal", { columns: 40, rows: 12 }],
  ])("keeps 'all calls' on the session row of an MCP card on %s", async (_label, size) => {
    const decisions: ReviewDecision[] = [];
    const card = await renderCard(
      daemonRequest(TOOL, ["tool.use", "mcp_no_fs_writes"], { sku: "a-1" }, (decision) => decisions.push(decision)),
      size,
    );
    try {
      const frame = card.frame();
      expect(frame).toMatch(/2approve[a-z]*(?:…|\.\.\.)?·allcalls/u);
      expect(frame).toContain("1approveonce");
      expect(frame).toContain("3deny");
      await card.press("2");
      expect(decisions).toEqual([APPROVED_FOR_SESSION]);
    } finally {
      await card.close();
    }
  });

  test("keeps 'this action' on the session row of an ordinary card on a short terminal", async () => {
    const card = await renderCard(daemonRequest("exec_command", ["tool.use"], { cmd: "node --test" }), { columns: 120, rows: 16 });
    try {
      expect(card.frame()).toContain("2approveforsession·thisaction");
    } finally {
      await card.close();
    }
  });
});

describe("the session choice of a tool with a long name", () => {
  test("names the scope before the tool, so cutting the row keeps it", async () => {
    const toolName = `mcp.${"warehouse_inventory_".repeat(8)}get_stock`;
    const card = await renderCard(
      daemonRequest(toolName, ["tool.use", "mcp_no_fs_writes"], { sku: "a-1" }),
      { columns: 120, rows: 40 },
    );
    try {
      const frame = card.frame();
      expect(frame).toContain("2approveforsessionanyarguments,everymcp.warehouse_inventory_");
      expect(frame).not.toContain("thisexactactiononly");
    } finally {
      await card.close();
    }
  });
});
