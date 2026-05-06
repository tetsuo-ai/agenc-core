import { describe, expect, test } from "vitest";
import type { ResponseItem } from "../../session/rollout-item.js";
import {
  buildCurrentThreadSection,
  buildRealtimeStartupContext,
  buildRealtimeStartupContextFromSession,
  truncateRealtimeTextToTokenBudget,
  type RealtimeRecentThread,
  type RealtimeWorkspaceEntry,
} from "./context.js";

function msg(role: ResponseItem["role"], content: ResponseItem["content"]): ResponseItem {
  return { role, content };
}

describe("realtime startup context", () => {
  test("groups recent current-thread turns and omits contextual user fragments", () => {
    const section = buildCurrentThreadSection([
      msg("user", "<environment_context>\nignored\n</environment_context>"),
      msg("user", "first ask"),
      msg("assistant", "first answer"),
      msg("user", "second ask"),
      msg("assistant", [{ type: "output_text", text: "second answer" }]),
    ]);

    expect(section).toContain("### Latest turn");
    expect(section).toContain("User:\nsecond ask");
    expect(section).toContain("Assistant:\nsecond answer");
    expect(section).toContain("### Previous turn 1");
    expect(section).toContain("first ask");
    expect(section).not.toContain("ignored");
  });

  test("omits imported instruction, hook, shell, skill, and multipart fragments", () => {
    const importedInstructions =
      // branding-scan: allow live imported instruction marker
      "# AGENTS.md instructions for /repo\n" +
      "<INSTRUCTIONS>\nsecret instructions\n</INSTRUCTIONS>";
    const section = buildCurrentThreadSection([
      msg("user", importedInstructions),
      msg("user", "<EnViRoNmEnT_CoNtExT>\nsecret env\n</eNvIrOnMeNt_CoNtExT>"),
      msg("user", "<skill>\nsecret skill\n</skill>"),
      msg("user", "<user_shell_command>\nsecret shell\n</user_shell_command>"),
      msg("user", "<session-start-hook>\nsecret session hook\n</session-start-hook>"),
      msg(
        "user",
        "<user-prompt-submit-hook>\nsecret prompt hook\n</user-prompt-submit-hook>",
      ),
      msg("user", "<ide_opened_file>\nsecret editor\n</ide_opened_file>"),
      msg("user", [
        { type: "input_text", text: "<skill>\nsecret multipart\n</skill>" },
      ]),
      msg("user", [{ type: "tool_result", text: "secret tool result" }]),
      msg("user", "real ask"),
      msg("assistant", "real answer"),
    ]);

    expect(section).toContain("real ask");
    expect(section).toContain("real answer");
    expect(section).not.toContain("secret instructions");
    expect(section).not.toContain("secret env");
    expect(section).not.toContain("secret skill");
    expect(section).not.toContain("secret shell");
    expect(section).not.toContain("secret session hook");
    expect(section).not.toContain("secret prompt hook");
    expect(section).not.toContain("secret editor");
    expect(section).not.toContain("secret multipart");
    expect(section).not.toContain("secret tool result");
  });

  test("truncates rendered turns to the requested budget", () => {
    const text = truncateRealtimeTextToTokenBudget("x".repeat(200), 10);

    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.endsWith("...")).toBe(true);
  });

  test("builds current thread, recent work, and workspace map in deterministic order", async () => {
    const recentThreads: RealtimeRecentThread[] = [
      {
        cwd: "/repo-b",
        updatedAt: "2026-05-02T00:00:00.000Z",
        firstUserMessage: "older work",
      },
      {
        cwd: "/repo-a/sub",
        updatedAt: "2026-05-03T00:00:00.000Z",
        firstUserMessage: "current work",
        gitBranch: "main",
      },
      {
        cwd: "/repo-a/sub",
        updatedAt: "2026-05-04T00:00:00.000Z",
        firstUserMessage: "current   work",
        gitBranch: "main",
      },
    ];
    const dirs = new Map<string, RealtimeWorkspaceEntry[]>([
      [
        "/repo-a/sub",
        [
          { name: "z-file.ts", type: "file" },
          { name: "src", type: "directory" },
          { name: ".git", type: "directory" },
        ],
      ],
      [
        "/repo-a/sub/src",
        [
          { name: "b.ts", type: "file" },
          { name: "a.ts", type: "file" },
        ],
      ],
      ["/repo-a", [{ name: "root.ts", type: "file" }]],
      ["/home/me", [{ name: "notes", type: "directory", readable: false }]],
    ]);

    const context = await buildRealtimeStartupContext({
      cwd: "/repo-a/sub",
      history: [msg("user", "hello"), msg("assistant", "hi")],
      recentThreads,
      userRoot: "/home/me",
      resolveWorkspaceRoot: (cwd) => cwd.startsWith("/repo-a") ? "/repo-a" : cwd,
      readDirectory: (path) => dirs.get(path) ?? null,
    });

    expect(context).toContain("<startup_context>");
    expect(context).toContain("## Current Thread");
    expect(context).toContain("User:\nhello");
    expect(context).toContain("## Recent Work");
    expect(context).toContain("### Current workspace: /repo-a");
    expect(context).toContain("Latest branch: main");
    expect(context).toContain("- /repo-a/sub: current work");
    expect(context).toContain("### Workspace: /repo-b");
    expect(context).toContain("## Machine / Workspace Map");
    expect(context).toContain("- src/");
    expect(context).toContain("  - a.ts");
    expect(context).toContain("  - b.ts");
    expect(context).toContain("- z-file.ts");
    expect(context).not.toContain(".git");
    expect(context).toContain("User root tree:");
    expect(context).toContain("- notes/");
  });

  test("keeps newest recent work before applying the thread cap", async () => {
    const oldThreads: RealtimeRecentThread[] = Array.from({ length: 45 }, (_, index) => ({
      cwd: `/repo-old-${index}`,
      updatedAt: `2026-04-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
      firstUserMessage: `old work ${index}`,
    }));
    const context = await buildRealtimeStartupContext({
      cwd: "/repo",
      history: [msg("user", "hello")],
      recentThreads: [
        ...oldThreads,
        {
          cwd: "/repo-new",
          updatedAt: "2026-05-04T00:00:00.000Z",
          firstUserMessage: "newest work beyond input cap",
        },
      ],
      userRoot: null,
      readDirectory: () => null,
    });

    expect(context).toContain("newest work beyond input cap");
  });

  test("deduplicates matching asks across cwd values in the same workspace", async () => {
    const context = await buildRealtimeStartupContext({
      cwd: "/repo/app",
      history: [msg("user", "hello")],
      recentThreads: [
        {
          cwd: "/repo/app",
          updatedAt: "2026-05-04T00:00:00.000Z",
          firstUserMessage: "same ask",
        },
        {
          cwd: "/repo/packages/a",
          updatedAt: "2026-05-03T00:00:00.000Z",
          firstUserMessage: "same   ask",
        },
      ],
      userRoot: null,
      resolveWorkspaceRoot: (cwd) => cwd.startsWith("/repo") ? "/repo" : cwd,
      readDirectory: () => null,
    });

    expect(context?.match(/same ask/g)).toHaveLength(1);
  });

  test("does not descend into symlink entries and caps large directories", async () => {
    const entries: RealtimeWorkspaceEntry[] = [
      { name: "aaa-linked", type: "symlink" },
      ...Array.from({ length: 25 }, (_, index) => ({
        name: `file-${String(index).padStart(2, "0")}.ts`,
        type: "file" as const,
      })),
    ];
    const context = await buildRealtimeStartupContext({
      cwd: "/repo",
      history: [msg("user", "voice context")],
      userRoot: null,
      readDirectory: (path) => path === "/repo" ? entries : null,
    });

    expect(context).toContain("- aaa-linked@");
    expect(context).toContain("- file-18.ts");
    expect(context).not.toContain("- file-19.ts");
    expect(context).toContain("more entries");
  });

  test("preserves startup wrapper tags under a tiny final budget", async () => {
    const context = await buildRealtimeStartupContext({
      cwd: "/repo",
      history: [msg("user", "voice context".repeat(20))],
      userRoot: null,
      budgetTokens: 1,
      readDirectory: () => null,
    });

    expect(context).not.toBeNull();
    expect(context?.startsWith("<startup_context>")).toBe(true);
    expect(context?.endsWith("</startup_context>")).toBe(true);
  });

  test("preserves startup wrapper tags when aggregate sections are truncated", async () => {
    const entries: RealtimeWorkspaceEntry[] = Array.from({ length: 40 }, (_, index) => ({
      name: `entry-${String(index).padStart(2, "0")}.ts`,
      type: "file" as const,
    }));
    const context = await buildRealtimeStartupContext({
      cwd: "/repo",
      history: [
        msg("user", "current thread ".repeat(1_000)),
        msg("assistant", "current answer ".repeat(1_000)),
      ],
      recentThreads: Array.from({ length: 20 }, (_, index) => ({
        cwd: `/repo-${index}`,
        updatedAt: `2026-05-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
        firstUserMessage: "recent work ".repeat(50),
      })),
      userRoot: "/home/me",
      budgetTokens: 80,
      readDirectory: () => entries,
    });

    expect(context).not.toBeNull();
    expect(context?.startsWith("<startup_context>")).toBe(true);
    expect(context?.endsWith("</startup_context>")).toBe(true);
  });

  test("returns null when every section is empty", async () => {
    const context = await buildRealtimeStartupContext({
      cwd: "/empty",
      history: [],
      recentThreads: [],
      userRoot: null,
      readDirectory: () => null,
    });

    expect(context).toBeNull();
  });

  test("accepts a live-session-like history source", async () => {
    const context = await buildRealtimeStartupContextFromSession(
      {
        conversationId: "session-1",
        config: { cwd: "/repo" },
        snapshotHistoryMessages: () => [
          msg("user", "session ask"),
          msg("assistant", "session answer"),
        ],
      },
      {
        userRoot: null,
        readDirectory: () => null,
      },
    );

    expect(context).toContain("session ask");
    expect(context).toContain("session answer");
  });

  test("accepts direct and session-configuration cwd sources", async () => {
    const direct = await buildRealtimeStartupContextFromSession(
      {
        conversationId: "session-direct",
        cwd: "/repo-direct",
        snapshotHistoryMessages: () => [msg("user", "direct ask")],
      },
      {
        userRoot: null,
        readDirectory: () => null,
      },
    );
    const sessionConfiguration = await buildRealtimeStartupContextFromSession(
      {
        conversationId: "session-config",
        sessionConfiguration: { cwd: "/repo-session-config" },
        snapshotHistoryMessages: () => [msg("user", "configuration ask")],
      },
      {
        userRoot: null,
        readDirectory: () => null,
      },
    );

    expect(direct).toContain("direct ask");
    expect(sessionConfiguration).toContain("configuration ask");
  });
});
