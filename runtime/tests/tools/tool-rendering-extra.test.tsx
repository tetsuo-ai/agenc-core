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

import { ResultLine } from "../tui/components/v2/primitives.js";
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

/**
 * The transcript form of a result: one `└` ResultLine. Asserts the element is
 * a ResultLine and returns its text and failed flag.
 */
function resultLine(node: unknown): { readonly text: unknown; readonly failed?: boolean } {
  const element = node as {
    readonly type: unknown;
    readonly props: { readonly children?: unknown; readonly failed?: boolean };
  };
  expect(element.type).toBe(ResultLine);
  return { text: element.props.children, failed: element.props.failed };
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

  test("Write tool-use cards show the file path only (size lives in the result)", () => {
    const tool = createTuiTool("Write");
    const content = "x".repeat(50_000);

    expect(
      tool.renderToolUseMessage({ file_path: "game.py", content }),
    ).toBe("game.py");
    expect(tool.getActivityDescription({ file_path: "game.py", content })).toBe(
      "Write game.py",
    );
  });

  test("file tool-use cards show /root paths as filesystem paths", () => {
    const write = createTuiTool("Write");
    const read = createTuiTool("FileRead");

    expect(
      write.renderToolUseMessage({ file_path: "/root/game.py", content: "x" }),
    ).toBe("/root/game.py");
    expect(read.renderToolUseMessage({ file_path: "/root/game.py" })).toBe(
      "/root/game.py",
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

  test("FileReadView renders an 'N lines' result line using the line range", () => {
    // Capped preview: a single "└ N lines" line derived from <read-lines>. The
    // step row already says "Read", so the count carries no verb.
    const node = FileReadView({
      content:
        "<read-file>src/foo.ts</read-file>\n<read-lines>5-10</read-lines>\n<read-content>function hello() {}</read-content>",
    });
    expect(resultLine(node).text).toBe("6 lines");
  });

  test("FileReadView falls back to counting body lines when no range is present", () => {
    const body = Array.from({ length: 3 }, (_, i) => `line ${i + 1}`).join("\n");
    const node = FileReadView({
      content: `<read-file>x</read-file>\n<read-content>${body}</read-content>`,
    });
    expect(resultLine(node).text).toBe("3 lines");
  });

  test("FileReadView shows an 'empty file' result line when the read returns no content", () => {
    const node = FileReadView({
      content: "<read-file>x</read-file>\n<read-content></read-content>",
    });
    expect(resultLine(node).text).toBe("empty file");
  });

  test("FileReadView with content but no <read-file> tag still summarizes line count", () => {
    const node = FileReadView({
      content: "<read-content>just body</read-content>",
    });
    // Single-line body -> singular "line".
    expect(resultLine(node).text).toBe("1 line");
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

  test("FileReadView summarizes a megabyte-scale file body as a single line count (no body dump)", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `x${i}`).join("\n");
    const node = FileReadView({
      content: `<read-file>big.txt</read-file>\n<read-content>${huge}</read-content>`,
    });
    expect(resultLine(node).text).toBe("5000 lines");
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

  test("FileWriteView renders a single green summary line (no separate header)", () => {
    const node = FileWriteView({
      content:
        "<write-file>src/out.ts</write-file>\n<write-summary>Wrote 42 bytes</write-summary>",
    }) as { props: ChildProps };
    expect(node.props.children).toBe("Wrote 42 bytes");
    expect(node.props.color).toBe("green");
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
    const node = FileWriteView({ content: "" }) as { props: ChildProps };
    expect(node.props.children).toBe("Wrote file");
    expect(node.props.color).toBe("green");
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

  test("GrepMatchesView renders an 'N matches' result line (no per-match dump)", () => {
    const node = GrepMatchesView({
      content:
        "<grep-pattern>TODO</grep-pattern>\n<grep-matches>a.ts:1:foo\nb.ts:2:bar\nc.ts:3:baz</grep-matches>",
    });
    expect(resultLine(node).text).toBe("3 matches");
  });

  test("GrepMatchesView renders 'no matches' when the match block is empty", () => {
    const node = GrepMatchesView({
      content: "<grep-pattern>X</grep-pattern>\n<grep-matches></grep-matches>",
    });
    expect(resultLine(node).text).toBe("no matches");
  });

  test("GrepMatchesView with a single match uses the singular '1 match'", () => {
    const node = GrepMatchesView({
      content: "<grep-pattern>X</grep-pattern>\n<grep-matches>a.ts:1:hit</grep-matches>",
    });
    expect(resultLine(node).text).toBe("1 match");
  });

  test("GrepMatchesView counts matches even without a <grep-pattern> tag", () => {
    const node = GrepMatchesView({
      content: "<grep-matches>a.ts:1:hit\nb.ts:2:hit</grep-matches>",
    });
    expect(resultLine(node).text).toBe("2 matches");
  });

  test("GrepMatchesView counts large match lists exactly (no 200-cap truncation in the summary)", () => {
    const lines = Array.from({ length: 350 }, (_, i) => `f${i}.ts:1:hit`).join("\n");
    const node = GrepMatchesView({
      content: `<grep-pattern>X</grep-pattern>\n<grep-matches>${lines}</grep-matches>`,
    });
    expect(resultLine(node).text).toBe("350 matches");
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

  test("GlobPathsView renders a path count line, and verbose renders the bold pattern header with one Text child per path", () => {
    const content =
      "<glob-pattern>src/**/*.ts</glob-pattern>\n<glob-paths>src/a.ts\nsrc/b.ts</glob-paths>";
    // Transcript form: one "└ N paths" result line.
    expect(resultLine(GlobPathsView({ content })).text).toBe("2 paths");
    // Verbose (ctrl+o) keeps the full list under a Glob header.
    const node = GlobPathsView({ content, verbose: true });
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

  test("GlobPathsView renders 'no paths' when no paths matched, and verbose preserves the bold pattern header (behavior 3)", () => {
    const content = "<glob-pattern>X</glob-pattern>\n<glob-paths></glob-paths>";
    expect(resultLine(GlobPathsView({ content })).text).toBe("no paths");
    const node = GlobPathsView({ content, verbose: true });
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

  test("GlobPathsView with single path renders '1 path' and a verbose 'Glob: X (1 path)' header (singular), not 'paths'", () => {
    const content = "<glob-pattern>X</glob-pattern>\n<glob-paths>only.ts</glob-paths>";
    expect(resultLine(GlobPathsView({ content })).text).toBe("1 path");
    const node = GlobPathsView({ content, verbose: true });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("Glob: X (1 path)");
  });

  test("GlobPathsView without <glob-pattern> tag renders the path list without a header (no header crash)", () => {
    const content = "<glob-paths>a.ts\nb.ts</glob-paths>";
    expect(resultLine(GlobPathsView({ content })).text).toBe("2 paths");
    const node = GlobPathsView({ content, verbose: true });
    const children = flatten(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header).toBeUndefined();
    expect(
      children.find((c) => c.props.children === "a.ts"),
    ).toBeDefined();
  });

  test("GlobPathsView counts every path, and verbose truncates large path lists to 200 visible + dim N-more-truncated marker", () => {
    const paths = Array.from({ length: 250 }, (_, i) => `p${i}.ts`).join("\n");
    const content = `<glob-pattern>X</glob-pattern>\n<glob-paths>${paths}</glob-paths>`;
    // The count covers all 250 paths (no "+": the result itself was complete).
    expect(resultLine(GlobPathsView({ content })).text).toBe("250 paths");
    const node = GlobPathsView({ content, verbose: true });
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

  test("ToolErrorView renders one failed result line with the error message (the step row names the tool)", () => {
    const node = ToolErrorView({
      content:
        "<tool-error-name>FileRead</tool-error-name>\n<tool-error>ENOENT: no such file</tool-error>",
    });
    const line = resultLine(node);
    expect(line.failed).toBe(true);
    expect(line.text).toBe("ENOENT: no such file");
    // No separate "<Tool> error" header row.
    expect(String(line.text)).not.toContain("FileRead error");
  });

  test("ToolErrorView renders the message alone when no <tool-error-name> tag is present", () => {
    const node = ToolErrorView({
      content: "<tool-error>nameless failure</tool-error>",
    });
    const line = resultLine(node);
    expect(line.failed).toBe(true);
    expect(line.text).toBe("nameless failure");
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
    // <read-lines>1-3</read-lines> -> "3 lines".
    expect(resultLine(FileReadView({ content: joined })).text).toBe("3 lines");
  });

  test("Write envelope produced by formatStructuredToolResult is consumed by FileWriteView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Write",
      "tool_call_completed",
      { result: { path: "src/out.ts", bytesWritten: 100 } },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    const node = FileWriteView({ content: joined }) as { props: ChildProps };
    expect(node.props.color).toBe("green");
    expect(node.props.children).toContain("100 bytes");
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
    // One match -> "1 match".
    expect(resultLine(GrepMatchesView({ content: joined })).text).toBe("1 match");
  });

  test("Glob envelope produced by formatStructuredToolResult is consumed by GlobPathsView", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Glob",
      "tool_call_completed",
      { result: { pattern: "*.ts", paths: ["a.ts", "b.ts"] } },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    expect(resultLine(GlobPathsView({ content: joined })).text).toBe("2 paths");
    const node = GlobPathsView({ content: joined, verbose: true });
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
    const line = resultLine(ToolErrorView({ content: joined }));
    expect(line.failed).toBe(true);
    expect(line.text).toBe("ENOENT: no such file");
  });
});
