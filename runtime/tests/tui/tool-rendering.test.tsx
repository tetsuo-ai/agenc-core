import { describe, expect, test, vi } from "vitest";

vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import {
  BashOutputView,
  createTuiTool,
  createTuiTools,
  EditDiffView,
  FileReadView,
  FileWriteView,
  GlobPathsView,
  GrepMatchesView,
  ToolErrorView,
} from "./tool-rendering.js";

interface ChildProps {
  readonly bold?: boolean;
  readonly children?: unknown;
  readonly color?: string;
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

describe("TUI tool rendering helpers", () => {
  test("createTuiTools merges canonical tools with nonblank dynamic names, dedupes, and sorts", () => {
    const tools = createTuiTools([
      "Bash",
      "mcp.audit-ping.ping",
      "",
      "  ",
      "ZedTool",
    ]);
    const names = tools.map((tool: { readonly name: string }) => tool.name);

    expect(names).toEqual([...names].sort());
    expect(names).toContain("Bash");
    expect(names).toContain("FileRead");
    expect(names).toContain("mcp.audit-ping.ping");
    expect(names).toContain("ZedTool");
    expect(names).not.toContain("");
    expect(names.filter((name) => name === "Bash")).toHaveLength(1);
  });

  test("Write summaries cover path-only, content-only, and empty inputs", () => {
    const tool = createTuiTool("Write");

    expect(tool.renderToolUseMessage({ file_path: "notes.md" })).toBe(
      "notes.md",
    );
    expect(tool.renderToolUseMessage({ content: "x" })).toBe(
      "file content (1 char)",
    );
    expect(tool.renderToolUseMessage({})).toBe("file");
  });

  test("Edit summaries include size changes with and without a path", () => {
    const tool = createTuiTool("Edit");

    expect(
      tool.renderToolUseMessage({
        file_path: "src/a.ts",
        old_string: "x",
        new_string: "yz",
      }),
    ).toBe("src/a.ts (1 char -> 2 chars)");
    expect(
      tool.renderToolUseMessage({ old_string: "old", new_string: "newer" }),
    ).toBe("edit (3 chars -> 5 chars)");
  });

  test("search and MCP tool summaries cover multi-select and populated dynamic inputs", () => {
    const search = createTuiTool("system.searchTools");
    const mcp = createTuiTool("mcp.audit-ping.ping");

    expect(search.renderToolUseMessage({ select: ["Read", "Write"] })).toBe(
      "Select tools: Read, Write",
    );
    expect(search.renderToolUseMessage({})).toBe("Search tools");
    expect(mcp.renderToolUseMessage({ path: "src/a.ts", limit: 2 })).toBe(
      "path: src/a.ts, limit: 2",
    );
    expect(mcp.getActivityDescription({ path: "src/a.ts" })).toBe(
      "mcp.audit-ping.ping path: src/a.ts",
    );
  });

  test("generic tool summaries hide bulky string fields while preserving useful context", () => {
    const tool = createTuiTool("CustomTool");
    const summary = tool.renderToolUseMessage({
      content: "secret",
      old_string: "abc",
      new_string: "defg",
      reason: "needs\nspacing",
      count: 2,
    });

    expect(summary).toContain('"content":"[6 chars]"');
    expect(summary).toContain('"old_string":"[3 chars]"');
    expect(summary).toContain('"new_string":"[4 chars]"');
    expect(summary).toContain('"reason":"needs spacing"');
    expect(summary).toContain('"count":2');
    expect(summary).not.toContain("secret");
    expect(tool.renderToolUseMessage("raw")).toBe('{"value":"raw"}');
  });

  test("EditDiffView renders an unheaded diff when the file tag is absent", () => {
    const children = flatten(
      EditDiffView({
        content: "<edit-diff>@@ -1 +1 @@\n-old\n+new</edit-diff>",
      }),
    );

    expect(children.find((child) => child.props.bold === true)).toBeUndefined();
    expect(children.find((child) => child.props.color === "cyan")).toBeDefined();
    expect(children.find((child) => child.props.color === "red")).toBeDefined();
    expect(children.find((child) => child.props.color === "green")).toBeDefined();
  });

  test("BashOutputView dims duration-only metadata and still marks silent output", () => {
    const children = flatten(
      BashOutputView({
        content: "<bash-stdout></bash-stdout>[duration_ms=42]",
      }),
    );

    expect(
      children.find(
        (child) =>
          child.props.children === "(No output)" &&
          child.props.dimColor === true,
      ),
    ).toBeDefined();
    expect(
      children.find(
        (child) =>
          child.props.children === "[duration_ms=42]" &&
          child.props.dimColor === true &&
          child.props.color === undefined,
      ),
    ).toBeDefined();
  });

  test("ToolErrorView falls back to raw content when no error envelope exists", () => {
    const children = flatten(ToolErrorView({ content: "raw failure" }));

    expect(
      children.find(
        (child) =>
          child.props.children === "Tool error" &&
          child.props.bold === true &&
          child.props.color === "red",
      ),
    ).toBeDefined();
    expect(
      children.find((child) => child.props.children === "raw failure"),
    ).toBeDefined();
  });

  test("file, grep, and glob views keep visible fallbacks for missing content", () => {
    const readChildren = flatten(
      FileReadView({
        content: "<read-file>x.ts</read-file><read-content>unterminated",
      }),
    );
    expect(
      readChildren.find(
        (child) =>
          child.props.children === "(empty file)" &&
          child.props.dimColor === true,
      ),
    ).toBeDefined();

    const writeChildren = flatten(FileWriteView({ content: "" }));
    expect(
      writeChildren.find(
        (child) =>
          child.props.children === "Wrote file" &&
          child.props.color === "green",
      ),
    ).toBeDefined();

    const grepChildren = flatten(
      GrepMatchesView({ content: "<grep-matches></grep-matches>" }),
    );
    expect(grepChildren.find((child) => child.props.bold === true)).toBeUndefined();
    expect(
      grepChildren.find(
        (child) =>
          child.props.children === "(no matches)" &&
          child.props.dimColor === true,
      ),
    ).toBeDefined();

    const globChildren = flatten(
      GlobPathsView({
        content:
          "<glob-paths></glob-paths><glob-truncated>true</glob-truncated>",
      }),
    );
    expect(globChildren.find((child) => child.props.bold === true)).toBeUndefined();
    expect(
      globChildren.find(
        (child) =>
          child.props.children === "(no paths)" &&
          child.props.dimColor === true,
      ),
    ).toBeDefined();
    expect(
      globChildren.find(
        (child) =>
          child.props.children ===
            "(Results are truncated. Consider using a more specific path or pattern.)" &&
          child.props.dimColor === true,
      ),
    ).toBeDefined();
  });
});
