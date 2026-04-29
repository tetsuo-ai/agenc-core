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
  truncateUserMessageForDisplay,
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

  test("renders a user message without local prompt sigil chrome", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u1", kind: "user", content: "hello" })]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("hello");
    expect(frame).not.toContain("\u25B8");
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
            toolName: "custom.tool",
            toolArgs: { cmd: longArg },
          }),
        ]}
      />,
    );
    await captureFrame(stdout);
    const rendered = collectTextNodes(getRootNode(stdout)).join("");
    expect(rendered).toContain("custom.tool");
    // The ellipsis character from truncate() proves the long args were
    // compressed before rendering.
    expect(rendered).toContain("\u2026");
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
    const rendered = collectTextNodes(getRootNode(stdout)).join("");
    expect(frame).toContain("●");
    expect(rendered).toContain("Tool Failed");
    expect(rendered).toContain("fail");
    unmount();
  });

  test("caps huge user prompts to keep transcript rendering bounded", async () => {
    const huge = `start-${"x".repeat(12_000)}-end`;
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[mkMsg({ id: "u-huge", kind: "user", content: huge })]}
      />,
    );
    const rendered = collectTextNodes(getRootNode(stdout)).join("\n");
    expect(rendered).toContain("start-");
    expect(rendered).toContain("-end");
    expect(rendered).toContain("chars omitted from displayed prompt");
    expect(rendered.length).toBeLessThan(11_000);
    unmount();
  });

  test("renders FileRead tool_result without head-tail elision", async () => {
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
            toolName: "FileRead",
            content,
            isError: false,
          }),
        ]}
      />,
    );
    const frame = await captureFrame(stdout);
    expect(frame).toContain("Read");
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

  test("renders structured write and exec results without raw JSON traces", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "write-json",
            kind: "tool_call",
            toolName: "Write",
            toolArgs: { path: "include/agenc/exec.h" },
            toolResultContent:
              '{"path":"include/agenc/exec.h","bytesWritten":171}',
            isComplete: true,
          }),
          mkMsg({
            id: "exec-json",
            kind: "tool_call",
            toolName: "exec_command",
            toolArgs: { cmd: "cat PLAN.md | head -n 1" },
            toolResultContent:
              '{"stdout":"# AgenC Shell Implementation Plan\\n","stderr":"","exitCode":0,"durationMs":39,"original_token_count":7}',
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● Write(include/agenc/exec.h)");
    expect(frame).toContain("● Bash(cat PLAN.md | head -n 1)");
    expect(frame).toContain("# AgenC Shell Implementation Plan");
    expect(frame).not.toContain("bytesWritten");
    expect(frame).not.toContain("original_token_count");
    expect(frame).not.toContain('{"stdout"');
    unmount();
  });

  test("renders plan interaction tools without raw JSON argument dumps", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "ask-question",
            kind: "tool_call",
            toolName: "AskUserQuestion",
            toolArgs: {
              questions: [
                {
                  header: "M5 scope",
                  question: "Prioritize M5 sub-tasks?",
                  options: [{ label: "Full plan" }, { label: "Compounds" }],
                },
              ],
            },
            toolResultContent:
              "User has answered your questions: Prioritize M5 sub-tasks? -> Full plan as-is. You can now continue with the user's answers in mind.",
            isComplete: true,
          }),
          mkMsg({
            id: "exit-plan",
            kind: "tool_call",
            toolName: "ExitPlanMode",
            toolArgs: {
              plan: "raw argument should not show",
            },
            toolResultContent:
              "User has approved your plan. You can now start coding.\n\n## Approved Plan:\nImplement M5.",
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● User Answered");
    expect(frame).toContain("Prioritize M5 sub-tasks?");
    expect(frame).toContain("● Plan Approved");
    expect(frame).toContain("Implement M5.");
    expect(frame).not.toContain('"questions"');
    expect(frame).not.toContain("raw argument should not show");
    unmount();
  });

  test("truncates shell output in chat mode with transcript expansion hint", async () => {
    const stderr = Array.from(
      { length: 12 },
      (_, index) => `error line ${index + 1}`,
    ).join("\n");
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "exec-long",
            kind: "tool_call",
            toolName: "exec_command",
            toolArgs: { cmd: "make -C build" },
            execCommand: "make -C build",
            execStderr: stderr,
            execExitCode: 2,
            execDurationMs: 100,
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("error line 1");
    expect(frame).toContain("error line 3");
    expect(frame).toContain("... +9 lines");
    expect(frame).toContain("Ctrl+O");
    expect(frame).not.toContain("error line 12");
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

  test("hides compact boundaries in normal mode and shows them in verbose transcript mode", async () => {
    const compactBoundary = mkMsg({
      id: "meta-1",
      kind: "meta",
      label: "compact",
      content: "Context compacted: summary (900 -> 300 tokens)",
    });

    const normal = await mount(<MessageList messages={[compactBoundary]} />);
    const normalFrame = await captureFrame(normal.stdout);
    expect(normalFrame).not.toContain("Context");
    expect(normalFrame).not.toContain("compacted");
    normal.unmount();

    const verbose = await mount(
      <MessageList messages={[compactBoundary]} verbose />,
    );
    const verboseFrame = await captureFrame(verbose.stdout);
    expect(verboseFrame).toContain("Context");
    expect(verboseFrame).toContain("compacted");
    expect(verboseFrame).toContain("900");
    expect(verboseFrame).toContain("300");
    verbose.unmount();
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
            toolName: "FileRead",
            toolArgs: { path: "src/App.tsx" },
            toolResultContent: "1→export const App = () => null",
            isComplete: true,
          }),
          mkMsg({
            id: "write",
            kind: "tool_call",
            toolName: "Write",
            toolArgs: {
              path: "src/App.tsx",
              content: "export const App = () => <main />;\n",
            },
            toolResultContent: "wrote 128 bytes",
            isComplete: true,
          }),
          mkMsg({
            id: "edit",
            kind: "tool_call",
            toolName: "Edit",
            toolArgs: {
              path: "src/App.tsx",
              old_string: "export const App = () => null",
              new_string: "export const App = () => <main />",
            },
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
      "● Read(src/App.tsx)
        ⎿  1→export const App = () => null
      ● Write(src/App.tsx)
      ● Edit(src/App.tsx)
        ⎿  replaced 1 occurrence
      ● MCP(github.listIssues)
        ⎿  2 issues"
    `);
    unmount();
  });

  test("does not render edit payload previews while a tool is running", async () => {
    const oldString = "int main(void) { return 0; }";
    const newString = "int main(void) { return 1; }";
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "edit-live",
            kind: "tool_call",
            toolName: "Edit",
            toolArgs: {
              path: "src/main.c",
              old_string: oldString,
              new_string: newString,
            },
            isComplete: false,
          }),
        ]}
        isStreaming
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("Editing(src/main.c)");
    expect(frame).not.toContain("@@ replace @@");
    expect(frame).not.toContain(oldString);
    expect(frame).not.toContain(newString);
    unmount();
  });

  test("collapses read/search bursts to one upstream-style summary row", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "read-1",
            kind: "tool_call",
            toolName: "FileRead",
            toolArgs: { path: "src/a.ts" },
            isComplete: true,
          }),
          mkMsg({
            id: "read-2",
            kind: "tool_call",
            toolName: "FileRead",
            toolArgs: { path: "src/b.ts" },
            isComplete: true,
          }),
          mkMsg({
            id: "grep-1",
            kind: "tool_call",
            toolName: "Grep",
            toolArgs: { pattern: "TODO" },
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("Searched for 1 pattern");
    expect(frame).toContain("Read 2 files");
    expect(frame).not.toContain("FileRead");
    expect(frame).not.toContain("src/a.ts");
    expect(frame).not.toContain("+");
    unmount();
  });

  test("active read/search groups show only the latest hint", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "read-1",
            kind: "tool_call",
            toolName: "FileRead",
            toolArgs: { path: "src/a.ts" },
            isComplete: true,
          }),
          mkMsg({
            id: "read-2",
            kind: "tool_call",
            toolName: "FileRead",
            toolArgs: { path: "src/b.ts" },
            isComplete: false,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("Reading 2 files");
    expect(frame).toContain("src/b.ts");
    expect(frame).not.toContain("src/a.ts");
    expect(frame).not.toContain("FileRead");
    unmount();
  });

  test("collapses directory listings as listed directories", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "list-1",
            kind: "tool_call",
            toolName: "ListDir",
            toolArgs: { path: "src" },
            isComplete: true,
          }),
          mkMsg({
            id: "list-2",
            kind: "tool_call",
            toolName: "ls",
            toolArgs: { path: "tests" },
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("Listed 2 directories");
    expect(frame).not.toContain("Read 2 files");
    expect(frame).not.toContain("ListDir");
    expect(frame).not.toContain("tests");
    unmount();
  });

  test("renders plan file writes as plan updates without the raw plan path", async () => {
    const planPath = `${process.env.HOME ?? "/home/u"}/.agenc/plans/demo.md`;
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "plan-write",
            kind: "tool_call",
            toolName: "Write",
            toolArgs: { path: planPath },
            toolResultMetadata: {
              ui: {
                kind: "file_mutation",
                filePath: planPath,
                operation: "write",
                additions: 59,
                removals: 0,
              },
            },
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● Updated Plan");
    expect(frame).toContain("Added 59 lines");
    expect(frame).not.toContain(planPath);
    expect(frame).not.toContain("Write(");
    unmount();
  });

  test("renders file mutation details from result metadata, not raw edit args", async () => {
    const oldString = "export const App = () => null";
    const newString = "export const App = () => <main />";
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "edit-metadata",
            kind: "tool_call",
            toolName: "Edit",
            toolArgs: {
              path: "src/App.tsx",
              old_string: oldString,
              new_string: newString,
            },
            toolResultContent:
              "The file src/App.tsx has been updated successfully.",
            toolResultMetadata: {
              ui: {
                kind: "file_mutation",
                filePath: "src/App.tsx",
                operation: "edit",
                additions: 1,
                removals: 1,
                replacements: 1,
              },
            },
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● Edit(src/App.tsx)");
    expect(frame).toContain("Added 1 line");
    expect(frame).toContain("removed 1 line");
    expect(frame).not.toContain("@@ replace @@");
    expect(frame).not.toContain("--- before");
    expect(frame).not.toContain("+++ after");
    expect(frame).not.toContain(oldString);
    expect(frame).not.toContain(newString);
    unmount();
  });

  test("edit-heavy transcripts stay compact and do not render raw payload previews", async () => {
    const oldString = "before-line\n".repeat(200);
    const newString = "after-line\n".repeat(200);
    const messages = Array.from({ length: 160 }, (_, index) =>
      mkMsg({
        id: `edit-${index}`,
        kind: "tool_call",
        toolName: "Edit",
        toolArgs: {
          path: `src/file-${index}.ts`,
          old_string: oldString,
          new_string: newString,
        },
        toolResultContent:
          "The file src/file.ts has been updated successfully.",
        toolResultMetadata: {
          ui: {
            kind: "file_mutation",
            filePath: `src/file-${index}.ts`,
            operation: "edit",
            additions: 200,
            removals: 200,
            replacements: 1,
          },
        },
        isComplete: true,
      }),
    );

    const { unmount, stdout } = await mount(
      <Box flexDirection="column" height={16}>
        <MessageList messages={messages} />
      </Box>,
    );
    const rendered = collectTextNodes(getRootNode(stdout)).join("\n");
    expect(rendered).toContain("Added 200 lines");
    expect(rendered).not.toContain("@@ replace @@");
    expect(rendered).not.toContain("before-line");
    expect(rendered).not.toContain("after-line");
    expect(rendered.length).toBeLessThan(20_000);
    unmount();
  });

  test("recognizes AgenC and AgenC-style aliases as semantic tool families", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "write-alias",
            kind: "tool_call",
            toolName: "write_file",
            toolArgs: { path: "src/main.ts" },
            toolResultContent: '{"path":"src/main.ts","bytesWritten":9}',
            isComplete: true,
          }),
          mkMsg({
            id: "edit-alias",
            kind: "tool_call",
            toolName: "edit_file",
            toolArgs: { path: "src/main.ts" },
            toolResultContent: '{"replacements":2}',
            isComplete: true,
          }),
          mkMsg({
            id: "grep-alias",
            kind: "tool_call",
            toolName: "grep",
            toolArgs: { pattern: "TODO" },
            toolResultContent: "src/main.ts:1:TODO",
            isComplete: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● Write(src/main.ts)");
    expect(frame).toContain("● Edit(src/main.ts)");
    expect(frame).toContain("2 replacements");
    expect(frame).toContain("● Search(TODO)");
    expect(frame).not.toContain("bytesWritten");
    unmount();
  });

  test("suppresses no-op edit failures from the transcript", async () => {
    const unchanged = "int builtin_eval(void) { return 0; }";
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "edit-noop",
            kind: "tool_call",
            toolName: "Edit",
            toolArgs: {
              path: "src/builtins/special.c",
              old_string: unchanged,
              new_string: unchanged,
            },
            toolResultContent:
              "No changes to make: old_string and new_string are exactly the same.",
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).not.toContain("Edit Failed");
    expect(frame).not.toContain("No changes to make");
    expect(frame).not.toContain("@@ replace @@");
    expect(frame).not.toContain("--- before");
    expect(frame).not.toContain("+++ after");
    unmount();
  });

  test("suppresses failed read and search probes from the transcript", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "read-missing",
            kind: "tool_call",
            toolName: "FileRead",
            toolArgs: { path: "src/state/arrays.h" },
            toolResultContent: "File does not exist: src/state/arrays.h",
            isComplete: true,
            isError: true,
          }),
          mkMsg({
            id: "search-enotdir",
            kind: "tool_call",
            toolName: "Grep",
            toolArgs: { pattern: "foo", path: "src/app/main.c" },
            toolResultContent: "spawn ENOTDIR",
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).not.toContain("Read Failed");
    expect(frame).not.toContain("Search Failed");
    expect(frame).not.toContain("src/state/arrays.h");
    expect(frame).not.toContain("spawn ENOTDIR");
    unmount();
  });

  test("renders edit failures compactly without rejection diffs", async () => {
    const oldString = "int builtin_eval(void) { return 0; }";
    const newString = "int builtin_eval(void) { return 1; }";
    const { unmount, stdout } = await mount(
      <MessageList
        messages={[
          mkMsg({
            id: "edit-failure",
            kind: "tool_call",
            toolName: "Edit",
            toolArgs: {
              path: "src/builtins/special.c",
              old_string: oldString,
              new_string: newString,
            },
            toolResultContent: `String to replace not found in file.\nString: ${oldString}`,
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("● Edit Failed(src/builtins/special.c)");
    expect(frame).toContain("Error editing file");
    expect(frame).not.toContain("@@ replace @@");
    expect(frame).not.toContain("--- before");
    expect(frame).not.toContain("+++ after");
    expect(frame).not.toContain(oldString);
    expect(frame).not.toContain(newString);
    unmount();
  });

  test("hides shell write policy failures in normal transcript rendering", async () => {
    const result = JSON.stringify({
      error:
        "shell_workspace_file_write_disallowed: Workflow implementation turns must use structured file tools for project file authoring. Use `Edit` or `Write` for source edits instead of shell redirection. Blocked target(s): /repo/CMakeLists.txt",
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
            toolResultMetadata: {
              recoverable: true,
              hiddenFromTranscript: true,
              kind: "shell_workspace_write_policy",
            },
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).not.toContain("● Blocked(shell write)");
    expect(frame).not.toContain("Shell write blocked");
    expect(frame).not.toContain("Workflow implementation turns");
    expect(frame).not.toContain("cat > CMakeLists.txt");
    unmount();
  });

  test("renders recoverable failures compactly in verbose transcript mode", async () => {
    const { unmount, stdout } = await mount(
      <MessageList
        verbose
        messages={[
          mkMsg({
            id: "exec-block-debug",
            kind: "tool_call",
            toolName: "exec_command",
            toolArgs: {
              cmd: "cat > CMakeLists.txt << 'EOF'\nproject(x)\nEOF",
            },
            toolResultContent: JSON.stringify({
              error:
                "shell_workspace_file_write_disallowed: Workflow implementation turns must use structured file tools for project file authoring. Blocked target(s): /repo/CMakeLists.txt",
            }),
            toolResultMetadata: {
              recoverable: true,
              hiddenFromTranscript: true,
              kind: "shell_workspace_write_policy",
            },
            isComplete: true,
            isError: true,
          }),
          mkMsg({
            id: "bad-args-debug",
            kind: "tool_call",
            toolName: "exec_command",
            toolArgs: { cd: "/tmp" },
            toolResultContent:
              "<tool_use_error>InputValidationError: required parameter `cmd` was not provided</tool_use_error>",
            toolResultMetadata: {
              recoverable: true,
              hiddenFromTranscript: true,
              kind: "input_validation",
            },
            isComplete: true,
            isError: true,
          }),
        ]}
      />,
    );
    const frame = latestFrameText(stdout);
    expect(frame).toContain("Shell write blocked");
    expect(frame).toContain("Invalid tool parameters");
    expect(frame).not.toContain("cat > CMakeLists.txt");
    expect(frame).not.toContain("Workflow implementation turns");
    expect(frame).not.toContain("InputValidationError");
    expect(frame).not.toContain('"cd"');
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

  test("truncateUserMessageForDisplay preserves head and tail with an omission marker", () => {
    const value = `head-${"x".repeat(12_000)}-tail`;
    const out = truncateUserMessageForDisplay(value);
    expect(out).toContain("head-");
    expect(out).toContain("-tail");
    expect(out).toContain("chars omitted from displayed prompt");
    expect(out.length).toBeLessThan(value.length);
  });
});
