import { describe, expect, test, vi } from "vitest";

// Mirror of the AgenC ink stub used by the bash renderer test.
vi.mock("../tui/ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import { createTuiTool, EditDiffView } from "../tui/tool-rendering.js";

interface ChildProps {
  readonly children?: unknown;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
}

interface ChildElement {
  readonly props: ChildProps;
}

function flattenChildren(node: unknown): ChildElement[] {
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

describe("createTuiTool('Edit').renderToolResultMessage — end-to-end dispatch", () => {
  test("Edit tool with <edit-diff> envelope produces a React element whose type is EditDiffView", () => {
    const tool = createTuiTool("Edit");
    const node = tool.renderToolResultMessage(
      "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a\n+new</edit-diff>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(EditDiffView);
  });

  test("Edit tool with structured-content-blocks array (the shape formatStructuredToolResult emits) is collapsed and dispatches to EditDiffView", () => {
    const tool = createTuiTool("Edit");
    const blocks = [
      { type: "text", text: "<edit-file>src/foo.ts</edit-file>" },
      { type: "text", text: "<edit-diff>--- a\n+++ b\n@@ ... @@\n-old\n+new</edit-diff>" },
    ];
    const node = tool.renderToolResultMessage(blocks, [], { verbose: false });
    expect((node as { type: unknown }).type).toBe(EditDiffView);
    const props = (node as { props: { content: string } }).props;
    expect(props.content).toContain("<edit-file>src/foo.ts</edit-file>");
    expect(props.content).toContain("<edit-diff>");
  });

  test("Edit tool with no <edit-diff> envelope (e.g. error-path payload) falls through to generic", () => {
    const tool = createTuiTool("Edit");
    const node = tool.renderToolResultMessage(
      "permission denied",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(EditDiffView);
  });

  test("Edit dispatch is exact-case — 'edit' does NOT route to EditDiffView", () => {
    const tool = createTuiTool("edit");
    const node = tool.renderToolResultMessage(
      "<edit-diff>diff</edit-diff>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(EditDiffView);
  });

  test("Edit with null content falls through to generic — does not throw on tag extraction", () => {
    const tool = createTuiTool("Edit");
    const node = tool.renderToolResultMessage(null, [], { verbose: false });
    expect((node as { type: unknown }).type).not.toBe(EditDiffView);
  });
});

describe("EditDiffView — local renderer fidelity to upstream visual contract", () => {
  test("renders the file path as a bold header and colors '+' lines green, '-' lines red, '@@' hunk headers cyan", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a\n+++ b\n@@ -1,3 +1,3 @@\n-old line\n+new line</edit-diff>",
    });
    const children = flattenChildren(node);
    const header = children.find((c) => c.props.bold === true);
    expect(header?.props.children).toBe("src/foo.ts");
    const greenLine = children.find(
      (c) =>
        c.props.color === "green" &&
        typeof c.props.children === "string" &&
        c.props.children.startsWith("+new"),
    );
    expect(greenLine).toBeDefined();
    const redLine = children.find(
      (c) =>
        c.props.color === "red" &&
        typeof c.props.children === "string" &&
        c.props.children.startsWith("-old"),
    );
    expect(redLine).toBeDefined();
    const hunkLine = children.find((c) => c.props.color === "cyan");
    expect(typeof hunkLine?.props.children).toBe("string");
    expect((hunkLine?.props.children as string).startsWith("@@")).toBe(true);
  });

  test("dims '+++' / '---' header lines (these are file-path metadata, not edits)", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y</edit-diff>",
    });
    const children = flattenChildren(node);
    const dimMinus = children.find(
      (c) =>
        c.props.dimColor === true &&
        typeof c.props.children === "string" &&
        (c.props.children as string).startsWith("---"),
    );
    expect(dimMinus).toBeDefined();
    const dimPlus = children.find(
      (c) =>
        c.props.dimColor === true &&
        typeof c.props.children === "string" &&
        (c.props.children as string).startsWith("+++"),
    );
    expect(dimPlus).toBeDefined();
  });

  test("new-file diff (only '+' lines) renders all additions in green without crashing on missing '---' header", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/new.ts</edit-file>\n<edit-diff>+line one\n+line two\n+line three</edit-diff>",
    });
    const children = flattenChildren(node);
    const greens = children.filter((c) => c.props.color === "green");
    expect(greens.length).toBe(3);
  });

  test("file-deletion diff (only '-' lines) renders all deletions in red", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/old.ts</edit-file>\n<edit-diff>-line one\n-line two</edit-diff>",
    });
    const children = flattenChildren(node);
    const reds = children.filter((c) => c.props.color === "red");
    expect(reds.length).toBe(2);
  });

  test("multi-hunk diff renders all hunks (no truncation to first hunk only)", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/foo.ts</edit-file>\n<edit-diff>@@ -1 +1 @@\n-a\n+A\n@@ -10 +10 @@\n-z\n+Z</edit-diff>",
    });
    const children = flattenChildren(node);
    const hunkHeaders = children.filter(
      (c) =>
        c.props.color === "cyan" &&
        typeof c.props.children === "string" &&
        (c.props.children as string).startsWith("@@"),
    );
    expect(hunkHeaders.length).toBe(2);
  });

  test("empty diff body falls back to (No changes) indicator instead of an empty box", () => {
    const node = EditDiffView({
      content: "<edit-file>src/foo.ts</edit-file>\n<edit-diff></edit-diff>",
    });
    const children = flattenChildren(node);
    const noChanges = children.find(
      (c) => c.props.children === "(No changes)" && c.props.dimColor === true,
    );
    expect(noChanges).toBeDefined();
  });

  test("malformed payload (no envelope tags at all) falls back to (No changes) — does not throw on missing tags", () => {
    const node = EditDiffView({ content: "raw text with no tags" });
    const children = flattenChildren(node);
    const noChanges = children.find((c) => c.props.children === "(No changes)");
    expect(noChanges).toBeDefined();
  });
});

describe("formatStructuredToolResult ⇄ EditDiffView wire-shape lock", () => {
  test("the tags formatStructuredToolResult emits for Edit are the exact tags EditDiffView consumes", async () => {
    const transcript = await import("../tui/session-transcript.js");
    const blocks = transcript.formatStructuredToolResult(
      "Edit",
      "tool_call_completed",
      {
        result: {
          path: "src/foo.ts",
          diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
        },
      },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    expect(joined).toContain("<edit-file>src/foo.ts</edit-file>");
    expect(joined).toContain("<edit-diff>--- a");

    const node = EditDiffView({ content: joined });
    expect(node).toBeDefined();
    const children = flattenChildren(node);
    const fileHeader = children.find(
      (c) => c.props.bold === true && c.props.children === "src/foo.ts",
    );
    expect(fileHeader).toBeDefined();
    const greenLine = children.find(
      (c) =>
        c.props.color === "green" &&
        typeof c.props.children === "string" &&
        (c.props.children as string).startsWith("+new"),
    );
    expect(greenLine).toBeDefined();
  });
});
