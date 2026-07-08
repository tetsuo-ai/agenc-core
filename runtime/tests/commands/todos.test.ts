import { describe, expect, it } from "vitest";

import { todosCommand } from "./todos.js";
import { getSessionId } from "../bootstrap/state.js";
import type { SlashCommandContext } from "./types.js";

function makeCtx(
  appState?: SlashCommandContext["appState"],
): SlashCommandContext {
  return {
    session: { services: {} } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    appState,
  };
}

describe("todosCommand", () => {
  it("exposes the /todo alias on both TUI surfaces", () => {
    expect(todosCommand.aliases).toEqual(["todo"]);
    expect(todosCommand.supportedSurfaces).toEqual(["runtime", "daemon-tui"]);
    expect(todosCommand.immediate).toBe(true);
  });

  it("reports missing todo state without the TUI bridge", async () => {
    const result = await todosCommand.execute(makeCtx());

    expect(result).toEqual({
      kind: "text",
      text: "Todo state is not available in this session.",
    });
  });

  it("renders a friendly empty state when no todos were recorded", async () => {
    const result = await todosCommand.execute(
      makeCtx({ getAppState: () => ({ todos: {} }) }),
    );

    expect(result).toEqual({
      kind: "text",
      text: "No todos recorded this session.",
    });
  });

  it("renders the root list first with status marks and a count summary", async () => {
    const rootKey = getSessionId();
    const result = await todosCommand.execute(
      makeCtx({
        getAppState: () => ({
          todos: {
            "agent-shard-2": [
              { content: "Scan the fixtures", status: "pending", activeForm: "Scanning the fixtures" },
            ],
            [rootKey]: [
              { content: "Explore the runtime", status: "completed", activeForm: "Exploring the runtime" },
              { content: "Wire the menu", status: "in_progress", activeForm: "Wiring the menu" },
              { content: "Write tests", status: "pending", activeForm: "Writing tests" },
            ],
          },
        }),
      }),
    );

    expect(result.kind).toBe("text");
    const text = (result as { kind: "text"; text: string }).text;
    expect(text).toContain("4 todos · 1 in progress · 1 completed");
    expect(text).toContain("✓ Explore the runtime");
    expect(text).toContain("◆ Wire the menu");
    expect(text).toContain("◇ Write tests");
    expect(text).toContain("◇ Scan the fixtures");
    // Root agent's list renders before the subagent list.
    expect(text.indexOf("Current session:")).toBeGreaterThan(-1);
    expect(text.indexOf("Current session:")).toBeLessThan(
      text.indexOf("Agent agent-shard-2:"),
    );
  });

  it("skips malformed todo entries instead of crashing", async () => {
    const result = await todosCommand.execute(
      makeCtx({
        getAppState: () => ({
          todos: {
            "agent-1": [{ content: 42, status: "pending" }, "garbage", null],
          },
        }),
      }),
    );

    expect(result).toEqual({
      kind: "text",
      text: "No todos recorded this session.",
    });
  });
});
