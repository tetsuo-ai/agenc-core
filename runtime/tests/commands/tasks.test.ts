import { describe, expect, it, vi } from "vitest";

import {
  collectTaskSummaryRows,
  formatTaskSummary,
  tasksCommand,
} from "./tasks.js";
import type { SlashCommandContext, SlashCommandResult } from "./types.js";

function contextWithAppState(appState?: unknown): SlashCommandContext {
  return {
    session: {
      conversationId: "session-1",
      services: {},
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    ...(appState !== undefined
      ? {
          appState: {
            getAppState: () => appState,
          },
        }
      : {}),
  };
}

function text(result: SlashCommandResult): string {
  expect(result.kind).toBe("text");
  return result.kind === "text" ? result.text : "";
}

describe("/tasks", () => {
  it("reports when live task state is unavailable", async () => {
    const result = await tasksCommand.execute(contextWithAppState());

    expect(text(result)).toContain("live task state is only available");
  });

  it("opens the v2 background task panel when running in the interactive TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await tasksCommand.execute({
      ...contextWithAppState(),
      appState: { setToolJSX },
    });

    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });

  it("formats an empty task list with the management hint", () => {
    expect(formatTaskSummary([])).toEqual([
      "Tasks:",
      "  active: none",
      "  agents and long-running shell commands appear here while they run.",
      "  manage: Down selects the task pill; Enter opens details.",
      "          x stops a running task.",
    ].join("\n"));
  });

  it("collects and sorts live spawned agents ahead of terminal tasks", async () => {
    const appState = {
      tasks: {
        oldShell: {
          id: "b-old",
          type: "local_bash",
          status: "completed",
          command: "npm test -- --run src/example.test.ts",
          description: "completed shell",
          startTime: 100,
          outputFile: "urn:agenc:task:b-old:output",
          outputOffset: 0,
          notified: true,
        },
        liveAgent: {
          id: "a-live",
          type: "local_agent",
          status: "running",
          prompt: "inspect visible task UX\nand report issues",
          description: "agent",
          startTime: 200,
          outputFile: "urn:agenc:task:a-live:output",
          outputOffset: 0,
          notified: false,
          progress: {
            toolUseCount: 2,
            tokenCount: 1240,
            lastActivity: {
              activityDescription: "reading runtime/src/tui/components/tasks",
            },
          },
        },
      },
    };

    const rows = collectTaskSummaryRows(appState);
    expect(rows.map((row) => row.id)).toEqual(["a-live", "b-old"]);
    expect(rows[0]).toMatchObject({
      type: "local_agent",
      status: "running",
      title: "inspect visible task UX",
      detail: "2 tools, 1,240 tokens, reading runtime/src/tui/components/tasks",
    });

    const output = text(await tasksCommand.execute(contextWithAppState(appState)));
    expect(output).toContain("active: 1");
    expect(output).toContain("running agent inspect visible task UX (a-live)");
    expect(output).toContain("completed shell npm test -- --run src/example.test.ts (b-old)");
    expect(output).toContain("Enter opens details");
    expect(output.split("\n").every((line) => line.length <= 76)).toBe(true);
  });

  it("keeps long task rows within the summary card width", () => {
    const output = formatTaskSummary([
      {
        id: "01234567-89ab-cdef-0123-456789abcdef",
        type: "local_agent",
        status: "completed",
        title:
          "Review the Python terminal game created in this directory and report every issue",
        detail:
          "12 tools, 999,999 tokens, reading a very long path that should not force the card to wrap awkwardly",
        startTime: 1,
      },
    ]);

    expect(output).toContain("completed agent Review the Python terminal game");
    expect(output).toContain("(01234567...)");
    expect(output.split("\n").every((line) => line.length <= 76)).toBe(true);
  });

  it("ignores non-task objects in app state", () => {
    expect(
      collectTaskSummaryRows({
        tasks: {
          bad: { id: "bad", type: "unknown", status: "running" },
          alsoBad: null,
        },
      }),
    ).toEqual([]);
  });
});
