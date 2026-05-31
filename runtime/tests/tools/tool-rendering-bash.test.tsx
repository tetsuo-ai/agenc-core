import { describe, expect, test, vi } from "vitest";

// Stub AgenC ink before tool-rendering.tsx imports it. The real AgenC ink
// transitively pulls `utils/config.ts` which runs a
// `feature('TEAMMEM') ? require('../memdir/teamMemPaths') : null`
// branch — vitest's source resolver cannot follow the .js → .ts mapping
// inside a CommonJS require, so importing the real chain crashes the test
// host. The stubs here keep the dispatch logic exercisable end-to-end
// without that resolution chain.
vi.mock("../tui/ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import { createTuiTool, BashOutputView } from "../tui/tool-rendering.js";

describe("createTuiTool('Bash').renderToolResultMessage — end-to-end dispatch", () => {
  test("Bash content with <bash-stdout> envelope produces a React element whose type is BashOutputView", () => {
    const tool = createTuiTool("Bash");
    const node = tool.renderToolResultMessage(
      "<bash-stdout>hello</bash-stdout>[exit_code=0]",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).toBe(BashOutputView);
  });

  test("Bash content WITHOUT <bash-stdout> envelope (legacy plain string) falls through to the generic Box/Text fallback — element type is the Box stub, NOT BashOutputView", () => {
    const tool = createTuiTool("Bash");
    const node = tool.renderToolResultMessage(
      "raw legacy string with no envelope",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(BashOutputView);
  });

  test("Bash with the structured-content-blocks array shape (the real shape formatStructuredToolResult emits) is collapsed to joined text and dispatches to BashOutputView", () => {
    const tool = createTuiTool("Bash");
    const blocks = [
      { type: "text", text: "<bash-stdout>line</bash-stdout>" },
      { type: "text", text: "<bash-stderr>warn</bash-stderr>" },
      { type: "text", text: "[exit_code=0 duration_ms=42]" },
    ];
    const node = tool.renderToolResultMessage(blocks, [], { verbose: false });
    expect((node as { type: unknown }).type).toBe(BashOutputView);
    // The joined content reaches BashOutputView via props.content
    const props = (node as { props: { content: string } }).props;
    expect(props.content).toContain("<bash-stdout>line</bash-stdout>");
    expect(props.content).toContain("<bash-stderr>warn</bash-stderr>");
    expect(props.content).toContain("[exit_code=0 duration_ms=42]");
  });

  test("Bash dispatch is exact-case — the TUI tool name 'bash' (lowercase) does NOT route to BashOutputView", () => {
    const tool = createTuiTool("bash");
    const node = tool.renderToolResultMessage(
      "<bash-stdout>x</bash-stdout>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(BashOutputView);
  });

  test("Non-Bash tool name with content that happens to contain <bash-stdout> does NOT route to BashOutputView", () => {
    const tool = createTuiTool("XYZUnknown");
    const node = tool.renderToolResultMessage(
      "<bash-stdout>x</bash-stdout>",
      [],
      { verbose: false },
    );
    expect((node as { type: unknown }).type).not.toBe(BashOutputView);
  });

  test("Bash with null content falls through to generic — does not throw on tag extraction", () => {
    const tool = createTuiTool("Bash");
    const node = tool.renderToolResultMessage(null, [], { verbose: false });
    expect((node as { type: unknown }).type).not.toBe(BashOutputView);
  });

  test("Bash TUI tool's mapToolResultToToolResultBlockParam emits a tool_result block whose content is the joined text (preserves wire shape downstream)", () => {
    const tool = createTuiTool("Bash");
    const blocks = [
      { type: "text", text: "<bash-stdout>output</bash-stdout>" },
      { type: "text", text: "[exit_code=0]" },
    ];
    const block = tool.mapToolResultToToolResultBlockParam(blocks, "call-1");
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call-1");
    expect(block.content).toBe(
      "<bash-stdout>output</bash-stdout>\n[exit_code=0]",
    );
  });
});

/**
 * Flatten the children of a BashOutputView node into an array of child
 * elements. When the view returns a bare <Text> (the silent / no-output case)
 * the node itself is the only "child".
 */
function flattenBash(node: unknown): { props: { children?: unknown; color?: string } }[] {
  const children = (node as { props?: { children?: unknown } }).props?.children;
  const isElementWithChildrenArray =
    children !== undefined &&
    (Array.isArray(children) ||
      (typeof children === "object" && children !== null));
  const arr = isElementWithChildrenArray
    ? Array.isArray(children)
      ? children
      : [children]
    : [node];
  return arr
    .flat(Infinity)
    .filter(
      (child): child is { props: { children?: unknown; color?: string } } =>
        typeof child === "object" && child !== null,
    );
}

describe("BashOutputView — capped preview visual contract", () => {
  test("renders no-output indicator when both stdout and stderr are empty (zero exit)", () => {
    // Capped preview: silent success collapses to a single dim "(No output)".
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>[exit_code=0]",
    }) as { props: { children?: unknown; dimColor?: boolean } };
    expect(node.props.children).toBe("(No output)");
    expect(node.props.dimColor).toBe(true);
  });

  test("silent non-zero exit notes the failed exit instead of a metadata line", () => {
    // The raw [exit_code=...] metadata block is no longer surfaced; a silent
    // failure is summarized inline instead.
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout>[exit_code=1]",
    }) as { props: { children?: unknown } };
    expect(node.props.children).toBe("(no output, non-zero exit)");
  });

  test("oversized single stdout line is width-capped with a [N chars truncated] marker", () => {
    const huge = "a".repeat(50_000);
    const node = BashOutputView({
      content: `<bash-stdout>${huge}</bash-stdout>[exit_code=0]`,
    });
    const flat = flattenBash(node);
    const stdoutLine = flat.find(
      (child) =>
        typeof child.props?.children === "string" &&
        (child.props.children as string).startsWith("a"),
    );
    expect(stdoutLine).toBeDefined();
    expect((stdoutLine!.props.children as string).length).toBeLessThan(10_000);
    expect(stdoutLine!.props.children as string).toContain("chars truncated");
  });

  test("non-zero exit surfaces stderr in red even when stdout is empty", () => {
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout><bash-stderr>oops</bash-stderr>[exit_code=1]",
    });
    const flat = flattenBash(node);
    const stderrLine = flat.find(
      (child) => child.props?.color === "red" && child.props.children === "oops",
    );
    expect(stderrLine).toBeDefined();
    // No (No output) indicator should appear because stderr is non-empty.
    const hasNoOutput = flat.some(
      (child) => child.props?.children === "(No output)",
    );
    expect(hasNoOutput).toBe(false);
  });

  test("zero exit does NOT surface stderr (only failures append it)", () => {
    const node = BashOutputView({
      content: "<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>[exit_code=0]",
    });
    const flat = flattenBash(node);
    expect(
      flat.some((child) => child.props?.children === "ok"),
    ).toBe(true);
    expect(
      flat.some((child) => child.props?.children === "warn"),
    ).toBe(false);
  });

  test("ANSI escape sequences inside <bash-stdout> are passed through verbatim", () => {
    const ansi = "\x1b[31mred\x1b[0m text";
    const node = BashOutputView({
      content: `<bash-stdout>${ansi}</bash-stdout>[exit_code=0]`,
    });
    const flat = flattenBash(node);
    const stdoutLine = flat.find((child) => child.props?.children === ansi);
    expect(stdoutLine).toBeDefined();
  });
});

describe("formatStructuredToolResult ⇄ BashOutputView wire-shape lock", () => {
  test("the tags formatStructuredToolResult emits are the exact tags BashOutputView consumes (so a future flip to the upstream UserBashOutputMessage component requires no shape changes)", async () => {
    const adapterModule = await import(
      "../tui/session-transcript.js"
    );
    const blocks = adapterModule.formatStructuredToolResult(
      "Bash",
      "exec_command_end",
      { stdout: "out", stderr: "err", exitCode: 1, durationMs: 5 },
    );
    const joined = blocks.map((b) => b.text).join("\n");
    expect(joined).toContain("<bash-stdout>out</bash-stdout>");
    expect(joined).toContain("<bash-stderr>err</bash-stderr>");
    expect(joined).toContain("exit_code=1");

    const node = BashOutputView({ content: joined });
    expect(node).toBeDefined();
    const children = (node as { props: { children: unknown[] } }).props.children;
    const flat = (Array.isArray(children) ? children : [children])
      .flat(Infinity)
      .filter((child) => child !== null);
    const renderedTexts = flat
      .filter(
        (child): child is { props: { children: string } } =>
          typeof child === "object" &&
          child !== null &&
          typeof (child as { props?: { children?: unknown } }).props
            ?.children === "string",
      )
      .map((child) => child.props.children);
    expect(renderedTexts.some((t) => t === "out")).toBe(true);
    expect(renderedTexts.some((t) => t === "err")).toBe(true);
  });
});
