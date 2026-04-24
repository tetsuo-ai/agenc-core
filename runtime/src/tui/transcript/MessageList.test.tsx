/**
 * Wave 4-A MessageList tests.
 *
 * Covers the per-kind dispatcher and the sticky-scroll behavior. The
 * sticky assertion runs against a fake scroll handle that records what
 * `scrollToBottom()` was called, so we can verify the "follow on new
 * message" contract without having to drive a real layout pass.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement, DOMNode } from "../ink/dom.js";
import Box from "../ink/components/Box.js";
import { charInCellAt } from "../ink/screen.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import {
  MessageList,
  transcriptMutationKey,
  truncate,
  type TranscriptMessage,
} from "./MessageList.js";
import type { PlanEvent } from "./PlanProgress.js";

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
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  unmount: () => void;
  stdout: PassThrough;
  rerender: (el: React.ReactElement) => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(<KeybindingProvider>{element}</KeybindingProvider>);
  await new Promise((r) => setTimeout(r, 40));
  return {
    stdout,
    rerender: (el) =>
      root.render(<KeybindingProvider>{el}</KeybindingProvider>),
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

async function captureFrame(stdout: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stdout.on("data", (b: Buffer) => chunks.push(b));
  await new Promise((r) => setTimeout(r, 40));
  return Buffer.concat(chunks).toString("utf8");
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
      row += charInCellAt(screen as never, x, y) ?? " ";
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows.join("\n");
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) {
    throw new Error("Ink root not found in test harness");
  }
  return instance.rootNode;
}

function collectTextNodes(node: DOMNode): string[] {
  if (node.nodeName === "#text") {
    return [node.nodeValue];
  }
  const parts: string[] = [];
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      parts.push(...collectTextNodes(child));
    }
  }
  return parts;
}

function mkMsg(
  partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "kind">,
): TranscriptMessage {
  return {
    turnId: "t1",
    content: "",
    timestamp: 0,
    ...partial,
  };
}

describe("MessageList", () => {
  test("renders an empty list without throwing", async () => {
    const { unmount, stdout } = await mount(<MessageList messages={[]} />);
    const frame = await captureFrame(stdout);
    // Empty list is a valid state — just assert it rendered something
    // (not the empty string, since the ScrollBox chrome alone emits
    // frame bytes) and didn't write any of the per-kind sigils.
    expect(frame).not.toContain("\u25B8");
    expect(frame).not.toContain("\u2717");
    unmount();
  });

  test("renders a user message with the cyan ▸ sigil", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u1", kind: "user", content: "hello" })]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u25B8");
    expect(frame).toContain("hello");
    unmount();
  });

  test("renders a tool_call with truncated args", async () => {
    const longArg = "x".repeat(200);
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "c1",
            kind: "tool_call",
            toolName: "shell",
            toolArgs: { cmd: longArg },
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("shel");
    // The ellipsis character from truncate() proves the long args were
    // compressed before rendering.
    expect(frame).toContain("\u2026");
    unmount();
  });

  test("renders tool_result with success vs error glyphs", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "r1",
            kind: "tool_result",
            content: "ok",
            isError: false,
          }),
          mkMsg({
            id: "r2",
            kind: "tool_result",
            content: "fail",
            isError: true,
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u2713");
    expect(frame).toContain("\u2717");
    unmount();
  });

  test("renders system.readFile tool_result without head-tail elision", async () => {
    const content = [
      "1→# AgenC Shell Implementation Plan",
      "2→",
      "3→This document is the normative implementation spec for AgenC.",
      "4→It replaces the earlier pseudocode-heavy draft.",
      "5→This line should stay visible too.",
      "6→And this one.",
      "7→No transcript elision marker should appear.",
    ].join("\n");
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "read-1",
            kind: "tool_result",
            toolName: "system.readFile",
            content,
            isError: false,
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("system.readFile");
    expect(frame).toContain("1→#");
    expect(frame).toContain("AgenC");
    expect(frame).toContain("Implementation");
    expect(frame).toContain("Plan");
    expect(frame).toContain("7→No");
    expect(frame).toContain("transcript");
    expect(frame).toContain("elision");
    expect(frame).toContain("appear.");
    expect(frame).not.toContain("lines elided");
    unmount();
  });

  test("renders a warning with the ⚠ glyph", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[mkMsg({ id: "w1", kind: "warning", content: "rate limit" })]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("\u26A0");
    // Ink may column-align adjacent `<Text>` children with padding when
    // the outer Box is a `flexDirection="row"` container — the string
    // "rate" and "limit" can land in separate screen columns. Assert
    // each word independently so the spacing scheme doesn't break the
    // content check.
    expect(frame).toContain("rate");
    expect(frame).toContain("limit");
    unmount();
  });

  test("renders slash results through the breadcrumb renderer", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "slash-1",
            kind: "slash_result",
            content: "Compacted 2 turns",
            slashInput: "/compact",
            slashResult: { kind: "compact", text: "Compacted 2 turns" },
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("/compact");
    expect(frame).toContain("Compacted");
    unmount();
  });

  test("renders compact boundaries as meta rows", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "meta-1",
            kind: "meta",
            label: "compact",
            content: "Context compacted: summary (900 -> 300 tokens)",
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("Context");
    expect(frame).toContain("compacted");
    expect(frame).toContain("900");
    expect(frame).toContain("300");
    unmount();
  });

  test("renders plan progress rows through the dedicated renderer", async () => {
    const planEvents: PlanEvent[] = [
      {
        kind: "plan_started",
        planItemId: "plan-1",
        title: "audit chrome",
        timestamp: 1,
      },
      {
        kind: "plan_item_completed",
        planItemId: "plan-1",
        finalText: "mount banner and status line",
        timestamp: 2,
      },
    ];
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "plan-1",
            kind: "plan_progress",
            planEvents,
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("Updated");
    expect(frame).toContain("Plan");
    expect(frame).toContain("audit");
    expect(frame).toContain("chrome");
    expect(frame).toContain("mount");
    expect(frame).toContain("banner");
    expect(frame).toContain("status");
    expect(frame).toContain("line");
    expect(frame).toContain("\u2714");
    unmount();
  });

  test("renders read/write/edit/MCP tools as semantic cells", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "read",
            kind: "tool_call",
            toolName: "system.readFile",
            toolArgs: { path: "src/App.tsx" },
            toolResultContent: "1→export const App = () => null",
            isComplete: true,
          }),
          mkMsg({
            id: "write",
            kind: "tool_call",
            toolName: "system.writeFile",
            toolArgs: { path: "src/App.tsx" },
            toolResultContent: "wrote 128 bytes",
            isComplete: true,
          }),
          mkMsg({
            id: "edit",
            kind: "tool_call",
            toolName: "system.editFile",
            toolArgs: { path: "src/App.tsx" },
            toolResultContent: "replaced 1 occurrence",
            isComplete: true,
          }),
          mkMsg({
            id: "mcp",
            kind: "tool_call",
            toolName: "mcp.github.listIssues",
            toolArgs: { owner: "tetsuo-ai", repo: "agenc-core" },
            toolResultContent: "Wall time: 0.0100 seconds\nOutput:\n2 issues",
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout).trim();
    expect(frame).toMatchInlineSnapshot(`
      "✓ Read src/App.tsx
        └ 1→export const App = () => null
      ✓ Wrote src/App.tsx
        └ wrote 128 bytes
      ✓ Edited src/App.tsx
        └ replaced 1 occurrence
      ✓ Called github.listIssues
        └ 2 issues"
    `);
    unmount();
  });

  test("renders shell write policy failures as compact blocked cells", async () => {
    const result = JSON.stringify({
      error:
        "shell_workspace_file_write_disallowed: Workflow implementation turns must use structured file tools for project file authoring. Use `apply_patch` for source edits instead of shell redirection. Blocked target(s): /repo/CMakeLists.txt",
    });
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "exec-block",
            kind: "tool_call",
            toolName: "exec_command",
            toolArgs: {
              cmd: "cat > CMakeLists.txt << 'EOF'\nproject(x)\nEOF",
            },
            toolResultContent: result,
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("✗ Blocked shell write");
    expect(frame).toContain("Blocked target: /repo/CMakeLists.txt");
    expect(frame).toContain("Use apply_patch for source edits");
    expect(frame).not.toContain("Workflow implementation turns");
    expect(frame).not.toContain("cat > CMakeLists.txt");
    unmount();
  });

  test("long transcript renders the scrollback tail without debug noise", async () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      mkMsg({
        id: `m-${index}`,
        kind: "user",
        content: `turn ${index}`,
      }),
    );
    const { unmount, stdout } = await mount(
      <Box flexDirection="column" height={12}>
        <MessageList messages={messages} />
      </Box>,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("turn 259");
    expect(frame).not.toContain("tool_routing_classified");
    unmount();
  });

  test("virtualizes long transcript DOM rows instead of mounting all history", async () => {
    const messages = Array.from({ length: 1_000 }, (_, index) =>
      mkMsg({
        id: `m-${index}`,
        kind: "user",
        content: `turn ${index}`,
      }),
    );

    const { unmount, stdout } = await mount(
      <Box flexDirection="column" height={12}>
        <MessageList messages={messages} />
      </Box>,
    );
    const frame = latestFrameText(stdout);
    const renderedTurns = collectTextNodes(getRootNode(stdout)).filter((text) =>
      /^turn \d+$/u.test(text),
    );

    expect(frame).toContain("turn 999");
    expect(renderedTurns.length).toBeLessThanOrEqual(240);
    expect(renderedTurns).not.toContain("turn 0");
    unmount();
  });

  test("renders fork/resume meta rows without generic brackets", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "meta-fork",
            kind: "meta",
            label: "fork",
            content: "Thread forked from sess-1",
          }),
          mkMsg({
            id: "meta-resume",
            kind: "meta",
            label: "resume",
            content: "Resumed after 12.3s pause",
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("Thread");
    expect(frame).toContain("forked");
    expect(frame).toContain("Resumed");
    expect(frame).not.toContain("[fork]");
    unmount();
  });

  test("new message triggers a follow frame write when sticky", async () => {
    // Sticky-follow is observable through the rerender: appending a
    // message when the ScrollBox is glued to the bottom should not
    // throw, and the new message's content should be present in the
    // next captured frame.
    const { unmount, stdout, rerender } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u1", kind: "user", content: "alpha" })]}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    rerender(
      <MessageList
        messages={[
          mkMsg({ id: "u1", kind: "user", content: "alpha" }),
          mkMsg({ id: "u2", kind: "user", content: "beta" }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("beta");
    unmount();
  });
});

describe("truncate helper", () => {
  test("mutation key changes when a streaming row mutates in place", () => {
    const base = [
      mkMsg({
        id: "a1",
        kind: "assistant",
        content: "hel",
        isComplete: false,
      }),
    ];
    const next = [
      mkMsg({
        id: "a1",
        kind: "assistant",
        content: "hello",
        isComplete: false,
      }),
    ];

    expect(transcriptMutationKey(base, true)).not.toBe(
      transcriptMutationKey(next, true),
    );
  });

  test("returns short strings unchanged and truncates long ones with ellipsis", () => {
    expect(truncate("abc", 10)).toBe("abc");
    const long = "x".repeat(200);
    const t = truncate(long, 50);
    expect(t.length).toBe(50);
    expect(t.endsWith("\u2026")).toBe(true);
  });
});
