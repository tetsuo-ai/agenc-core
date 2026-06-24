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
import { selectAgenCTuiGlyphs } from "../tui/glyphs.js";

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
 * Recursively collect every descendant element of a BashOutputView node into a
 * flat array. The capped stdout/stderr lines now sit one level deeper inside the
 * `⎿`-gutter content column (a row layout: gutter column + content column), so
 * this walks the element tree rather than only the immediate children. When the
 * view returns a bare <Text> (the silent / no-output case) the node itself is
 * the only element.
 */
function flattenBash(
  node: unknown,
): { props: { children?: unknown; color?: string; dimColor?: boolean } }[] {
  const out: { props: { children?: unknown; color?: string; dimColor?: boolean } }[] =
    [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const element = value as {
      props?: { children?: unknown; color?: string; dimColor?: boolean };
    };
    out.push(
      element as { props: { children?: unknown; color?: string; dimColor?: boolean } },
    );
    if (element.props && "children" in element.props) {
      visit(element.props.children);
    }
  };
  visit(node);
  return out;
}

describe("BashOutputView — capped preview visual contract", () => {
  test("renders no-output indicator when both stdout and stderr are empty (zero exit)", () => {
    // Capped preview: silent success collapses to a single dim "(No output)".
    // The line now nests behind the `⎿` continuation gutter (like the non-empty
    // branch), so the text lives in a child <Text> under the gutter row layout
    // rather than as the root node's direct child.
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>[exit_code=0]",
    });
    const flat = flattenBash(node);
    const noOutput = flat.find((child) => child.props?.children === "(No output)");
    expect(noOutput).toBeDefined();
    expect(noOutput!.props.dimColor).toBe(true);
  });

  test("silent non-zero exit notes the failed exit instead of a metadata line", () => {
    // The raw [exit_code=...] metadata block is no longer surfaced; a silent
    // failure is summarized inline instead, nested behind the gutter.
    const node = BashOutputView({
      content: "<bash-stdout></bash-stdout>[exit_code=1]",
    });
    const flat = flattenBash(node);
    expect(
      flat.some((child) => child.props?.children === "(no output, non-zero exit)"),
    ).toBe(true);
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
    const renderedTexts = flattenBash(node)
      .filter(
        (child): child is { props: { children: string } } =>
          typeof child.props.children === "string",
      )
      .map((child) => child.props.children);
    expect(renderedTexts.some((t) => t === "out")).toBe(true);
    expect(renderedTexts.some((t) => t === "err")).toBe(true);
  });
});

/**
 * The command stdout must nest UNDER its `● Run(...)` call row behind the same
 * `⎿` continuation gutter the file-changed summary and the Read/Search collapsed
 * body use — instead of breaking out flush at the bullet column — and render in
 * the dim/secondary tone the other tool-result bodies use (so the raw output is
 * not the loudest, full-brightness block in the transcript).
 *
 * REVERT-SENSITIVITY: against the pre-fix renderer the multi-line stdout was a
 * flat list of bare `<Text>{line}</Text>` children — no gutter Text existed
 * anywhere and the stdout lines carried no `dimColor`. Both assertions below go
 * red if the gutter/indent + secondary-tone change is reverted.
 */
describe("BashOutputView — stdout nests behind the ⎿ gutter in the secondary tone", () => {
  const gutter = selectAgenCTuiGlyphs().responseGutter;

  test("multi-line stdout renders behind a single ⎿ continuation gutter, indented into a content column (not flush at the glyph column)", () => {
    const node = BashOutputView({
      content:
        "<bash-stdout>INFO: 3\nWARN: 2\nERROR: 2</bash-stdout>[exit_code=0]",
    });
    const flat = flattenBash(node);

    // A gutter Text containing the responseGutter glyph must exist. The old
    // renderer had no gutter at all, so this find() returns undefined on revert.
    const gutterLine = flat.find(
      (child) =>
        typeof child.props?.children === "string" &&
        (child.props.children as string).includes(gutter),
    );
    expect(gutterLine).toBeDefined();
    // The gutter sits in its own dimmed column.
    expect(gutterLine!.props.dimColor).toBe(true);

    // The top-level node is a ROW (gutter column + content column), so the
    // stdout lines are NOT direct children of the returned node — they live one
    // level deeper in the content column. The pre-fix node rendered them as
    // immediate column children with no gutter, so this structural nesting is
    // itself the fix.
    const topChildren = (node as { props: { children: unknown } }).props
      .children;
    const topArray = Array.isArray(topChildren) ? topChildren : [topChildren];
    const stdoutAtTopLevel = topArray
      .flat(Infinity)
      .some(
        (child) =>
          typeof child === "object" &&
          child !== null &&
          (child as { props?: { children?: unknown } }).props?.children ===
            "INFO: 3",
      );
    expect(stdoutAtTopLevel).toBe(false);

    // Each stdout line is reachable (nested) and rendered in the dim/secondary
    // tone — never full brightness.
    for (const expected of ["INFO: 3", "WARN: 2", "ERROR: 2"]) {
      const line = flat.find((child) => child.props?.children === expected);
      expect(line).toBeDefined();
      expect(line!.props.dimColor).toBe(true);
    }
  });

  test("the `… +N lines` truncation summary inherits the gutter/indent and stays dim", () => {
    // 7 lines with a 5-line cap → 2 remaining, surfaced as "… +2 lines" under
    // the same gutter. (No new interactivity is added for the truncation.)
    const body = Array.from({ length: 7 }, (_, i) => `row ${i}`).join("\n");
    const node = BashOutputView({
      content: `<bash-stdout>${body}</bash-stdout>[exit_code=0]`,
    });
    const flat = flattenBash(node);
    const more = flat.find(
      (child) =>
        typeof child.props?.children === "string" &&
        (child.props.children as string).startsWith("… +2"),
    );
    expect(more).toBeDefined();
    expect(more!.props.dimColor).toBe(true);
    // Still behind the gutter.
    expect(
      flat.some(
        (child) =>
          typeof child.props?.children === "string" &&
          (child.props.children as string).includes(gutter),
      ),
    ).toBe(true);
  });
});
