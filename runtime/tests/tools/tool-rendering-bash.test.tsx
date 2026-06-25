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

/**
 * Failure-aware cap: when a command FAILS, the diagnostic payload (the
 * exception line + the PASS/FAIL verdict) lives at the END of the output. A
 * head-only cap truncates exactly those lines. The cap is split HEAD+TAIL on
 * failure so the trailing verdict/exception survives, while SUCCESS stays
 * head-only and byte-identical.
 *
 * REVERT-SENSITIVITY: against the pre-fix head-only renderer the failing-case
 * assertions below go RED — the `AssertionError:` reason and the
 * `FAILED (failures=1)` verdict are sliced off (only the first ~5 lines survive,
 * with `… +K lines` swallowing the tail). The success-case assertion still
 * passes both before and after (head-only is unchanged) and pins that the
 * success path was NOT altered.
 */
describe("BashOutputView — failure cap keeps the trailing verdict/exception (head+tail)", () => {
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

  const findMore = (
    flat: { props: { children?: unknown } }[],
  ): string | undefined => {
    const more = flat.find(
      (child) =>
        typeof child.props?.children === "string" &&
        (child.props.children as string).startsWith("… +"),
    );
    return more ? (more.props.children as string) : undefined;
  };

  test("STDOUT failure path (live-daemon fold): trailing verdict survives the cap", () => {
    // The live daemon folds stdout+stderr into one plain exec stream; a failing
    // run surfaces here as a non-zero plain-exec trailer.
    const node = BashOutputView({
      content: `${FAILING_UNITTEST_BODY}\n\n[exec exit_code=1 wall_time=0.01s tokens=20]`,
    });
    const flat = flattenBash(node);

    // The verdict (LAST line) and the test count must survive — a head-only cap
    // drops both.
    expect(findText(flat, "FAILED (failures=1)")).toBe(true);
    expect(findText(flat, "Ran 5 tests in 0.001s")).toBe(true);

    // Early context (the head) is still shown.
    expect(findText(flat, "F....")).toBe(true);

    // The elision reports the HIDDEN MIDDLE count: 11 lines, 2 head + 3 tail
    // visible → 11 - 5 = 6 hidden. The marker now also advertises the
    // "view full output" affordance (the hidden lines are reachable by
    // expanding the transcript), so it is no longer a dead end.
    expect(findMore(flat)).toBe("… +6 lines · ctrl+o for full output");
  });

  test("STDOUT failure path: the bottom EXCEPTION line survives when it is the last line", () => {
    // A crash whose `ZeroDivisionError: ...` (the WHY) is the LAST line — the
    // case a head-only cap mangles most.
    const node = BashOutputView({
      content: `${CRASHING_SCRIPT_BODY}\n\n[exec exit_code=1 wall_time=0.01s tokens=20]`,
    });
    const flat = flattenBash(node);

    expect(findText(flat, "ZeroDivisionError: division by zero")).toBe(true);
    // Head context preserved too.
    expect(findText(flat, "starting computation")).toBe(true);
    // 8 lines, 2 head + 3 tail → 8 - 5 = 3 hidden. Marker carries the
    // "view full output" affordance.
    expect(findMore(flat)).toBe("… +3 lines · ctrl+o for full output");
  });

  test("STDERR envelope path: traceback verdict survives the red cap", () => {
    // unittest writes its report to STDERR; the envelope path carries it in
    // <bash-stderr>. The failing cap must keep the tail there too, in red.
    const node = BashOutputView({
      content:
        `<bash-stdout></bash-stdout>` +
        `<bash-stderr>${FAILING_UNITTEST_BODY}</bash-stderr>[exit_code=1]`,
    });
    const flat = flattenBash(node);

    // The verdict survives in the red failure tone.
    const verdict = flat.find(
      (child) =>
        child.props?.children === "FAILED (failures=1)" &&
        (child.props as { color?: string }).color === "red",
    );
    expect(verdict).toBeDefined();
    expect(findText(flat, "Ran 5 tests in 0.001s")).toBe(true);

    // The stderr elision count is correct (same 11-line body → 6 hidden), and
    // the marker advertises the "view full output" affordance.
    expect(findMore(flat)).toBe("… +6 lines · ctrl+o for full output");
  });

  test("SUCCESS path is unchanged: head-only cap, trailing lines truncated away", () => {
    // Same 11-line body but exit 0 → the head-only behavior is preserved. The
    // verdict-shaped LAST line must NOT survive (it's beyond the 5-line head),
    // and the elision reports 11 - 5 = 6 remaining.
    const node = BashOutputView({
      content: `<bash-stdout>${FAILING_UNITTEST_BODY}</bash-stdout>[exit_code=0]`,
    });
    const flat = flattenBash(node);

    // The first 5 lines survive head-only...
    expect(findText(flat, "F....")).toBe(true);
    expect(
      findText(flat, "FAIL: test_add_fractions (tests.test_fraction.FractionTest)"),
    ).toBe(true);
    // ...and the trailing verdict is truncated away (head-only, unchanged).
    expect(findText(flat, "FAILED (failures=1)")).toBe(false);
    expect(findText(flat, "Ran 5 tests in 0.001s")).toBe(false);
    // Head-only elision: 11 - 5 = 6 remaining, with the "view full output"
    // affordance on the marker.
    expect(findMore(flat)).toBe("… +6 lines · ctrl+o for full output");
  });
});

/**
 * "view full output" affordance: a capped command output used to be a DEAD END
 * — the hidden lines were unreachable, unlike the Edit DIFF card whose collapsed
 * `… +N more · ctrl+w d for full diff` marker reaches the full diff. The
 * `… +K lines` marker now advertises the existing transcript-expand mechanism
 * (`app:toggleTranscript`, default `ctrl+o`), and when the transcript is
 * expanded the `verbose` prop (already plumbed in from `UserToolSuccessMessage`)
 * lifts the cap so the FULL output is reachable and scrollable.
 *
 * REVERT-SENSITIVITY: against the pre-fix renderer the marker was bare
 * `… +K lines` (no affordance) and `verbose` was ignored (`_verbose`), so the
 * "advertises the affordance" and "verbose lifts the cap" assertions go RED. The
 * "absent when not truncated" assertion holds both before and after (it pins
 * that the hint is gated on actual truncation, never shown spuriously).
 */
describe("BashOutputView — view-full-output affordance", () => {
  const allTexts = (node: unknown): string[] =>
    flattenBash(node)
      .map((child) => child.props?.children)
      .filter((value): value is string => typeof value === "string");

  const findMoreLine = (node: unknown): string | undefined =>
    allTexts(node).find((text) => text.startsWith("… +"));

  test("a truncated success output marker advertises the full-output affordance", () => {
    // 12 lines, exit 0 → head-only cap → 7 hidden. The marker now carries the
    // affordance hint that points at the transcript-expand shortcut.
    const body = Array.from({ length: 12 }, (_, i) => `row-${i + 1}`).join("\n");
    const node = BashOutputView({
      content: `<bash-stdout>${body}</bash-stdout>[exit_code=0]`,
    });
    const more = findMoreLine(node);
    expect(more).toBe("… +7 lines · ctrl+o for full output");
    // Honors the configured shortcut for app:toggleTranscript (default ctrl+o).
    expect(more).toContain("ctrl+o");
    expect(more).toContain("for full output");
  });

  test("the affordance is ABSENT when the output is not truncated (K === 0)", () => {
    // 3 lines, under the 5-line cap → no elision marker, so no affordance.
    const node = BashOutputView({
      content: "<bash-stdout>a\nb\nc</bash-stdout>[exit_code=0]",
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
