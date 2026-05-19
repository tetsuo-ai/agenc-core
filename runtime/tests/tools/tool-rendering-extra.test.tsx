import { describe, expect, test, vi } from "vitest";

// Same AgenC ink stub as the bash and edit renderer tests.
vi.mock("../tui/ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import {
  createTuiTool,
  FileReadView,
  FileWriteView,
  GlobPathsView,
  GrepMatchesView,
  ToolErrorView,
} from "../tui/tool-rendering.js";

interface ChildProps {
  readonly children?: unknown;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
}

interface ChildElement {
  readonly props: ChildProps;
}

function flatten(node: unknown): ChildElement[] {
  if (!node || typeof node !== "object") return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  const arr = Array.isArray(children) ? children : [children];
  return arr
    .flat(Infinity)
    .filter(
      (child): child is ChildElement =>
        typeof child === "object" && child !== null,
    );
}

describe("createTuiTools — pre-seed canonicalization", () => {
  test("createTuiTools([]) pre-seeds the canonical FileRead name and does NOT contain the legacy wrong 'Read' name", () => {
    const tools = createTuiTool("FileRead");
    expect(tools.name).toBe("FileRead");
  });

  test("FileRead TUI shim exposes read identity and path for permission routing", () => {
    const tool = createTuiTool("FileRead");
    const input = { file_path: "/tmp/agenc-permission-read/notes.txt" };

    expect(tool.userFacingName(input)).toBe("Read");
    expect(tool.isReadOnly(input)).toBe(true);
    expect(tool.getPath(input)).toBe("/tmp/agenc-permission-read/notes.txt");
    expect(tool.renderToolUseMessage(input)).toBe(
      "/tmp/agenc-permission-read/notes.txt",
    );
    expect(tool.getActivityDescription(input)).toBe(
      "Reading /tmp/agenc-permission-read/notes.txt",
    );
  });

  test("the pre-seed list does not include the legacy 'Read' name (canonicalization fix)", async () => {
    const mod = await import("../tui/tool-rendering.js");
    const tools = mod.createTuiTools([]);
    const names = tools.map((t: { name: string }) => t.name).sort();
    expect(names).toContain("FileRead");
    expect(names).not.toContain("Read");
  });

  test("Write tool-use cards summarize long content instead of raw JSON", () => {
    const tool = createTuiTool("Write");
    const content = "x".repeat(50_000);

    expect(
      tool.renderToolUseMessage({ file_path: "game.py", content }),
    ).toBe("game.py (50000 chars)");
    expect(tool.getActivityDescription({ file_path: "game.py", content })).toBe(
      "Write game.py (50000 chars)",
    );
  });

  test("file tool-use cards call out agent namespace paths", () => {
    const write = createTuiTool("Write");
    const read = createTuiTool("FileRead");

    expect(
      write.renderToolUseMessage({ file_path: "/root/game.py", content: "x" }),
    ).toBe("/root/game.py (agent namespace, not a file path) (1 char)");
    expect(read.renderToolUseMessage({ file_path: "/root/game.py" })).toBe(
      "/root/game.py (agent namespace, not a file path)",
    );
  });

  test("Bash tool-use cards show the command rather than JSON input", () => {
    const tool = createTuiTool("Bash");

    expect(tool.renderToolUseMessage({ command: "python game.py" })).toBe(
      "python game.py",
    );
    expect(tool.renderToolUseMessage({ command: "echo hello\nsleep 1" })).toBe(
      "echo hello sleep 1",
    );
  });

  test("exec_command cards show concise command actions instead of raw JSON", () => {
    const tool = createTuiTool("exec_command");

    expect(tool.userFacingName({ cmd: "python3 -m py_compile game.py" })).toBe(
      "Run",
    );
    expect(tool.renderToolUseMessage({ cmd: "python3 -m py_compile game.py" })).toBe(
      "python3 -m py_compile game.py",
    );
    expect(tool.getActivityDescription({ cmd: "mkdir -p .agenc/skills/game" })).toBe(
      "Run: mkdir -p .agenc/skills/game",
    );
  });

  test("system.searchTools cards summarize search and selection requests", () => {
    const tool = createTuiTool("system.searchTools");

    expect(tool.userFacingName({ query: "audit-ping" })).toBe("Tool search");
    expect(tool.renderToolUseMessage({ query: "audit-ping" })).toBe(
      "Search tools: audit-ping",
    );
    expect(
      tool.renderToolUseMessage({ select: ["mcp.audit-ping.ping"] }),
    ).toBe("Select tool: mcp.audit-ping.ping");
  });

  test("Skill cards show $skill invocation instead of raw JSON", () => {
    const tool = createTuiTool("Skill");

    expect(tool.userFacingName({ skill: "python-game" })).toBe("$python-game");
    expect(
      tool.renderToolUseMessage({
        skill: "python-game",
        args: "create a tiny terminal dodge game in game.py",
      }),
    ).toBe("create a tiny terminal dodge game in game.py");
    expect(
      tool.getActivityDescription({
        skill: "python-game",
        args: '{"file":"game.py","type":"dodge"}',
      }),
    ).toBe("Load $python-game: file game.py, type dodge");
  });

  test("Skill cards recover nested JSON-shaped skill input", () => {
    const tool = createTuiTool("Skill");

    expect(
      tool.userFacingName({
        skill: '{"skill":"python-game","args":"{\\"file\\":\\"game.py\\"}"}',
      }),
    ).toBe("$python-game");
    expect(
      tool.renderToolUseMessage({
        skill: '{"skill":"python-game","args":"{\\"file\\":\\"game.py\\"}"}',
      }),
    ).toBe("file game.py");
  });

  test("dynamic MCP cards hide empty JSON input", () => {
    const tool = createTuiTool("mcp.audit-ping.ping");

    expect(tool.userFacingName({})).toBe("mcp.audit-ping.ping");
    expect(tool.renderToolUseMessage({})).toBe("");
    expect(tool.getActivityDescription({})).toBe("mcp.audit-ping.ping");
  });
});

describe("createTuiTool('FileRead').renderToolResultMessage — end-to-end dispatch", () => {
  test("FileRead with <read-content> envelope dispatches to FileReadView", () => {
    const tool = createTuiTool("FileRead");
    const node = tool.renderToolResultMessage(
      "<read-file>src/foo.ts</read-file>\n<read-content>const x = 1;</read-content>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(FileReadView);
  });

  test("'Read' (the wrong pre-seeded name) is not registered in the TUI dispatch table — even with the right envelope it falls through to generic", () => {
    const tool = createTuiTool("Read");
    const node = tool.renderToolResultMessage(
      "<read-content>x</read-content>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(FileReadView);
  });

  test("FileReadView renders bold path header with line range and the body content", () => {
    const node = FileReadView({
      content:
        "<read-file>src/foo.ts</read-file>\n<read-lines>5-10</read-lines>\n<read-content>function hello() {}</read-content>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("src/foo.ts [5-10]");
    const body = children.find(
      (c) =>
        typeof c.props.children === "string" &&
        c.props.children === "function hello() {}",
    );
    expect(body).toBeDefined();
  });

  test("FileReadView shows (empty file) indicator when the read returns no content", () => {
    const node = FileReadView({
      content: "<read-file>x</read-file>\n<read-content></read-content>",
    });
    const children = flatten(node);
    const empty = children.find(
      (c) => c.props.children === "(empty file)" && c.props.dimColor === true,
    );
    expect(empty).toBeDefined();
  });

  test("FileReadView with content but no <read-file> tag (slice-only result) renders the body without a bold header", () => {
    const node = FileReadView({ content: "<read-content>just body</read-content>" });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header).toBeUndefined();
    const body = children.find((c) => c.props.children === "just body");
    expect(body).toBeDefined();
  });

  test("FileRead with the legacy single-string content shape (no envelope tags at all) falls through to the generic Text renderer instead of FileReadView", () => {
    const tool = createTuiTool("FileRead");
    const node = tool.renderToolResultMessage(
      "raw legacy string content",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(FileReadView);
  });

  test("FileReadView truncates a megabyte-scale file body to ~8KB with a [N chars truncated] marker", () => {
    const huge = "x".repeat(50_000);
    const node = FileReadView({
      content: `<read-file>big.txt</read-file>\n<read-content>${huge}</read-content>`,
    });
    const children = flatten(node);
    const body = children.find(
      (c) =>
        typeof c.props.children === "string" &&
        (c.props.children as string).startsWith("x") &&
        (c.props.children as string).includes("chars truncated"),
    );
    expect(body).toBeDefined();
    expect((body!.props.children as string).length).toBeLessThan(10_000);
  });
});

describe("createTuiTool('Write').renderToolResultMessage — end-to-end dispatch", () => {
  test("Write with <write-summary> envelope dispatches to FileWriteView", () => {
    const tool = createTuiTool("Write");
    const node = tool.renderToolResultMessage(
      "<write-file>src/out.ts</write-file>\n<write-summary>Wrote 42 bytes to src/out.ts</write-summary>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(FileWriteView);
  });

  test("FileWriteView renders bold path header and a green summary line", () => {
    const node = FileWriteView({
      content:
        "<write-file>src/out.ts</write-file>\n<write-summary>Wrote 42 bytes</write-summary>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("src/out.ts");
    const summary = children.find((c) => c.props.color === "green");
    expect(summary?.props.children).toBe("Wrote 42 bytes");
  });

  test("Write with the legacy single-string content shape (no envelope) falls through to generic Text instead of FileWriteView", () => {
    const tool = createTuiTool("Write");
    const node = tool.renderToolResultMessage(
      "raw legacy string",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(FileWriteView);
  });

  test("FileWriteView renders the default summary even when path is missing", () => {
    const node = FileWriteView({ content: "" });
    const children = flatten(node);
    const summary = children.find((c) => c.props.color === "green");
    expect(summary?.props.children).toBe("Wrote file");
  });
});

describe("createTuiTool('Grep').renderToolResultMessage — end-to-end dispatch", () => {
  test("Grep with <grep-matches> envelope dispatches to GrepMatchesView", () => {
    const tool = createTuiTool("Grep");
    const node = tool.renderToolResultMessage(
      "<grep-pattern>TODO</grep-pattern>\n<grep-matches>a.ts:1:foo</grep-matches>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(GrepMatchesView);
  });

  test("GrepMatchesView renders the bold pattern header with a match count and one Text child per match", () => {
    const node = GrepMatchesView({
      content:
        "<grep-pattern>TODO</grep-pattern>\n<grep-matches>a.ts:1:foo\nb.ts:2:bar\nc.ts:3:baz</grep-matches>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toContain("Grep: TODO");
    expect(header?.props.children).toContain("3 matches");
    const matchLines = children.filter(
      (c) =>
        typeof c.props.children === "string" &&
        (c.props.children as string).includes(":"),
    );
    expect(matchLines.length).toBeGreaterThanOrEqual(3);
  });

  test("GrepMatchesView renders (no matches) when matches are empty AND preserves the bold pattern header (behavior 3)", () => {
    const node = GrepMatchesView({
      content: "<grep-pattern>X</grep-pattern>\n<grep-matches></grep-matches>",
    });
    const children = flatten(node);
    const header = children.find(
      (c) => c.props.bold === true && c.props.children === "Grep: X",
    );
    expect(header).toBeDefined();
    const noMatches = children.find(
      (c) => c.props.children === "(no matches)" && c.props.dimColor === true,
    );
    expect(noMatches).toBeDefined();
  });

  test("GrepMatchesView with single match renders 'Grep: X (1 match)' (singular), not 'matches'", () => {
    const node = GrepMatchesView({
      content: "<grep-pattern>X</grep-pattern>\n<grep-matches>a.ts:1:hit</grep-matches>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("Grep: X (1 match)");
  });

  test("GrepMatchesView without <grep-pattern> tag renders matches without a header (no header crash)", () => {
    const node = GrepMatchesView({
      content: "<grep-matches>a.ts:1:hit</grep-matches>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header).toBeUndefined();
    const matchLine = children.find(
      (c) => c.props.children === "a.ts:1:hit",
    );
    expect(matchLine).toBeDefined();
  });

  test("GrepMatchesView truncates large match lists to 200 visible + a dim N-more-truncated marker", () => {
    const lines = Array.from({ length: 350 }, (_, i) => `f${i}.ts:1:hit`).join("\n");
    const node = GrepMatchesView({
      content: `<grep-pattern>X</grep-pattern>\n<grep-matches>${lines}</grep-matches>`,
    });
    const children = flatten(node);
    const truncated = children.find(
      (c) =>
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("more matches truncated"),
    );
    expect(truncated).toBeDefined();
  });
});

describe("createTuiTool('Glob').renderToolResultMessage — end-to-end dispatch", () => {
  test("Glob with <glob-paths> envelope dispatches to GlobPathsView", () => {
    const tool = createTuiTool("Glob");
    const node = tool.renderToolResultMessage(
      "<glob-pattern>src/**/*.ts</glob-pattern>\n<glob-paths>src/a.ts\nsrc/b.ts</glob-paths>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(GlobPathsView);
  });

  test("GlobPathsView renders the bold pattern header with a path count and one Text child per path", () => {
    const node = GlobPathsView({
      content:
        "<glob-pattern>src/**/*.ts</glob-pattern>\n<glob-paths>src/a.ts\nsrc/b.ts</glob-paths>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toContain("Glob: src/**/*.ts");
    expect(header?.props.children).toContain("2 paths");
    expect(
      children.find((c) => c.props.children === "src/a.ts"),
    ).toBeDefined();
    expect(
      children.find((c) => c.props.children === "src/b.ts"),
    ).toBeDefined();
  });

  test("GlobPathsView renders (no paths) when no paths matched AND preserves the bold pattern header (behavior 3)", () => {
    const node = GlobPathsView({
      content: "<glob-pattern>X</glob-pattern>\n<glob-paths></glob-paths>",
    });
    const children = flatten(node);
    const header = children.find(
      (c) => c.props.bold === true && c.props.children === "Glob: X",
    );
    expect(header).toBeDefined();
    const noPaths = children.find(
      (c) => c.props.children === "(no paths)" && c.props.dimColor === true,
    );
    expect(noPaths).toBeDefined();
  });

  test("GlobPathsView with single path renders 'Glob: X (1 path)' (singular), not 'paths'", () => {
    const node = GlobPathsView({
      content: "<glob-pattern>X</glob-pattern>\n<glob-paths>only.ts</glob-paths>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("Glob: X (1 path)");
  });

  test("GlobPathsView without <glob-pattern> tag renders the path list without a header (no header crash)", () => {
    const node = GlobPathsView({
      content: "<glob-paths>a.ts\nb.ts</glob-paths>",
    });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header).toBeUndefined();
    expect(
      children.find((c) => c.props.children === "a.ts"),
    ).toBeDefined();
  });

  test("GlobPathsView truncates large path lists to 200 visible + dim N-more-truncated marker", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `p${i}.ts`).join("\n");
    const node = GlobPathsView({
      content: `<glob-pattern>X</glob-pattern>\n<glob-paths>${paths}</glob-paths>`,
    });
    const children = flatten(node);
    const truncated = children.find(
      (c) =>
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("more paths truncated"),
    );
    expect(truncated).toBeDefined();
  });
});

describe("Tool error cross-cutting dispatch", () => {
  test("Any tool with <tool-error> envelope dispatches to ToolErrorView regardless of name", () => {
    const bashErr = createTuiTool("Bash").renderToolResultMessage(
      "<tool-error>permission denied</tool-error>",
      [],
      { verbose: false },
    );
    expect((bashErr as { type: unknown }).type).toBe(ToolErrorView);
    const fileReadErr = createTuiTool("FileRead").renderToolResultMessage(
      "<tool-error-name>FileRead</tool-error-name>\n<tool-error>ENOENT</tool-error>",
      [],
      { verbose: false },
    );
    expect((fileReadErr as { type: unknown }).type).toBe(ToolErrorView);
    const unknownErr = createTuiTool("XYZ").renderToolResultMessage(
      "<tool-error>boom</tool-error>",
      [],
      { verbose: false },
    );
    expect((unknownErr as { type: unknown }).type).toBe(ToolErrorView);
  });

  test("Tool error envelope wins when both per-tool and error envelopes are present (defensive ordering)", () => {
    const node = createTuiTool("Bash").renderToolResultMessage(
      "<bash-stdout>x</bash-stdout><tool-error>but failed</tool-error>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
  });

  test("ToolErrorView renders a red-bold header with the tool name and the error message body", () => {
    const node = ToolErrorView({
      content:
        "<tool-error-name>FileRead</tool-error-name>\n<tool-error>ENOENT: no such file</tool-error>",
    });
    const children = flatten(node);
    const header = children.find(
      (c) => c.props.bold === true && c.props.color === "red",
    );
    expect(header?.props.children).toBe("FileRead error");
    const body = children.find(
      (c) => c.props.children === "ENOENT: no such file",
    );
    expect(body).toBeDefined();
  });

  test("ToolErrorView renders a generic 'Tool error' header when no <tool-error-name> tag is present", () => {
    const node = ToolErrorView({
      content: "<tool-error>nameless failure</tool-error>",
    });
    const children = flatten(node);
    const header = children.find(
      (c) => c.props.bold === true && c.props.color === "red",
    );
    expect(header?.props.children).toBe("Tool error");
  });

  test("createTuiTool exposes renderToolUseErrorMessage that dispatches to ToolErrorView (cross-cutting upstream renderToolUseErrorMessage path)", () => {
    const tool = createTuiTool("XYZ");
    const node = tool.renderToolUseErrorMessage("permission denied");
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
  });

  test("createTuiTool().renderToolUseErrorMessage handles Error instances by extracting .message", () => {
    const tool = createTuiTool("FileRead");
    const node = tool.renderToolUseErrorMessage(new Error("ENOENT"));
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
    const props = (node as { props: { content: string } }).props;
    expect(props.content).toContain("<tool-error>ENOENT</tool-error>");
    expect(props.content).toContain("<tool-error-name>FileRead</tool-error-name>");
  });

  test("createTuiTool().renderToolUseErrorMessage with an arbitrary plain object falls back to short JSON in the <tool-error> body (third branch — neither string nor Error instance)", () => {
    const tool = createTuiTool("Bash");
    const node = tool.renderToolUseErrorMessage({ code: 17, kind: "EEXIST" });
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
    const props = (node as { props: { content: string } }).props;
    expect(props.content).toContain("<tool-error-name>Bash</tool-error-name>");
    expect(props.content).toContain("EEXIST");
    expect(props.content).toContain("17");
  });

  test("createTuiTool().renderToolUseErrorMessage handles null without throwing", () => {
    const tool = createTuiTool("Edit");
    expect(() => tool.renderToolUseErrorMessage(null)).not.toThrow();
    const node = tool.renderToolUseErrorMessage(null);
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
  });

  test("createTuiTool().renderToolUseErrorMessage handles undefined without throwing", () => {
    const tool = createTuiTool("Grep");
    expect(() => tool.renderToolUseErrorMessage(undefined)).not.toThrow();
    const node = tool.renderToolUseErrorMessage(undefined);
    expect((node as { type: unknown }).type).toBe(ToolErrorView);
  });

  test("createTuiTool().renderToolUseErrorMessage cross-cutting: every routed tool name dispatches errors to ToolErrorView (not just FileRead)", () => {
    for (const name of ["Bash", "Edit", "FileRead", "Write", "Grep", "Glob", "XYZUnknown"]) {
      const tool = createTuiTool(name);
      const node = tool.renderToolUseErrorMessage(new Error("boom"));
      expect((node as { type: unknown }).type).toBe(ToolErrorView);
      const props = (node as { props: { content: string } }).props;
      if (name) {
        expect(props.content).toContain(`<tool-error-name>${name}</tool-error-name>`);
      }
    }
  });
});

describe("formatStructuredToolResult ⇄ per-tool view wire-shape lock", () => {
  test("FileRead envelope produced by formatStructuredToolResult is consumed by FileReadView (no shape drift)", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "FileRead",
      "tool_call_completed",
      {
        result: {
          path: "src/foo.ts",
          startLine: 1,
          endLine: 3,
          content: "// hi\nconst x = 1;\nexport { x };",
        },
      },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    expect(joined).toContain("<read-file>src/foo.ts</read-file>");
    expect(joined).toContain("<read-lines>1-3</read-lines>");
    const node = FileReadView({ content: joined });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("src/foo.ts [1-3]");
  });

  test("Write envelope produced by formatStructuredToolResult is consumed by FileWriteView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Write",
      "tool_call_completed",
      { result: { path: "src/out.ts", bytesWritten: 100 } },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    const node = FileWriteView({ content: joined });
    const children = flatten(node);
    const summary = children.find((c) => c.props.color === "green");
    expect(summary?.props.children).toContain("100 bytes");
  });

  test("Grep envelope produced by formatStructuredToolResult is consumed by GrepMatchesView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Grep",
      "tool_call_completed",
      {
        result: {
          pattern: "TODO",
          matches: [{ file: "a.ts", line: 5, content: "// TODO" }],
        },
      },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    const node = GrepMatchesView({ content: joined });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toContain("Grep: TODO");
  });

  test("Glob envelope produced by formatStructuredToolResult is consumed by GlobPathsView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Glob",
      "tool_call_completed",
      { result: { pattern: "*.ts", paths: ["a.ts", "b.ts"] } },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    const node = GlobPathsView({ content: joined });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toContain("Glob: *.ts");
  });

  test("formatStructuredToolError envelope is consumed by ToolErrorView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolError(
      "FileRead",
      "ENOENT: no such file",
    );
    const joined = blocks.map((b) => b.text).join("\n");
    const node = ToolErrorView({ content: joined });
    const children = flatten(node);
    const header = children.find(
      (c) => c.props.bold === true && c.props.color === "red",
    );
    expect(header?.props.children).toBe("FileRead error");
  });
});
