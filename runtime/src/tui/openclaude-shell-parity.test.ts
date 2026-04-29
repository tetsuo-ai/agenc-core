import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import instances from "./ink/instances.js";
import { createRoot } from "./ink/root.js";
import { ExecCell } from "./transcript/ExecCell.js";

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

    expect(messageList).toMatch(
      /import\s+\{\s*MessageRow\s*\}\s+from\s+["']\.\/MessageRow\.js["']/u,
    );
    expect(messageList).not.toMatch(/function\s+MessageRow\s*\(/u);
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
    };
    expect(statusModule.getActiveNotices).toBeTypeOf("function");

    const notices = statusModule.getActiveNotices?.({
      session: {},
      messages: [],
      configWarnings: ["Invalid config key"],
      projectMemoryWarnings: ["AGENC.md is unreadable"],
      agentDefinitionWarnings: ["Agent definition failed to load"],
    });
    const noticeText = renderedText(notices);

    expect(noticeText).toMatch(/config/i);
    expect(noticeText).toMatch(/AGENC\.md|project memory/i);
    expect(noticeText).toMatch(/agent definition/i);
  });
});
