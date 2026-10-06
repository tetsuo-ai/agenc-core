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
import { ResultLine } from "../tui/components/v2/primitives.js";
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
 * flat array. In the verbose (ctrl+o) view the stdout/stderr lines sit one level
 * deeper inside the `└`-gutter content column (a row layout: gutter column +
 * content column), so this walks the element tree rather than only the
 * immediate children. The transcript form is a single `<ResultLine>`, so the
 * node itself is the only element.
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

/**
 * The transcript form of a shell result: one `└` ResultLine ("9 lines",
 * "no output", "exit 1, reason"). Asserts the element is a ResultLine and
 * returns its text and failed flag.
 */
function resultLine(node: unknown): { readonly text: unknown; readonly failed?: boolean } {
  const element = node as {
    readonly type: unknown;
    readonly props: { readonly children?: unknown; readonly failed?: boolean };
  };
  expect(element.type).toBe(ResultLine);
  return { text: element.props.children, failed: element.props.failed };
}

// The transcript shows one result line per step; the full stdout/stderr body
// renders in the verbose (ctrl+o) view. Body-shape assertions below pass
// `verbose: true`; the one-line form is asserted with `resultLine`.
describe("BashOutputView: result line and verbose body visual contract", () => {
  test("renders no-output indicator when both stdout and stderr are empty (zero exit)", () => {
    const content =
      "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>[exit_code=0]";
    // Transcript: silent success is one "└ no output" result line.
    const line = resultLine(BashOutputView({ content }));
    expect(line.text).toBe("no output");
    expect(line.failed).toBeUndefined();

    // Verbose: a single dim "(No output)" that nests behind the `└`
    // continuation gutter (like the non-empty branch), so the text lives in a
    // child <Text> under the gutter row layout rather than as the root's child.
    const node = BashOutputView({ content, verbose: true });
    const flat = flattenBash(node);
    const noOutput = flat.find((child) => child.props?.children === "(No output)");
    expect(noOutput).toBeDefined();
    expect(noOutput!.props.dimColor).toBe(true);
  });

  test("silent non-zero exit notes the failed exit instead of a metadata line", () => {
    // The raw [exit_code=...] metadata block is no longer surfaced; a silent
    // failure is summarized inline instead.
    const content = "<bash-stdout></bash-stdout>[exit_code=1]";
    const line = resultLine(BashOutputView({ content }));
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 1");

    // Verbose: the same note, nested behind the gutter.
    const node = BashOutputView({ content, verbose: true });
    const flat = flattenBash(node);
    expect(
      flat.some((child) => child.props?.children === "(no output, non-zero exit)"),
    ).toBe(true);
  });

  test("oversized single stdout line collapses to a line count instead of being dumped", () => {
    // The old capped preview printed a width-capped copy of the line with a
    // "[N chars truncated]" marker. The transcript form never prints output:
    // a line too wide to show whole is counted, and ctrl+o has the full text.
    const huge = "a".repeat(50_000);
    const node = BashOutputView({
      content: `<bash-stdout>${huge}</bash-stdout>[exit_code=0]`,
    });
    expect(resultLine(node).text).toBe("1 line");
    expect(
      flattenBash(node).some(
        (child) =>
          typeof child.props?.children === "string" &&
          (child.props.children as string).startsWith("aaaa"),
      ),
    ).toBe(false);
  });

  test("a failure's reason comes from stderr even when stdout has later lines", () => {
    const content =
      "<bash-stdout>building\nstep 2 of 3</bash-stdout><bash-stderr>syntax error near `&amp;&amp;`</bash-stderr>[exit_code=2]";
    const line = resultLine(BashOutputView({ content }));
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 2, syntax error near `&&`");
  });

  test("non-zero exit surfaces stderr in red even when stdout is empty", () => {
    const content =
      "<bash-stdout></bash-stdout><bash-stderr>oops</bash-stderr>[exit_code=1]";
    // Transcript: the failed line leads with the exit code, then the reason.
    const line = resultLine(BashOutputView({ content }));
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 1, oops");

    const node = BashOutputView({ content, verbose: true });
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
    const content =
      "<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>[exit_code=0]";
    expect(resultLine(BashOutputView({ content })).text).toBe("ok");
    const node = BashOutputView({ content, verbose: true });
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
    const content = `<bash-stdout>${ansi}</bash-stdout>[exit_code=0]`;
    // Transcript: the one-line summary is plain text (escapes stripped).
    expect(resultLine(BashOutputView({ content })).text).toBe("red text");
    // Verbose: the program's own escapes reach the renderer untouched.
    const node = BashOutputView({ content, verbose: true });
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

    // Transcript form: one failed result line.
    expect(resultLine(BashOutputView({ content: joined })).failed).toBe(true);
    // Verbose form renders both bodies.
    const node = BashOutputView({ content: joined, verbose: true });
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
 * The command stdout must nest UNDER its `● Ran …` call row behind the same
 * `└` continuation gutter the file-changed summary and the Read/Search collapsed
 * body use — instead of breaking out flush at the bullet column — and render in
 * the dim/secondary tone the other tool-result bodies use (so the raw output is
 * not the loudest, full-brightness block in the transcript). The full body is
 * the verbose (ctrl+o) view; the transcript shows one `└` result line.
 *
 * REVERT-SENSITIVITY: against the pre-fix renderer the multi-line stdout was a
 * flat list of bare `<Text>{line}</Text>` children — no gutter Text existed
 * anywhere and the stdout lines carried no `dimColor`. Both assertions below go
 * red if the gutter/indent + secondary-tone change is reverted.
 */
describe("BashOutputView: stdout nests behind the └ gutter in the secondary tone", () => {
  const gutter = selectAgenCTuiGlyphs().responseGutter;

  test("multi-line stdout renders behind a single └ continuation gutter, indented into a content column (not flush at the glyph column)", () => {
    const node = BashOutputView({
      // Verbose shows every line, so this exercises MULTIPLE lines nested
      // behind ONE gutter.
      content:
        "<bash-stdout>INFO: 3\nWARN: 2\nERROR: 2</bash-stdout>[exit_code=1]",
      verbose: true,
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

  test("the transcript summary of a multi-line output is one └ result line with the count", () => {
    // The old success preview showed the first line plus a dim "… +6 lines"
    // under the gutter. The transcript now shows one quiet `└` result line
    // that counts the output (ResultLine draws the `└` and the gray tone); no
    // output line and no "… +N" marker are printed.
    const body = Array.from({ length: 7 }, (_, i) => `row ${i}`).join("\n");
    const node = BashOutputView({
      content: `<bash-stdout>${body}</bash-stdout>[exit_code=0]`,
    });
    expect(resultLine(node).text).toBe("7 lines");
    const flat = flattenBash(node);
    expect(flat.some((child) => child.props?.children === "row 0")).toBe(false);
    expect(
      flat.some(
        (child) =>
          typeof child.props?.children === "string" &&
          (child.props.children as string).startsWith("… +"),
      ),
    ).toBe(false);
  });
});

/**
 * Failure line keeps the trailing verdict/exception: when a command FAILS, the
 * diagnostic payload (the exception line + the PASS/FAIL verdict) lives at the
 * END of the output. The old head-only preview cap truncated exactly those
 * lines, and a head+tail cap fixed it. The transcript now shows one failed
 * line, "exit N, <last non-empty output line>", so the verdict/exception is
 * what the row says; ctrl+o (verbose) shows the full output, middle included.
 * A SUCCESS shows only a line count, never the trailing lines.
 *
 * REVERT-SENSITIVITY: a summary that kept the head instead of the last line
 * (the old head-only behavior) fails every failing-case assertion below.
 */
describe("BashOutputView: failure line keeps the trailing verdict/exception", () => {
  // A realistic failing `python -m unittest` body: progress dots + the FAIL
  // header + traceback at the TOP, then the test count + verdict at the BOTTOM.
  // 11 lines total, far past the 5-line cap. With a 2-head / 3-tail failure
  // split the bottom 3 lines (the `----` rule, the test count, and the
  // `FAILED (failures=1)` VERDICT — the most important diagnostic) survive.
  const FAILING_UNITTEST_BODY = [
    "F....", // 0 — progress (head)
    "======================================================================", // 1 — separator (head)
    "FAIL: test_add_fractions (tests.test_fraction.FractionTest)", // 2
    "----------------------------------------------------------------------", // 3
    "Traceback (most recent call last):", // 4
    '  File "tests/test_fraction.py", line 12, in test_add_fractions', // 5
    "    self.assertEqual(result, Fraction(3, 4))", // 6
    "AssertionError: Fraction(1, 2) != Fraction(3, 4)", // 7 (hidden middle)
    "----------------------------------------------------------------------", // 8 — rule (tail)
    "Ran 5 tests in 0.001s", // 9 — count (tail)
    "FAILED (failures=1)", // 10 — verdict (tail, LAST line)
  ].join("\n");

  // A crashing script whose EXCEPTION line is the LAST line — the canonical
  // case the head-only cap mangled: the `ZeroDivisionError` (the WHY) lives at
  // the very bottom, so a head-only 5-line cap drops it entirely.
  const CRASHING_SCRIPT_BODY = [
    "starting computation", // 0 (head)
    "loading inputs", // 1 (head)
    "Traceback (most recent call last):", // 2
    '  File "calc.py", line 3, in <module>', // 3
    "    result = total / count", // 4 (hidden middle)
    "                ~~~~~~^~~~~~~", // 5 (tail)
    '  File "calc.py", line 1, in divide', // 6 (tail)
    "ZeroDivisionError: division by zero", // 7 — verdict/exception (tail, LAST)
  ].join("\n");

  const findText = (
    flat: { props: { children?: unknown } }[],
    text: string,
  ): boolean =>
    flat.some(
      (child) =>
        typeof child.props?.children === "string" &&
        child.props.children === text,
    );

  test("STDOUT failure path (live-daemon fold): the trailing verdict is the failure line", () => {
    // The live daemon folds stdout+stderr into one plain exec stream; a failing
    // run surfaces here as a non-zero plain-exec trailer.
    const content = `${FAILING_UNITTEST_BODY}\n\n[exec exit_code=1 wall_time=0.01s tokens=20]`;
    const line = resultLine(BashOutputView({ content }));

    // The verdict (LAST line) is the reason the row gives; the head is not.
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 1, FAILED (failures=1)");

    // Verbose keeps the whole output reachable, the hidden middle included.
    const flat = flattenBash(BashOutputView({ content, verbose: true }));
    expect(findText(flat, "F....")).toBe(true);
    expect(findText(flat, "AssertionError: Fraction(1, 2) != Fraction(3, 4)")).toBe(true);
    expect(findText(flat, "FAILED (failures=1)")).toBe(true);
  });

  test("STDOUT failure path: the bottom EXCEPTION line is the failure line when it is the last line", () => {
    // A crash whose `ZeroDivisionError: ...` (the WHY) is the LAST line — the
    // case a head-only summary mangles most.
    const node = BashOutputView({
      content: `${CRASHING_SCRIPT_BODY}\n\n[exec exit_code=1 wall_time=0.01s tokens=20]`,
    });
    const line = resultLine(node);
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 1, ZeroDivisionError: division by zero");
    expect(String(line.text)).not.toContain("starting computation");
  });

  test("STDERR envelope path: the traceback verdict is the failure line, and red in verbose", () => {
    // unittest writes its report to STDERR; the envelope path carries it in
    // <bash-stderr>.
    const content =
      `<bash-stdout></bash-stdout>` +
      `<bash-stderr>${FAILING_UNITTEST_BODY}</bash-stderr>[exit_code=1]`;
    const line = resultLine(BashOutputView({ content }));
    expect(line.failed).toBe(true);
    expect(line.text).toBe("exit 1, FAILED (failures=1)");

    // Verbose: the verdict renders in the red failure tone.
    const flat = flattenBash(BashOutputView({ content, verbose: true }));
    const verdict = flat.find(
      (child) =>
        child.props?.children === "FAILED (failures=1)" &&
        (child.props as { color?: string }).color === "red",
    );
    expect(verdict).toBeDefined();
    expect(findText(flat, "Ran 5 tests in 0.001s")).toBe(true);
  });

  test("SUCCESS path counts the output and never shows the trailing lines", () => {
    // Same 11-line body but exit 0. The verdict-shaped LAST line must NOT be
    // shown, which is the whole contrast with the failure path above: a failure
    // leads with its trailing verdict, a success is just a count.
    const node = BashOutputView({
      content: `<bash-stdout>${FAILING_UNITTEST_BODY}</bash-stdout>[exit_code=0]`,
    });
    const line = resultLine(node);
    expect(line.failed).toBeUndefined();
    expect(line.text).toBe("11 lines");
    const flat = flattenBash(node);
    expect(findText(flat, "FAILED (failures=1)")).toBe(false);
    expect(findText(flat, "Ran 5 tests in 0.001s")).toBe(false);
  });
});

/**
 * Summarized output remains reachable through the workbench's persistent
 * transcript-expand control. The inline result line stays concise because
 * repeating the same shortcut on every message adds noise. When the transcript
 * is expanded, the `verbose` prop (already plumbed in from
 * `UserToolSuccessMessage`) shows the full output, scrollable.
 *
 * The compact assertion guards the workbench polish that moved shortcut
 * discovery into the footer. The expansion assertions keep the hidden output
 * reachable and catch any regression that ignores `verbose`.
 */
describe("BashOutputView — compact marker and transcript expansion", () => {
  const allTexts = (node: unknown): string[] =>
    flattenBash(node)
      .map((child) => child.props?.children)
      .filter((value): value is string => typeof value === "string");

  const findMoreLine = (node: unknown): string | undefined =>
    allTexts(node).find((text) => text.startsWith("… +"));

  test("a multi-line success output stays one compact count line", () => {
    // 12 lines, exit 0 → one "└ 12 lines" result line. The persistent footer
    // owns the transcript-expand shortcut, so the line does not repeat it.
    const body = Array.from({ length: 12 }, (_, i) => `row-${i + 1}`).join("\n");
    const node = BashOutputView({
      content: `<bash-stdout>${body}</bash-stdout>[exit_code=0]`,
    });
    expect(resultLine(node).text).toBe("12 lines");
    expect(findMoreLine(node)).toBeUndefined();
    expect(allTexts(node).some((text) => text.includes("for full output"))).toBe(false);
  });

  test("the affordance is ABSENT when the output is not truncated (K === 0)", () => {
    // A single line, exactly the success cap → nothing elided, so no marker
    // and no affordance.
    const node = BashOutputView({
      content: "<bash-stdout>a</bash-stdout>[exit_code=0]",
    });
    const texts = allTexts(node);
    expect(texts.some((text) => text.startsWith("… +"))).toBe(false);
    expect(texts.some((text) => text.includes("for full output"))).toBe(false);
  });

  test("verbose (expanded transcript) lifts the cap and shows the FULL output", () => {
    // Same 12-line body, but verbose → every line is rendered, no elision, no
    // affordance (nothing left to reach).
    const body = Array.from({ length: 12 }, (_, i) => `row-${i + 1}`).join("\n");
    const node = BashOutputView({
      content: `<bash-stdout>${body}</bash-stdout>[exit_code=0]`,
      verbose: true,
    });
    const texts = allTexts(node);
    for (let i = 1; i <= 12; i++) {
      expect(texts).toContain(`row-${i}`);
    }
    expect(texts.some((text) => text.startsWith("… +"))).toBe(false);
    expect(texts.some((text) => text.includes("for full output"))).toBe(false);
  });

  test("verbose also lifts the cap on a FAILED output (full traceback reachable)", () => {
    const body = [
      ...Array.from({ length: 10 }, (_, i) => `step-${i + 1}`),
      "AssertionError: boom",
      "FAILED (failures=1)",
    ].join("\n");
    const node = BashOutputView({
      content: `${body}\n\n[exec exit_code=1 wall_time=0.01s tokens=20]`,
      verbose: true,
    });
    const texts = allTexts(node);
    // The previously-hidden middle line is now reachable.
    expect(texts).toContain("step-5");
    expect(texts).toContain("AssertionError: boom");
    expect(texts).toContain("FAILED (failures=1)");
    expect(texts.some((text) => text.startsWith("… +"))).toBe(false);
  });
});
