import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import instances from "./ink/instances.js";
import { createRoot } from "./ink/root.js";
import { KeybindingProvider } from "./keybindings/KeybindingContext.js";
import { charInCellAt } from "./ink/screen.js";
import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "./state/events-to-messages.js";
import { ExecCell } from "./transcript/ExecCell.js";
import {
  MessageList,
  transcriptMutationKey,
  type TranscriptMessage,
} from "./transcript/MessageList.js";
import { normalizeTranscriptMessages } from "./transcript/normalize.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function sourceIfExists(path: string): string | null {
  const url = new URL(path, import.meta.url);
  if (!existsSync(url)) return null;
  return readFileSync(url, "utf8");
}

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function renderToFrame(element: React.ReactElement): Promise<string> {
  const { stdout, stdin } = createStreams();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 40));
  root.unmount();
  instances.delete(stdout as unknown as NodeJS.WriteStream);
  stdin.end();
  stdout.end();
  return Buffer.concat(chunks).toString("utf8");
}

async function mountForFrames(element: React.ReactElement): Promise<{
  rerender: (next: React.ReactElement) => void;
  frame: () => string;
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return {
    rerender: (next) => root.render(next),
    frame: () => latestFrameText(stdout),
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
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

function renderedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(renderedText).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(renderedText).join("\n");
  }
  return String(value ?? "");
}

describe("OpenClaude shell parity setup gates", () => {
  test("does not retain PromptInput as a partial non-live composer port", () => {
    const promptInput = sourceIfExists("composer/PromptInput.tsx");
    if (promptInput === null) return;

    const liveComposerSources = [
      source("App.tsx"),
      source("screens/REPL.tsx"),
      source("composer/Composer.tsx"),
    ].join("\n");

    expect(liveComposerSources).toMatch(
      /(?:from\s+["']\.\/PromptInput(?:\.js)?["'])|(?:<PromptInput\b)/u,
    );
    expect(promptInput).not.toMatch(
      /parallel composer|parallel, not-live|no-op|fake image paste fallback|History navigation is owned by `Composer\.tsx`|Yank is reducer-owned/u,
    );
  });

  test("MessageList uses the canonical OpenClaude-style message dispatcher", () => {
    const messageList = source("transcript/MessageList.tsx");
    const message = source("transcript/Message.tsx");

    expect(messageList).toMatch(
      /import\s+\{\s*MessageRow\s*\}\s+from\s+["']\.\/MessageRow\.js["']/u,
    );
    expect(messageList).not.toMatch(/function\s+MessageRow\s*\(/u);
    expect(message).toMatch(/from\s+["']\.\/messages\/UserTextMessage\.js["']/u);
    expect(message).toMatch(
      /from\s+["']\.\/messages\/CollapsedReadSearchContent\.js["']/u,
    );
    expect(message).toMatch(
      /from\s+["']\.\/messages\/GroupedToolUseContent\.js["']/u,
    );
    expect(message).toMatch(
      /from\s+["']\.\/messages\/AssistantToolUseMessage\.js["']/u,
    );
  });

  test("retained OpenClaude message ports are live or product-owned", () => {
    const retainedMessagePorts = readdirSync(
      new URL("transcript/messages", import.meta.url),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(retainedMessagePorts).toEqual([
      "AssistantRedactedThinkingMessage.tsx",
      "AssistantTextMessage.tsx",
      "AssistantThinkingMessage.tsx",
      "AssistantToolUseMessage.tsx",
      "AttachmentMessage.tsx",
      "CollapsedReadSearchContent.tsx",
      "CoordinatorAgentStatus.tsx",
      "GroupedToolUseContent.tsx",
      "HighlightedThinkingText.tsx",
      "SystemTextMessage.tsx",
      "UserBashInputMessage.tsx",
      "UserBashOutputMessage.tsx",
      "UserCommandMessage.tsx",
      "UserImageMessage.tsx",
      "UserLocalCommandOutputMessage.tsx",
      "UserMemoryInputMessage.tsx",
      "UserPlanMessage.tsx",
      "UserPromptMessage.tsx",
      "UserResourceUpdateMessage.tsx",
      "UserTextMessage.tsx",
      "UserToolResultMessage.tsx",
      "_helpers.tsx",
    ]);

    const message = source("transcript/Message.tsx");
    const userText = source("transcript/messages/UserTextMessage.tsx");
    const userPrompt = source("transcript/messages/UserPromptMessage.tsx");
    const liveAgentPanel = source("components/LiveAgentStatusPanel.tsx");

    expect(message).toMatch(/AssistantTextMessage/u);
    expect(message).toMatch(/AssistantThinkingMessage/u);
    expect(message).toMatch(/AssistantRedactedThinkingMessage/u);
    expect(message).toMatch(/AssistantToolUseMessage/u);
    expect(message).toMatch(/AttachmentMessage/u);
    expect(message).toMatch(/CollapsedReadSearchContent/u);
    expect(message).toMatch(/GroupedToolUseContent/u);
    expect(message).toMatch(/SystemTextMessage/u);
    expect(message).toMatch(/UserTextMessage/u);
    expect(message).toMatch(/UserImageMessage/u);
    expect(message).toMatch(/UserToolResultMessage/u);
    expect(userText).toMatch(/UserBashInputMessage/u);
    expect(userText).toMatch(/UserBashOutputMessage/u);
    expect(userText).toMatch(/UserCommandMessage/u);
    expect(userText).toMatch(/UserLocalCommandOutputMessage/u);
    expect(userText).toMatch(/UserMemoryInputMessage/u);
    expect(userText).toMatch(/UserPlanMessage/u);
    expect(userText).toMatch(/UserPromptMessage/u);
    expect(userText).toMatch(/UserResourceUpdateMessage/u);
    expect(userPrompt).toMatch(/HighlightedThinkingText/u);
    expect(liveAgentPanel).toMatch(/CoordinatorAgentStatus/u);

    for (const retired of [
      "UserToolResultMessage/UserToolResultMessage.tsx",
      "teamMemCollapsed.tsx",
    ]) {
      expect(sourceIfExists(`transcript/messages/${retired}`)).toBe(null);
    }
  });

  test("normal transcript collapses singleton read/search/list and read-like Bash output", async () => {
    const mkRead = (): TranscriptMessage[] =>
      normalizeTranscriptMessages([
        {
          id: "read-1",
          turnId: "turn-read",
          kind: "tool_call",
          toolName: "FileRead",
          toolArgs: { path: "include/agenc/input.h" },
          content: "FileRead",
          toolResultContent: "#ifndef AGENC_INPUT_H\n#define AGENC_INPUT_H\n",
          timestamp: 1,
          isComplete: true,
        },
      ]);
    const mkCat = (): TranscriptMessage[] =>
      normalizeTranscriptMessages([
        {
          id: "cat-1",
          turnId: "turn-read",
          kind: "tool_call",
          toolName: "exec_command",
          toolArgs: {
            command: "cd /repo && cat include/agenc/input.h",
          },
          content: "#ifndef AGENC_INPUT_H\n#define AGENC_INPUT_H\n",
          toolResultContent:
            "Wall time: 0.1 seconds\nOutput:\n#ifndef AGENC_INPUT_H\n",
          execCommand: "cd /repo && cat include/agenc/input.h",
          execStdout: "#ifndef AGENC_INPUT_H\n#define AGENC_INPUT_H\n",
          execStderr: "",
          execExitCode: 0,
          execDurationMs: 100,
          timestamp: 2,
          isComplete: true,
        },
      ]);

    for (const normalized of [mkRead(), mkCat()]) {
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatchObject({
        kind: "tool_group",
        label: "read-search",
      });
      expect(JSON.stringify(normalized)).toContain("AGENC_INPUT_H");

      const frame = await renderToFrame(
        React.createElement(
          KeybindingProvider,
          null,
          React.createElement(MessageList, { messages: normalized }),
        ),
      );
      expect(frame).toContain("Read");
      expect(frame).not.toContain("AGENC_INPUT_H");
      expect(frame).not.toContain("#ifndef");
    }
  });

  test("Bash exec rendering shows OpenClaude no-output and done affordances", async () => {
    const frame = await renderToFrame(
      React.createElement(ExecCell, {
        command: "true",
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 15,
      }),
    );

    expect(frame).toContain("Bash");
    expect(frame).toContain("(No output)");
    expect(frame).toContain("Done");
  });

  test("Bash result formatter handles cwd reset, sandbox, background, and image output", async () => {
    const execModule = await import("./transcript/ExecCell.js") as unknown as {
      formatBashResultForTranscript?: (input: Record<string, unknown>) => unknown;
    };
    expect(execModule.formatBashResultForTranscript).toBeTypeOf("function");

    const formatted = execModule.formatBashResultForTranscript?.({
      stdout: "<sandbox>internal tag</sandbox>\n",
      stderr: "",
      exitCode: 0,
      cwdWasReset: true,
      backgroundTaskHint: "Use the monitor command for more output.",
      imagePaths: ["/tmp/chart.png"],
    });
    const text = renderedText(formatted);

    expect(text).toContain("Shell cwd was reset");
    expect(text).toMatch(/background|monitor/i);
    expect(text).toMatch(/image|chart\.png/i);
    expect(text).not.toContain("<sandbox>");
  });

  test("Bash result affordances survive event reduction and canonical rendering", async () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-shell-live-path" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "exec-live",
          toolName: "system.bash",
          args: '{"command":"true"}',
        },
      },
      {
        type: "exec_command_begin",
        payload: {
          callId: "exec-live",
          processId: 42,
          command: "true",
          cwd: "/repo",
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-live",
          processId: 42,
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 15,
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "exec-live",
          result: "",
          isError: false,
          metadata: {
            command: "true",
            stdout: "",
            stderr: "<sandbox>internal tag</sandbox>",
            exitCode: 0,
            durationMs: 15,
            cwdWasReset: true,
            backgroundTaskHint: "Use the monitor command for more output.",
            imagePaths: ["/tmp/chart.png"],
            noOutputExpected: true,
            returnCodeInterpretation: "Done",
            backgroundTaskId: "bg-42",
            truncated: true,
          },
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages[0]).toMatchObject({
      execCwdWasReset: true,
      execBackgroundTaskHint: "Use the monitor command for more output.",
      execImagePaths: ["/tmp/chart.png"],
      execNoOutputExpected: true,
      execReturnCodeInterpretation: "Done",
      execBackgroundTaskId: "bg-42",
      execTruncated: true,
    });

    const frame = await renderToFrame(
      React.createElement(
        KeybindingProvider,
        null,
        React.createElement(MessageList, { messages }),
      ),
    );

    expect(frame).toContain("Bash");
    expect(frame).toContain("Shell");
    expect(frame).toContain("cwd");
    expect(frame).toContain("reset");
    expect(frame).toMatch(/background|monitor/i);
    expect(frame).toMatch(/image|chart\.png/i);
    expect(frame).toContain("Output");
    expect(frame).toContain("truncated");
    expect(frame).not.toContain("<sandbox>");
  });

  test("grouped Bash affordances survive reducer, grouping, mutation tracking, and rendering", async () => {
    const makeEvents = (secondStdout: string): TranscriptSourceEvent[] => [
      { type: "turn_started", payload: { turnId: "turn-shell-group" } },
      {
        type: "exec_command_begin",
        payload: {
          callId: "exec-one",
          processId: 10,
          command: "printf one",
          cwd: "/repo",
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-one",
          processId: 10,
          exitCode: 0,
          stdout: "one\n",
          stderr: "",
          durationMs: 11,
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "exec-one",
          result: "one\n",
          isError: false,
          metadata: {
            command: "printf one",
            stdout: "one\n",
            stderr: "",
            exitCode: 0,
            durationMs: 11,
            cwdWasReset: true,
            backgroundTaskHint: "Use the monitor command for more output.",
            imagePaths: ["/tmp/one.png"],
            noOutputExpected: false,
            returnCodeInterpretation: "Done",
            backgroundTaskId: "bg-one",
            timedOut: false,
            truncated: true,
          },
        },
      },
      {
        type: "exec_command_begin",
        payload: {
          callId: "exec-two",
          processId: 11,
          command: "printf two",
          cwd: "/repo",
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-two",
          processId: 11,
          exitCode: 0,
          stdout: secondStdout,
          stderr: "",
          durationMs: 12,
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "exec-two",
          result: secondStdout,
          isError: false,
          metadata: {
            command: "printf two",
            stdout: secondStdout,
            stderr: "",
            exitCode: 0,
            durationMs: 12,
            cwdWasReset: true,
            backgroundTaskHint: "Use the monitor command for more output.",
            imagePaths: ["/tmp/two.png"],
            noOutputExpected: false,
            returnCodeInterpretation: "Done",
            backgroundTaskId: "bg-two",
            timedOut: false,
            truncated: true,
          },
        },
      },
    ];

    const messages = eventsToMessages(makeEvents("two\n"));
    const normalized = normalizeTranscriptMessages(messages);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      kind: "tool_group",
      groupedTools: [
        {
          execCommand: "printf one",
          execCwdWasReset: true,
          execBackgroundTaskHint: "Use the monitor command for more output.",
          execImagePaths: ["/tmp/one.png"],
          execBackgroundTaskId: "bg-one",
          execTruncated: true,
        },
        {
          execCommand: "printf two",
          execCwdWasReset: true,
          execBackgroundTaskHint: "Use the monitor command for more output.",
          execImagePaths: ["/tmp/two.png"],
          execBackgroundTaskId: "bg-two",
          execTruncated: true,
        },
      ],
    });
    const mutated = normalizeTranscriptMessages(
      eventsToMessages(makeEvents("TWO\n")),
    );
    expect(transcriptMutationKey(normalized)).not.toBe(
      transcriptMutationKey(mutated),
    );

    const frame = await renderToFrame(
      React.createElement(
        KeybindingProvider,
        null,
        React.createElement(MessageList, { messages }),
      ),
    );

    expect(frame).toContain("printf");
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("Shell");
    expect(frame).toContain("reset");
    expect(frame).toMatch(/background|monitor/i);
    expect(frame).toMatch(/one\.png|two\.png/i);
    expect(frame).toContain("Output");
    expect(frame).toContain("truncated");

    const mounted = await mountForFrames(
      React.createElement(
        KeybindingProvider,
        null,
        React.createElement(MessageList, { messages }),
      ),
    );
    try {
      mounted.rerender(
        React.createElement(
          KeybindingProvider,
          null,
          React.createElement(MessageList, {
            messages: eventsToMessages(makeEvents("TWO\n")),
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mounted.frame()).toContain("TWO");
    } finally {
      mounted.unmount();
    }
  });

  test("ApprovalOverlay resolves preview bodies through the per-tool permission registry", async () => {
    const approvalModule = await import("./permissions/ApprovalOverlay.js") as unknown as {
      approvalBodyComponentForTool?: (toolName: string) => unknown;
    };
    const permissionModule = await import("./permissions/PermissionRequest.js");

    expect(approvalModule.approvalBodyComponentForTool).toBeTypeOf("function");
    expect(approvalModule.approvalBodyComponentForTool?.("Bash")).toBe(
      permissionModule.permissionComponentForTool("Bash"),
    );
    expect(approvalModule.approvalBodyComponentForTool?.("Edit")).toBe(
      permissionModule.permissionComponentForTool("Edit"),
    );
  });

  test("OpenClaude-shaped keybinding parser, resolver, schema, and validation are behavioral modules", async () => {
    const parser = await import("./keybindings/parser.js") as unknown as {
      parseChord: (input: string) => readonly unknown[];
      chordToDisplayString: (chord: readonly unknown[]) => string;
    };
    const resolver = await import("./keybindings/resolver.js") as unknown as {
      resolveKey: (...args: unknown[]) => { type: string; action?: string };
    };
    const schema = await import("./keybindings/schema.js") as unknown as {
      KEYBINDING_CONTEXTS: readonly string[];
      KEYBINDING_ACTIONS: readonly string[];
    };
    const validate = await import("./keybindings/validate.js") as unknown as {
      validateUserConfig: (config: unknown) => readonly { type: string }[];
    };
    const reserved = await import("./keybindings/reservedShortcuts.js") as unknown as {
      getReservedShortcuts: () => readonly { key: string }[];
    };

    const chord = parser.parseChord("ctrl+k ctrl+s");
    expect(chord).toHaveLength(2);
    expect(parser.chordToDisplayString(chord)).toContain("Ctrl");
    expect(schema.KEYBINDING_CONTEXTS).toContain("Chat");
    expect(schema.KEYBINDING_ACTIONS).toContain("chat:submit");
    expect(
      validate
        .validateUserConfig([{ context: "Invalid", bindings: { "ctrl+x": "chat:submit" } }])
        .some((warning) => warning.type === "invalid_context"),
    ).toBe(true);
    expect(reserved.getReservedShortcuts().some((entry) => entry.key === "ctrl+c")).toBe(true);
    expect(
      resolver.resolveKey("x", { ctrl: false }, ["Chat"], []).type,
    ).toBe("none");
  });

  test("resume selector exposes a bounded visible-session window helper", async () => {
    const resumeModule = await import("./screens/ResumeConversation.js") as unknown as {
      getVisibleResumeSessions?: (
        sessions: readonly { sessionId: string }[],
        selectedIndex: number,
        maxRows: number,
      ) => readonly { sessionId: string }[] | { visibleSessions: readonly { sessionId: string }[] };
    };
    expect(resumeModule.getVisibleResumeSessions).toBeTypeOf("function");

    const sessions = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `conv-${index}`,
    }));
    const result = resumeModule.getVisibleResumeSessions?.(sessions, 17, 7);
    const visibleSessions = Array.isArray(result) ? result : result?.visibleSessions;

    expect(visibleSessions).toBeDefined();
    expect(visibleSessions!.length).toBeLessThanOrEqual(7);
    expect(visibleSessions!.map((session) => session.sessionId)).toContain("conv-17");
  });

  test("status notices expose an OpenClaude-style active notice resolver", async () => {
    const statusModule = await import("./cockpit/StatusNotices.js") as unknown as {
      getActiveNotices?: (input: Record<string, unknown>) => readonly { id?: string; text?: string }[];
      readRuntimeStatusNoticeWarnings?: (
        input: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(statusModule.getActiveNotices).toBeTypeOf("function");
    expect(statusModule.readRuntimeStatusNoticeWarnings).toBeTypeOf("function");

    const runtimeWarnings = statusModule.readRuntimeStatusNoticeWarnings?.({
      projectMemoryWarnings: ["AGENC.md include dropped: missing.md (not_found)"],
      agentDefinitions: {
        activeAgents: [{ notAgentType: true }],
      },
    });

    const notices = statusModule.getActiveNotices?.({
      session: {},
      messages: [],
      configWarnings: ["Invalid config key"],
      ...runtimeWarnings,
    });
    const noticeText = renderedText(notices);

    expect(noticeText).toMatch(/config/i);
    expect(noticeText).toMatch(/AGENC\.md|project memory/i);
    expect(noticeText).toMatch(/agent definition.*malformed/i);
  });
});
