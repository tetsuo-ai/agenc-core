import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import { buildDaemonApprovalCtx } from "../../src/tui/daemon-approval-context.js";
import { createRoot } from "../../src/tui/ink.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";

/**
 * Approval cards show paths under the user's home as `~/...`, as the
 * transcript's tool rows do, and keep a long path's file name. In the release
 * gate (scenario 8) a project memory save drew cards whose path line read
 * "/cell/home/.agenc/projects/v2--workspace-<64 hex>/memor…": the absolute home
 * path, cut before the file name, and its reason repeated the absolute path.
 */

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const HOME = homedir().replace(/[\\/]+$/u, "");
const MEMORY_FILE = join(
  HOME, ".agenc", "projects",
  "v2--workspace-ee6b2cfc2c245fc523ba3a993d2ca73d436fc4b9f77da0c8b564363fd7a51dec",
  "memory", "project-codename.md",
);
const SHOWN = MEMORY_FILE.replace(HOME, "~");

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

/** The rendered card, without the spaces and borders the renderer draws with cursor moves. */
async function renderedCard(request: PendingRequest): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; ref: () => void; setRawMode: (mode: boolean) => void; unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, { columns: 120, rows: 40, isTTY: true });
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  try {
    root.render(<AgenCPermissionOverlay request={request} tools={[{ name: "Write" }]} />);
    await sleep();
    return lastFrame(output).replace(/[\s│]+/gu, "");
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

/** A Write card as the daemon TUI receives it from `event.permission_request`. */
function writeRequest(permissions: readonly string[], reason: string): PendingRequest {
  const input = { file_path: MEMORY_FILE, content: "AMBER_HERON_7429\n" };
  const ctx = buildDaemonApprovalCtx(
    { id: "session" },
    { callId: "request-1", toolCallId: "call-1", turnId: "turn-1", permissions: [...permissions], input, reason },
    "Write",
    new AbortController().signal,
  );
  return { id: "request-1", ctx, input, description: reason, resolve: () => {} };
}

const compact = (text: string) => text.replace(/\s+/gu, "");

describe("approval cards show home paths as ~/...", () => {
  test.each([
    ["an ordinary card", ["tool.use"], `AgenC requested permissions to write ${MEMORY_FILE} with Write, but you haven't granted it yet.`],
    ["the run-without-sandbox question", ["tool.use", "run_without_sandbox"],
      `Run Write without the sandbox? The sandbox refused it: sandbox workspace_write blocked write outside workspace: ${MEMORY_FILE}. ` +
      "If you approve, it runs once more with the sandbox off, so the sandbox's limits on files and network do not apply to it."],
  ])("%s", async (_label, permissions, reason) => {
    expect(HOME.length).toBeGreaterThan(1);
    const frame = await renderedCard(writeRequest(permissions, reason));
    // No absolute home path anywhere on the card, whole or cut.
    expect(frame).not.toContain(compact(HOME));
    // The path line keeps the file name; the reason names the path from ~.
    expect(frame).toContain("~/.agenc/projects/v2--workspace-");
    expect(frame).toContain("/memory/project-codename.md");
    expect(frame).toContain(compact(SHOWN.slice(0, 40)));
  });
});
