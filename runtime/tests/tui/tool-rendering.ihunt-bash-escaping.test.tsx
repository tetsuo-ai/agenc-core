import { describe, expect, test, vi } from "vitest";

// Mock the Ink primitives the same way the sibling tool-rendering tests do:
// Box/Text become inert components so the views can be invoked directly and
// their React-element tree inspected via `props`.
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
  ToolErrorView,
} from "./tool-rendering.js";
import { escapeXml } from "../../src/utils/xml.js";

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
  // Recurse through the element tree: BashOutputView nests its stdout/stderr
  // lines inside the `⎿`-gutter content column, so a shallow walk misses them.
  const out: ChildElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    out.push(value as ChildElement);
    const children = (value as { props?: { children?: unknown } }).props
      ?.children;
    if (children !== undefined) visit(children);
  };
  visit((node as { props?: { children?: unknown } })?.props?.children);
  return out;
}

/**
 * `renderToolUseErrorMessage` returns an un-rendered `<ToolErrorView content=…/>`
 * element. Render it to a concrete tree so its displayed `<Text>` strings can be
 * inspected. Asserts the wrapper really is a ToolErrorView (the dispatch target).
 */
function renderErrorView(node: unknown): unknown {
  const element = node as { readonly type?: unknown; readonly props?: { readonly content?: unknown } };
  expect(element.type).toBe(ToolErrorView);
  const content = element.props?.content;
  expect(typeof content).toBe("string");
  return ToolErrorView({ content: content as string });
}

/** Collect every string `Text` child rendered anywhere in the tree. */
function collectText(node: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.flat(Infinity)) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      visit((value as { props?: { children?: unknown } }).props?.children);
    }
  };
  visit(node);
  return out;
}

describe("ihunt: BashOutputView unescapes the bash envelope (bug #1)", () => {
  test("renders raw shell metacharacters, not literal XML entities", () => {
    // session-transcript.formatStructuredToolResult escapes stdout on produce:
    //   `<bash-stdout>${escapeXml(stdout)}</bash-stdout>`
    // so the rendered view must decode it back. If the unescapeXml fix is
    // reverted, the view shows `&lt;a&gt; &amp;&amp; &lt;b&gt;` literally.
    const stdout = "<a> && <b>";
    const content = `<bash-stdout>${escapeXml(stdout)}</bash-stdout>[exit_code=0]`;

    const node = BashOutputView({ content });
    const texts = collectText(node);

    expect(texts).toContain("<a> && <b>");
    expect(texts.join("\n")).not.toContain("&lt;");
    expect(texts.join("\n")).not.toContain("&amp;");
    expect(texts.join("\n")).not.toContain("&gt;");
  });

  test("unescapes stderr on a non-zero exit", () => {
    const stdout = "before";
    const stderr = "syntax error near `&&`";
    const content =
      `<bash-stdout>${escapeXml(stdout)}</bash-stdout>` +
      `<bash-stderr>${escapeXml(stderr)}</bash-stderr>[exit_code=2]`;

    const node = BashOutputView({ content });
    const children = flatten(node);
    const redLine = children.find((child) => child.props.color === "red");

    expect(redLine).toBeDefined();
    expect(redLine?.props.children).toBe("syntax error near `&&`");
    expect(String(redLine?.props.children)).not.toContain("&amp;");
  });

  test("the PLAIN (raw exec trailer) branch is left untouched", () => {
    // A plain exec result was never escaped, so it must NOT be unescaped
    // (which would corrupt a legitimately-encoded `&amp;` in raw output).
    const content = "raw &amp; survives\n\n[exec exit_code=0 wall_time=0.01s]";

    const node = BashOutputView({ content });
    const texts = collectText(node);

    expect(texts).toContain("raw &amp; survives");
  });
});

describe("ihunt: failed structured tool result shows the error text (bug #2)", () => {
  test("Bash error renders the real stderr, not truncated raw JSON", () => {
    const tool = createTuiTool("Bash");
    const stderr = "command not found: foo-does-not-exist";
    // The shape a non-zero exec_command_end delivers to the error channel:
    // a structured-content-block ARRAY, not a string or an Error.
    const blocks = [
      { type: "text", text: "<bash-stdout></bash-stdout>" },
      { type: "text", text: `<bash-stderr>${escapeXml(stderr)}</bash-stderr>` },
      { type: "text", text: "[exit_code=127]" },
    ];

    const node = tool.renderToolUseErrorMessage(blocks);
    const texts = collectText(renderErrorView(node)).join("\n");

    // The real error text must appear in full...
    expect(texts).toContain("command not found: foo-does-not-exist");
    // ...and must NOT be the JSON-stringified, 140-char-truncated array.
    expect(texts).not.toContain('[{"type":"text"');
    expect(texts).not.toContain("...");
    // The escaped envelope must not leak as raw tags / entities.
    expect(texts).not.toContain("<bash-stderr>");
    expect(texts).not.toContain("&lt;");
  });

  test("long failing stderr is not truncated to 140 chars", () => {
    const tool = createTuiTool("exec_command");
    const stderr =
      "ld: error: undefined reference to `main' — " +
      "this is a deliberately long linker error that exceeds the 140 " +
      "character JSON truncation budget so the old shortJson path would " +
      "have cut it off entirely.";
    const blocks = [
      { type: "text", text: `<bash-stderr>${escapeXml(stderr)}</bash-stderr>` },
      { type: "text", text: "[exit_code=1]" },
    ];

    const node = tool.renderToolUseErrorMessage(blocks);
    const texts = collectText(renderErrorView(node)).join("\n");

    expect(texts).toContain(stderr);
  });

  test("string and Error inputs still render through the existing branches", () => {
    const tool = createTuiTool("Bash");

    const stringNode = tool.renderToolUseErrorMessage("plain failure text");
    expect(collectText(renderErrorView(stringNode)).join("\n")).toContain(
      "plain failure text",
    );

    const errorNode = tool.renderToolUseErrorMessage(new Error("boom"));
    expect(collectText(renderErrorView(errorNode)).join("\n")).toContain("boom");
  });
});
