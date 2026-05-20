import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, test } from "vitest";

import { Box } from "../ink.js";
import { createRoot } from "../ink/root.js";
import { AgentProgressLine } from "./AgentProgressLine.js";

type AgentProgressLineProps = React.ComponentProps<typeof AgentProgressLine>;

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS;
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
  }
});

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 120;
  return { stdin, stdout };
}

async function renderToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

function props(
  overrides: Partial<AgentProgressLineProps> = {},
): AgentProgressLineProps {
  return {
    agentType: "Agent",
    isError: false,
    isLast: false,
    isResolved: false,
    shouldAnimate: false,
    tokens: null,
    toolUseCount: 0,
    ...overrides,
  };
}

describe("AgentProgressLine coverage", () => {
  test("renders active, resolved, and backgrounded progress states", async () => {
    process.env.AGENC_TUI_GLYPHS = "ascii";

    const output = await renderToText(
      <Box flexDirection="column">
        <AgentProgressLine
          {...props({
            agentType: "reviewer",
            description: "plan",
            lastToolInfo: "Reading source",
            toolUseCount: 1,
            tokens: 1500,
          })}
        />
        <AgentProgressLine
          {...props({
            description: "final checks",
            hideType: true,
            isResolved: true,
            name: "Beta",
            toolUseCount: 2,
          })}
        />
        <AgentProgressLine
          {...props({
            description: "background sync",
            hideType: true,
            isAsync: true,
            isLast: true,
            isResolved: true,
            taskDescription: "Indexing repo",
            tokens: 9000,
            toolUseCount: 7,
          })}
        />
      </Box>,
    );

    expect(output).toContain("|- reviewer (plan) · 1 tool use · 1.5k tokens");
    expect(output).toContain("|  |_  Reading source");
    expect(output).toContain("|- Beta: final checks · 2 tool uses");
    expect(output).toContain("|  |_  Done");
    expect(output).toContain("`- background sync");
    expect(output).toContain("   |_  Indexing repo");
    expect(output).not.toContain("7 tool uses");
    expect(output).not.toContain("9.0k tokens");
  });
});
