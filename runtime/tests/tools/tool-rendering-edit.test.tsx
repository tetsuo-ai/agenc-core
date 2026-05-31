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

describe("EditDiffView — capped (+a -r) diff preview", () => {
  test("renders a dim '(path (+a -r))' stat line plus green '+' / red '-' change rows", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a\n+++ b\n@@ -1,3 +1,3 @@\n-old line\n+new line</edit-diff>",
    });
    const children = flattenChildren(node);
    // Stat header: dim, path + (+1 -1). No bold, no cyan hunk line.
    const stat = children.find(
      (c) =>
        c.props.dimColor === true &&
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("(+1 -1)"),
    );
    expect(stat).toBeDefined();
    expect(stat!.props.children).toContain("src/foo.ts");
    expect(children.find((c) => c.props.bold === true)).toBeUndefined();
    expect(children.find((c) => c.props.color === "cyan")).toBeUndefined();

    const greenLine = children.find(
      (c) =>
        c.props.color === "green" &&
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("new line"),
    );
    expect(greenLine).toBeDefined();
    const redLine = children.find(
      (c) =>
        c.props.color === "red" &&
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("old line"),
    );
    expect(redLine).toBeDefined();
  });

  test("'+++' / '---' / '@@' lines are excluded from the change count and rows", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y</edit-diff>",
    });
    const children = flattenChildren(node);
    // Exactly one add + one remove counted (header/hunk lines dropped).
    const stat = children.find(
      (c) => typeof c.props.children === "string" && (c.props.children as string).includes("(+1 -1)"),
    );
    expect(stat).toBeDefined();
    expect(children.filter((c) => c.props.color === "green").length).toBe(1);
    expect(children.filter((c) => c.props.color === "red").length).toBe(1);
    // No metadata header lines leaked into the change rows.
    expect(
      children.some(
        (c) =>
          typeof c.props.children === "string" &&
          ((c.props.children as string).includes("--- a/src") ||
            (c.props.children as string).includes("+++ b/src")),
      ),
    ).toBe(false);
  });

  test("new-file diff (only '+' lines) counts all additions, zero removals", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/new.ts</edit-file>\n<edit-diff>+line one\n+line two\n+line three</edit-diff>",
    });
    const children = flattenChildren(node);
    expect(children.filter((c) => c.props.color === "green").length).toBe(3);
    expect(
      children.some(
        (c) => typeof c.props.children === "string" && (c.props.children as string).includes("(+3 -0)"),
      ),
    ).toBe(true);
  });

  test("file-deletion diff (only '-' lines) renders all deletions in red", () => {
    const node = EditDiffView({
      content:
        "<edit-file>src/old.ts</edit-file>\n<edit-diff>-line one\n-line two</edit-diff>",
    });
    const children = flattenChildren(node);
    expect(children.filter((c) => c.props.color === "red").length).toBe(2);
  });

  test("long diff is capped to 8 change rows with a '… +N more lines' marker", () => {
    const diffBody = Array.from({ length: 14 }, (_, i) => `+l${i}`).join("\n");
    const node = EditDiffView({
      content: `<edit-file>src/big.ts</edit-file>\n<edit-diff>${diffBody}</edit-diff>`,
    });
    const children = flattenChildren(node);
    expect(children.filter((c) => c.props.color === "green").length).toBe(8);
    expect(
      children.some(
        (c) =>
          typeof c.props.children === "string" &&
          (c.props.children as string).includes("+6 more"),
      ),
    ).toBe(true);
  });

  test("empty diff body falls back to (No changes) indicator", () => {
    const node = EditDiffView({
      content: "<edit-file>src/foo.ts</edit-file>\n<edit-diff></edit-diff>",
    }) as { props: ChildProps };
    expect(node.props.children).toBe("(No changes)");
    expect(node.props.dimColor).toBe(true);
  });

  test("malformed payload (no envelope tags at all) falls back to (No changes)", () => {
    const node = EditDiffView({ content: "raw text with no tags" }) as {
      props: ChildProps;
    };
    expect(node.props.children).toBe("(No changes)");
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
    // Stat line carries the path and (+1 -1); the green change row carries the
    // added line. This wire shape must stay in lockstep with the emitter.
    const stat = children.find(
      (c) =>
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("src/foo.ts") &&
        (c.props.children as string).includes("(+1 -1)"),
    );
    expect(stat).toBeDefined();
    const greenLine = children.find(
      (c) =>
        c.props.color === "green" &&
        typeof c.props.children === "string" &&
        (c.props.children as string).includes("new"),
    );
    expect(greenLine).toBeDefined();
  });
});
