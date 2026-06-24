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

/** Recursive depth-first find for an element matching `pred` anywhere in the
 * subtree — used for bodies nested several Box levels deep (e.g. the gutter row
 * layout that wraps the silent "(No output)" line). */
function findDeep(
  node: unknown,
  pred: (el: ChildElement) => boolean,
): ChildElement | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findDeep(item, pred);
      if (hit) return hit;
    }
    return undefined;
  }
  const el = node as ChildElement;
  if (el.props && pred(el)) return el;
  return findDeep(el.props?.children, pred);
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

  test("Write args are the file path only (no char-count noise)", () => {
    const tool = createTuiTool("Write");

    // Readable args = path only; the byte/size detail lives in the result
    // preview, not stuffed into the call-row args.
    expect(tool.renderToolUseMessage({ file_path: "notes.md" })).toBe(
      "notes.md",
    );
    expect(tool.renderToolUseMessage({ content: "x" })).toBe("file");
    expect(tool.renderToolUseMessage({})).toBe("file");
  });

  test("Edit args are the file path only (stats live in the result preview)", () => {
    const tool = createTuiTool("Edit");

    expect(
      tool.renderToolUseMessage({
        file_path: "src/a.ts",
        old_string: "x",
        new_string: "yz",
      }),
    ).toBe("src/a.ts");
    expect(
      tool.renderToolUseMessage({ old_string: "old", new_string: "newer" }),
    ).toBe("edit");
  });

  test("Grep args render as \"pattern\" in path (no raw JSON, no flags)", () => {
    const tool = createTuiTool("Grep");

    expect(
      tool.renderToolUseMessage({
        pattern: "IO_NUMBER",
        path: "src/syntax/lexer.c",
        "-A": 3,
      }),
    ).toBe('"IO_NUMBER" in src/syntax/lexer.c');
    expect(tool.renderToolUseMessage({ pattern: "needle" })).toBe('"needle"');
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

  test("BUG 3: TodoWrite header is a readable count + active item, NOT raw {\"todos\"} JSON", () => {
    const tool = createTuiTool("TodoWrite");
    const summary = tool.renderToolUseMessage({
      todos: [
        { content: "Creating package __init__.py", activeForm: "Creating package __init__.py", status: "completed" },
        { content: "Wire the config validator", activeForm: "Wiring the config validator", status: "in_progress" },
        { content: "Add tests", activeForm: "Adding tests", status: "pending" },
      ],
    });

    // Human-readable: the total count + the in-progress item's name.
    expect(summary).toContain("3 todos");
    expect(summary).toContain("Wire the config validator");
    // None of the garbled raw-JSON / truncation artifacts from the old generic
    // branch (`{"todos":[{"activeForm":…__.py","status":"completed"},{…).`).
    expect(summary).not.toContain('{"todos"');
    expect(summary).not.toContain('"activeForm"');
    expect(summary).not.toContain('"status"');
    expect(summary).not.toMatch(/\.\)\.$/);
    expect(summary).not.toContain("...");
  });

  test("BUG 3: TodoWrite header falls back to the first item when none is in progress, and pluralizes", () => {
    const tool = createTuiTool("TodoWrite");
    // Singular.
    expect(
      tool.renderToolUseMessage({ todos: [{ content: "Lone task", status: "pending" }] }),
    ).toBe("1 todo · Lone task");
    // No in-progress item → highlight the first todo.
    expect(
      tool.renderToolUseMessage({
        todos: [
          { content: "First", status: "pending" },
          { content: "Second", status: "completed" },
        ],
      }),
    ).toBe("2 todos · First");
    // Empty list → just the count, no trailing separator.
    expect(tool.renderToolUseMessage({ todos: [] })).toBe("0 todos");
  });

  test("EditDiffView renders a capped (+a -r) stat line plus green/red changes", () => {
    const children = flatten(
      EditDiffView({
        content: "<edit-diff>@@ -1 +1 @@\n-old\n+new</edit-diff>",
      }),
    );

    // No bold header, no cyan hunk lines — the @@ markers are dropped from the
    // capped preview. The stat line is dim; one '-' (red) + one '+' (green).
    expect(children.find((child) => child.props.bold === true)).toBeUndefined();
    expect(children.find((child) => child.props.color === "cyan")).toBeUndefined();
    expect(
      children.find(
        (child) => child.props.dimColor === true && child.props.children === "(+1 -1)",
      ),
    ).toBeDefined();
    expect(children.find((child) => child.props.color === "red")).toBeDefined();
    expect(children.find((child) => child.props.color === "green")).toBeDefined();
  });

  test("BashOutputView marks silent (zero-exit) output as (No output)", () => {
    // Capped preview: silent success collapses to a single dim "(No output)"
    // line; the raw [duration_ms=...] metadata block is no longer surfaced.
    // The line now nests behind the `⎿` continuation gutter (matching the
    // non-empty branch), so the dim "(No output)" <Text> lives a couple Box
    // levels deep rather than as the root node's direct child.
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout>[duration_ms=42]",
    });

    const noOutput = findDeep(
      node,
      (el) => el.props.children === "(No output)",
    );
    expect(noOutput).toBeDefined();
    expect(noOutput!.props.dimColor).toBe(true);
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
    // FileReadView: an unterminated <read-content> yields no body, so the
    // capped preview falls back to a single dim "(empty file)" Text.
    const readNode = FileReadView({
      content: "<read-file>x.ts</read-file><read-content>unterminated",
    }) as { readonly props: ChildProps };
    expect(readNode.props.children).toBe("(empty file)");
    expect(readNode.props.dimColor).toBe(true);

    // FileWriteView: empty envelope still surfaces the green default summary.
    const writeNode = FileWriteView({ content: "" }) as {
      readonly props: ChildProps;
    };
    expect(writeNode.props.children).toBe("Wrote file");
    expect(writeNode.props.color).toBe("green");

    // GrepMatchesView: empty match block collapses to a dim "No matches".
    const grepNode = GrepMatchesView({
      content: "<grep-matches></grep-matches>",
    }) as { readonly props: ChildProps };
    expect(grepNode.props.children).toBe("No matches");
    expect(grepNode.props.dimColor).toBe(true);

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
