import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { Text } from "../ink.js";
import { createRoot } from "../ink/root.js";
import { CollapsedReadSearchContent } from "./CollapsedReadSearchContent.js";

const collapsedMock = vi.hoisted(() => ({
  featureFlags: new Set<string>(["TEAMMEM"]),
  fullscreen: false,
  selectedBg: undefined as string | undefined,
  teamMemHasOps: false,
}));

vi.mock("bun:bundle", () => ({
  feature: (name: string) => collapsedMock.featureFlags.has(name),
}));

vi.mock("../../utils/fullscreen.js", () => ({
  isFullscreenEnvEnabled: () => collapsedMock.fullscreen,
}));

vi.mock("../../utils/collapseReadSearch.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../utils/collapseReadSearch.js")>();
  return {
    ...actual,
    getToolUseIdsFromCollapsedGroup: (message: { toolUseIds?: string[] }) =>
      message.toolUseIds ?? [],
  };
});

vi.mock("../glyphs.js", () => ({
  selectAgenCTuiGlyphs: () => ({
    ellipsis: "...",
    responseGutter: ">",
    separator: "·",
  }),
}));

vi.mock("../hooks/useMinDisplayTime", () => ({
  useMinDisplayTime: (value: string | undefined) => value,
}));

vi.mock("../components/messageActions", () => ({
  useSelectedMessageBg: () => collapsedMock.selectedBg,
}));

vi.mock("../components/CtrlOToExpand", () => {
  return {
    CtrlOToExpand: () => "[expand]",
  };
});

vi.mock("../components/ToolUseLoader", () => {
  return {
    ToolUseLoader: (props: { isError?: boolean; isUnresolved?: boolean; shouldAnimate?: boolean }) =>
      `LOADER:${props.shouldAnimate ? "anim" : "static"}:${props.isUnresolved ? "pending" : "done"}:${props.isError ? "error" : "ok"}`,
  };
});

vi.mock("../components/PrBadge", () => {
  return {
    PrBadge: ({ number }: { number: number }) => `PR#${number}`,
  };
});

vi.mock("../../tools/Tool", async importOriginal => {
  const actual = await importOriginal<typeof import("../../tools/Tool")>();
  return {
    ...actual,
    findToolByName: (tools: Record<string, unknown> | undefined, name: string) =>
      tools?.[name] ?? null,
  };
});

vi.mock("../../tools/REPLTool/primitiveTools", () => ({
  getReplPrimitiveTools: () => ({}),
}));

vi.mock("./teamMemCollapsed", () => {
  return {
    TeamMemCountParts: ({
      hasPrecedingParts,
      isActiveGroup,
    }: {
      hasPrecedingParts: boolean;
      isActiveGroup: boolean;
    }) => collapsedMock.teamMemHasOps
      ? `${hasPrecedingParts ? ", " : ""}${isActiveGroup ? "syncing" : "synced"} team memory`
      : null,
    checkHasTeamMemOps: () => collapsedMock.teamMemHasOps,
  };
});

function schema<T>(data: T, success = true) {
  return {
    safeParse: () => success ? { data, success: true } : { success: false },
  };
}

function makeTool(options: {
  inputSuccess?: boolean;
  outputSuccess?: boolean;
} = {}) {
  return {
    inputSchema: schema({ path: "src/app.ts" }, options.inputSuccess ?? true),
    outputSchema: schema({ lines: 7 }, options.outputSuccess ?? true),
    renderToolResultMessage: (result: { lines: number }) => <Text>result:{result.lines}</Text>,
    renderToolUseMessage: (input: { path: string }) => `read ${input.path}`,
    renderToolUseTag: (input: { path: string }) => <Text>[tag:{input.path}]</Text>,
    userFacingName: (input: { path: string } | undefined) => input ? "Read file" : "Read",
  };
}

function makeAssistantToolUse(id: string, name = "read_file") {
  return {
    message: {
      content: [
        {
          id,
          input: { path: "src/app.ts" },
          name,
          type: "tool_use",
        },
      ],
    },
    type: "assistant",
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    bashCount: 0,
    gitOpBashCount: 0,
    hookCount: 0,
    listCount: 0,
    mcpCallCount: 0,
    memoryReadCount: 0,
    memorySearchCount: 0,
    memoryWriteCount: 0,
    messages: [],
    readCount: 0,
    readFilePaths: [],
    replCount: 0,
    searchArgs: [],
    searchCount: 0,
    toolUseIds: [] as string[],
    ...overrides,
  };
}

function makeLookups(overrides: Record<string, unknown> = {}) {
  return {
    erroredToolUseIDs: new Set<string>(),
    progressMessagesByToolUseID: new Map<string, any[]>(),
    resolvedToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map<string, any>(),
    ...overrides,
  };
}

async function renderToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

function renderCollapsed(options: {
  inProgress?: string[];
  isActiveGroup?: boolean;
  lookups?: ReturnType<typeof makeLookups>;
  message?: ReturnType<typeof makeMessage>;
  shouldAnimate?: boolean;
  tools?: Record<string, unknown>;
  verbose?: boolean;
} = {}) {
  return renderToText(
    <CollapsedReadSearchContent
      inProgressToolUseIDs={new Set(options.inProgress ?? [])}
      isActiveGroup={options.isActiveGroup}
      lookups={options.lookups ?? makeLookups()}
      message={options.message ?? makeMessage()}
      shouldAnimate={options.shouldAnimate ?? true}
      tools={options.tools ?? {}}
      verbose={options.verbose ?? false}
    />,
  );
}

beforeEach(() => {
  collapsedMock.featureFlags.clear();
  collapsedMock.featureFlags.add("TEAMMEM");
  collapsedMock.fullscreen = false;
  collapsedMock.selectedBg = undefined;
  collapsedMock.teamMemHasOps = false;
});

describe("CollapsedReadSearchContent rendering", () => {
  test("renders nothing for empty non-memory and non-tool groups", async () => {
    const output = await renderCollapsed();

    expect(output.trim()).toBe("");
  });

  test("summarizes active fullscreen operations, hints, hooks, and team memory", async () => {
    collapsedMock.fullscreen = true;
    collapsedMock.teamMemHasOps = true;
    const lookups = makeLookups({
      erroredToolUseIDs: new Set(["bash-1"]),
      progressMessagesByToolUseID: new Map([
        [
          "bash-1",
          [
            {
              data: {
                elapsedTimeSeconds: 3,
                totalLines: 2,
                type: "bash_progress",
              },
            },
          ],
        ],
      ]),
    });

    const output = await renderCollapsed({
      inProgress: ["bash-1"],
      isActiveGroup: true,
      lookups,
      message: makeMessage({
        bashCount: 3,
        branches: [{ action: "rebased", ref: "main" }],
        commits: [
          { kind: "committed", sha: "abc123" },
          { kind: "amended", sha: "def456" },
          { kind: "cherry-picked", sha: "fedcba" },
        ],
        gitOpBashCount: 1,
        hookCount: 2,
        hookTotalMs: 1250,
        latestDisplayHint: "npm test",
        listCount: 2,
        mcpCallCount: 2,
        mcpServerNames: ["agenc.ai docs"],
        memoryReadCount: 1,
        memorySearchCount: 1,
        memoryWriteCount: 2,
        prs: [{ action: "created", number: 42, url: "https://example.invalid/pr/42" }],
        pushes: [{ branch: "feature/a" }, { branch: "feature/a" }],
        readCount: 1,
        replCount: 1,
        searchCount: 2,
        toolUseIds: ["bash-1"],
      }),
    });

    expect(output).toContain("Committed abc123");
    expect(output).toContain("amended commit def456");
    expect(output).toContain("cherry-picked fedcba");
    expect(output).toContain("pushed to feature/a");
    expect(output).toContain("rebased onto main");
    expect(output).toContain("created PR#42");
    expect(output).toContain("searching for 2 patterns");
    expect(output).toContain("reading 1 file");
    expect(output).toContain("listing 2 directories");
    expect(output).toContain("REPL'ing 1 time");
    expect(output).toContain("querying docs 2 times");
    expect(output.replace(/\s+/g, " ")).toContain("running 2 bash commands");
    expect(output).toContain("recalling 1 memory");
    expect(output).toContain("searching memories");
    expect(output).toContain("writing 2 memories");
    expect(output).toContain("syncing team memory");
    expect(output).toContain("npm test (3s · 2 lines)");
    expect(output).toContain("Ran 2 PreToolUse hooks");
    expect(output).toContain("[expand]");
  });

  test("uses fallback read/search hints and finalized past tense", async () => {
    const readOutput = await renderCollapsed({
      message: makeMessage({
        readCount: 2,
        readFilePaths: ["/tmp/first.ts", "/repo/src/final.ts"],
      }),
    });
    expect(readOutput).toContain("Read 2 files");
    expect(readOutput).not.toContain("final.ts");

    const searchOutput = await renderCollapsed({
      isActiveGroup: true,
      message: makeMessage({
        searchArgs: ["needle"],
        searchCount: 1,
      }),
    });
    expect(searchOutput).toContain("Searching for 1 pattern");
    expect(searchOutput).toContain('"needle"');
  });

  test("uses active REPL progress as the displayed hint", async () => {
    const lookups = makeLookups({
      progressMessagesByToolUseID: new Map([
        [
          "repl-1",
          [
            {
              data: {
                phase: "start",
                toolInput: { pattern: "TODO" },
                toolName: "grep",
                type: "repl_tool_call",
              },
            },
          ],
        ],
      ]),
    });

    const output = await renderCollapsed({
      inProgress: ["repl-1"],
      isActiveGroup: true,
      lookups,
      message: makeMessage({
        replCount: 1,
        toolUseIds: ["repl-1"],
      }),
    });

    expect(output).toContain('"TODO"');
  });

  test("renders verbose tool uses, resolved results, hooks, and recalled memories", async () => {
    const lookups = makeLookups({
      resolvedToolUseIDs: new Set(["tool-1"]),
      toolResultByToolUseID: new Map([
        ["tool-1", { toolUseResult: { lines: 7 }, type: "user" }],
      ]),
    });
    const output = await renderCollapsed({
      lookups,
      message: makeMessage({
        hookCount: 1,
        hookInfos: [{ command: "lint", durationMs: 750 }],
        hookTotalMs: 750,
        messages: [
          makeAssistantToolUse("tool-1"),
          {
            messages: [
              makeAssistantToolUse("tool-2", "missing_tool"),
              { message: { content: [{ text: "plain", type: "text" }] }, type: "assistant" },
            ],
            type: "grouped_tool_use",
          },
        ],
        relevantMemories: [{ content: "remembered note", path: "/notes/team.md" }],
      }),
      tools: { read_file: makeTool() },
      verbose: true,
    });

    expect(output).toContain("Read file");
    expect(output).toContain("read src/app.ts");
    expect(output).toContain("[tag:src/app.ts]");
    expect(output).toContain("result:7");
    expect(output).toContain("Ran 1 PreToolUse hook");
    expect(output).toContain("lint");
    expect(output).toContain("Recalled team.md");
    expect(output).toContain("remembered note");
    expect(output).not.toContain("missing_tool");
  });

  test("keeps verbose unresolved and parse-failed tool calls minimal", async () => {
    const output = await renderCollapsed({
      inProgress: ["tool-1"],
      lookups: makeLookups({
        erroredToolUseIDs: new Set(["tool-1"]),
      }),
      message: makeMessage({
        messages: [makeAssistantToolUse("tool-1")],
      }),
      tools: { read_file: makeTool({ inputSuccess: false, outputSuccess: false }) },
      verbose: true,
    });

    expect(output).toContain("Read");
    expect(output).not.toContain("result:");
  });
});
