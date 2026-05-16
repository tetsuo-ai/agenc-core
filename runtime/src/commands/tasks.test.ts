import { describe, expect, it } from "vitest";

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

  it("formats an empty task list with the management hint", () => {
    expect(formatTaskSummary([])).toEqual([
      "Tasks:",
      "  active: none",
      "  spawned agents and long-running shell commands appear here while they run.",
      "  manage: use the footer task pill when it appears; Enter opens details and x stops running tasks.",
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
    expect(output).toContain("running agent a-live - inspect visible task UX");
    expect(output).toContain("completed shell b-old - npm test -- --run src/example.test.ts");
    expect(output).toContain("Enter for details");
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
