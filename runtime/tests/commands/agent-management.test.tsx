import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { agentsCommand } from "./agent-management.js";
import type { SlashCommandContext } from "./types.js";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";
import type { AgentDefinition } from "../tools/AgentTool/loadAgentsDir.js";

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

function testAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: "reviewer",
    source: "projectSettings",
    filename: "reviewer.md",
    whenToUse: "Review implementation changes and summarize concrete risks.",
    tools: ["Read", "Grep"],
    getSystemPrompt: () => "Review the current implementation and report concrete findings.",
    ...overrides,
  } as AgentDefinition;
}

function createStreams(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  return { stdin, stdout };
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("agentsCommand", () => {
  it("falls back to an interactive-only error without the TUI bridge", async () => {
    const result = await agentsCommand.execute(makeCtx());

    expect(result).toEqual({
      kind: "error",
      message: "/agents requires the interactive TUI.",
    });
  });

  it("opens the v2 agents menu when running in the interactive TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await agentsCommand.execute(makeCtx({ setToolJSX }));

    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledOnce();
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });

  it("lets q close the agents surface from the detail view", async () => {
    const setToolJSX = vi.fn();
    const result = await agentsCommand.execute(makeCtx({ setToolJSX }));
    const payload = setToolJSX.mock.calls[0]?.[0] as { jsx?: React.ReactNode };
    const agent = testAgent();
    const initialState = {
      ...getDefaultAppState(),
      agentDefinitions: {
        activeAgents: [agent],
        allAgents: [agent],
      },
    };
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      expect(result).toEqual({ kind: "skip" });
      root.render(
        <AppStateProvider initialState={initialState}>
          {payload.jsx}
        </AppStateProvider>,
      );
      await sleep();

      stdin.write("\r");
      await sleep();
      stdin.write("q");
      await sleep();

      expect(setToolJSX).toHaveBeenLastCalledWith(
        expect.objectContaining({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        }),
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
