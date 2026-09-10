import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import { agentsCommand } from "../../../src/commands/agent-management.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";
import type { AgentDefinition } from "../../../src/tools/AgentTool/loadAgentsDir.js";
import { Box, Text, createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt, type Screen } from "../../../src/tui/ink/screen.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { useContentWidth } from "../../../src/tui/context/contentWidthContext.js";
import { MessageRow } from "../../../src/tui/components/MessageRow.js";
import { VirtualMessageList } from "../../../src/tui/components/VirtualMessageList.js";
import { buildMessageLookups, createUserMessage, normalizeMessages } from "../../../src/utils/messages.js";
import { WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected terminal frame did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createTerminal(columns = 160, rows = 48) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: true });
  stdout.resume();
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream);
  if (!instance) throw new Error("Expected live Ink instance");
  const frameOwner = instance as unknown as { frontFrame: { screen: Screen }; rootNode: DOMElement };
  instance.setAltScreenActive(true);
  return {
    root,
    stdin,
    node: frameOwner.rootNode,
    screenRows: () => {
      const screen = frameOwner.frontFrame.screen;
      return Array.from({ length: screen.height }, (_, row) =>
        Array.from({ length: screen.width }, (_, column) =>
          cellAt(screen, column, row)?.char ?? " ",
        ).join(""),
      );
    },
    resize: async (nextColumns: number) => {
      stdout.columns = nextColumns;
      stdout.emit("resize");
      await waitFor(() => frameOwner.frontFrame.screen.width === nextColumns);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    close: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

const prompt = "START " + Array.from({ length: 32 }, (_, index) => `word${index.toString().padStart(2, "0")}`).join(" ") + " END";
const rawMessages = Array.from({ length: 60 }, (_, index) =>
  createUserMessage({ content: index === 59 ? prompt : `history-${index}`, timestamp: "", uuid: `message-${index}` }),
);
const messages = normalizeMessages(rawMessages);
const lookups = buildMessageLookups(messages, rawMessages);

function TranscriptRows({ scrollRef }: { readonly scrollRef: React.RefObject<ScrollBoxHandle | null> }) {
  const columns = useContentWidth();
  if (columns === null) throw new Error("Expected workbench content width");
  return <VirtualMessageList
    messages={messages}
    scrollRef={scrollRef}
    columns={columns}
    itemKey={(message) => message.uuid}
    renderItem={(message) => <MessageRow
      message={message}
      columns={columns}
      lookups={lookups}
      tools={[]}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      streamingToolUseIDs={new Set()}
      screen="prompt"
      canAnimate={false}
      lastThinkingBlockId={null}
      latestBashOutputUUID={null}
      isLoading={false}
      isUserContinuation={false}
      hasContentAfter={false}
    />}
  />;
}

function promptGeometry(node: DOMElement): unknown[] | null {
  if (node.childNodes.some((child) => child.nodeName === "#text" && child.nodeValue.includes("START"))) {
    return [{ name: node.nodeName, style: node.style, width: node.yogaNode?.getComputedWidth() }];
  }
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = promptGeometry(child);
    if (found) return [{ name: node.nodeName, style: node.style, width: node.yogaNode?.getComputedWidth() }, ...found];
  }
  return null;
}

describe("persistent workbench terminal cells", () => {
  test("wraps every prompt character inside both sidebars through resize and virtual scrolling", async () => {
    const terminal = await createTerminal();
    const scrollRef = React.createRef<ScrollBoxHandle>();
    try {
      terminal.root.render(<AppStateProvider initialState={getDefaultAppState()}>
        <WorkbenchLayout transcript={<TranscriptRows scrollRef={scrollRef} />} composer={<Text>composer-marker</Text>} scrollRef={scrollRef} />
      </AppStateProvider>);
      await waitFor(() => terminal.screenRows().some((row) => row.includes("START")));
      for (const columns of [160, 200, 160]) {
        await terminal.resize(columns);
        scrollRef.current?.scrollTo(0);
        await waitFor(() => terminal.screenRows().some((row) => row.includes("history-0")));
        scrollRef.current?.scrollToBottom();
        await waitFor(() => terminal.screenRows().some((row) => row.includes("START")));
        const rows = terminal.screenRows();
        expect(rows.some((row) => row.includes("WORKSPACE")), rows.join("\n")).toBe(true);
        expect(rows.some((row) => row.includes("AGENTS"))).toBe(true);
        const startRow = rows.findIndex((row) => row.includes("START"));
        const endRow = rows.findIndex((row, index) => index >= startRow && row.includes("END"));
        expect(endRow).toBeGreaterThanOrEqual(startRow);
        const contentColumn = rows[startRow]!.indexOf("START");
        const frameColumns = columns - 4;
        const rightEdge = 2 + frameColumns - Math.max(24, Math.floor(frameColumns * 0.19)) - 3;
        const visiblePrompt = rows.slice(startRow, endRow + 1).map((row) => row.slice(contentColumn, rightEdge).trim()).join(" ");
        expect(visiblePrompt, JSON.stringify(promptGeometry(terminal.node))).toBe(prompt);
      }
    } finally {
      await terminal.close();
    }
  });

  test("keeps every agents row and detail on distinct cells through 160 to 200 to 160 resizing", async () => {
    const terminal = await createTerminal();
    const agents = ["default", "runner", "reviewer", "Plan", "scanner"].map((agentType): AgentDefinition => ({
      agentType,
      source: "built-in",
      baseDir: "built-in",
      whenToUse: "Review code and report findings.",
      tools: ["Read", "Grep"],
      getSystemPrompt: () => "Review code and report concrete findings in the current checkout.",
    }));
    const setToolJSX = vi.fn();
    await agentsCommand.execute({
      session: { services: {} } as SlashCommandContext["session"],
      argsRaw: "",
      cwd: "/tmp/project",
      home: "/tmp",
      appState: { setToolJSX },
    });
    const modal = setToolJSX.mock.calls[0]?.[0].jsx as React.ReactNode;
    try {
      terminal.root.render(<AppStateProvider initialState={{ ...getDefaultAppState(), agentDefinitions: { activeAgents: agents, allAgents: agents } }}>
        <WorkbenchLayout transcript={<Text>transcript-marker</Text>} composer={<Text>composer-marker</Text>} modal={modal} />
      </AppStateProvider>);
      await waitFor(() => terminal.screenRows().some((row) => row.includes("delegate-capable")));
      for (const columns of [160, 200, 160]) {
        await terminal.resize(columns);
        const rows = terminal.screenRows();
        const markers = ["name · Role", "default", "runner", "reviewer", "Plan", "scanner", "when-to-use", "tools", "model", "budget"];
        const tableStart = rows.findIndex((row) => row.includes("name · Role"));
        const positions = markers.map((marker) => rows.findIndex((row, index) => index >= tableStart && new RegExp(`\\b${marker}\\b`, "u").test(row)));
        expect(positions.every((position) => position >= 0), rows.join("\n")).toBe(true);
        expect(new Set(positions).size, rows.join("\n")).toBe(markers.length);
        expect(rows.some((row) => row.includes("Review code and report findings."))).toBe(true);
        expect(rows.some((row) => row.includes("2 tools · skills"))).toBe(true);
      }
    } finally {
      await terminal.close();
    }
  });

  test("removes maximum dimensions while preserving explicit zero and percentage limits", async () => {
    const terminal = await createTerminal(80, 30);
    let target: DOMElement | null = null;
    const render = (maxWidth: number | `${number}%` | undefined, maxHeight: number | `${number}%` | undefined) => terminal.root.render(
      <Box width={60} height={20}>
        <Box ref={(node) => { target = node; }} width={40} height={10} maxWidth={maxWidth} maxHeight={maxHeight} flexShrink={0}>
          <Text>dimension-marker</Text>
        </Box>
      </Box>,
    );
    try {
      for (const [maximumWidth, maximumHeight, width, height] of [
        [undefined, undefined, 40, 10],
        [0, 0, 0, 0],
        [undefined, undefined, 40, 10],
        [12, 3, 12, 3],
        ["50%", "25%", 30, 5],
        [undefined, undefined, 40, 10],
      ] as const) {
        render(maximumWidth, maximumHeight);
        await waitFor(() => target?.yogaNode?.getComputedWidth() === width && target.yogaNode.getComputedHeight() === height);
        expect(target?.yogaNode?.getComputedWidth()).toBe(width);
        expect(target?.yogaNode?.getComputedHeight()).toBe(height);
      }
    } finally {
      await terminal.close();
    }
  });
});
