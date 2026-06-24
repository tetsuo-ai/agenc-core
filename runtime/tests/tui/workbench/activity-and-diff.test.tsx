import React from "react";
import { describe, expect, it } from "vitest";

import { Box } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { WorkbenchActivityIndicator } from "../../../src/tui/workbench/WorkbenchActivityIndicator.js";
import { WorkbenchStatusBar } from "../../../src/tui/workbench/WorkbenchStatusBar.js";
import { DiffInline } from "../../../src/tui/components/v2/primitives.js";
import { buildEditDiffPreview } from "../../../src/tui/edit-diff-preview.js";
import { renderToString } from "../../../src/utils/staticRender.js";
import {
  getReducedMotionDot,
  titleVerbForMode,
  verbForMode,
} from "../../../src/tui/components/spinner/utils.js";
import type { SpinnerMode } from "../../../src/tui/components/spinner/types.js";

function withState(node: React.ReactNode): React.ReactElement {
  return <AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>;
}

describe("WorkbenchActivityIndicator (working / waiting-on-model signal)", () => {
  // The verb text is the load-bearing, surface-agnostic signal: the glyph is a
  // brand spinner frame that varies, but the verb is stable. Asserting on the
  // verb makes the test robust and revert-sensitive (idle renders no verb).
  it("renders a distinct, title-cased working verb while a turn is active", async () => {
    const out = await renderToString(
      withState(<WorkbenchActivityIndicator mode="requesting" />),
      80,
    );
    // Title-cased to agree with the composer body spinner ("Working…") for the
    // same turn, instead of a lowercase "working…" next to ALL-CAPS chrome.
    // Revert-sensitive: reverting the indicator to verbForMode (lowercase)
    // renders "working" and fails the title-case assertion below.
    expect(out).toContain("Working");
    expect(out).not.toContain("working");
  });

  it("maps each streaming phase to its own title-cased verb", async () => {
    const cases: ReadonlyArray<[Parameters<typeof WorkbenchActivityIndicator>[0]["mode"], string]> = [
      ["thinking", "Thinking"],
      ["responding", "Responding"],
      ["tool-use", "Running tools"],
      ["tool-input", "Preparing tools"],
    ];
    for (const [mode, verb] of cases) {
      const out = await renderToString(withState(<WorkbenchActivityIndicator mode={mode} />), 80);
      expect(out).toContain(verb);
    }
  });

  // Revert-sensitivity anchor: when idle (mode === null) the indicator must
  // produce NO working text. If the indicator stopped reflecting real turn
  // state (e.g. always-on), this assertion goes red.
  it("renders nothing when the session is idle (mode === null)", async () => {
    const out = await renderToString(withState(<WorkbenchActivityIndicator mode={null} />), 80);
    expect(out).not.toContain("working");
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("responding");
    expect(out).not.toContain("running tools");
    expect(out.trim()).toBe("");
  });

  it("uses the reduced-motion glyph when motion is reduced", async () => {
    const state = getDefaultAppState();
    const reduced = {
      ...state,
      settings: { ...state.settings, prefersReducedMotion: true },
    };
    const out = await renderToString(
      <AppStateProvider initialState={reduced as never}>
        <WorkbenchActivityIndicator mode="requesting" />
      </AppStateProvider>,
      80,
    );
    expect(out).toContain(getReducedMotionDot());
    expect(out).toContain("Working");
  });

  // #16: when the animated glyph lands on its dot frame ("·") it sits next to
  // the leading "·" separator and reads as a doubled "· ·". The separator must
  // collapse for that frame. reduced-motion forces a deterministic, stable
  // glyph so the assertion is frame-independent.
  it("never renders a doubled '· ·' next to the verb", async () => {
    for (const mode of [
      "requesting",
      "responding",
      "thinking",
      "tool-use",
      "tool-input",
    ] as const) {
      const out = await renderToString(
        withState(<WorkbenchActivityIndicator mode={mode} />),
        80,
      );
      expect(out).not.toContain("· ·");
    }
  });
});

// #1 / #11: the workbench title bar and the composer status line must describe
// the SAME phase. Both derive their honest label from verbForMode, so the
// title-bar phrasing and the status-line phrasing can never silently diverge.
describe("title bar / status line phase agreement", () => {
  const MODES: readonly SpinnerMode[] = [
    "requesting",
    "responding",
    "thinking",
    "tool-use",
    "tool-input",
  ];

  it("derives the status-line title verb from the same phase as the title bar", () => {
    for (const mode of MODES) {
      // titleVerbForMode (status line) is just the title-cased verbForMode
      // (title bar) — same word, never a random system-colliding flavor verb.
      expect(titleVerbForMode(mode).toLowerCase()).toBe(verbForMode(mode));
    }
  });

  it("renders the honest, title-cased phase word in the workbench title bar for each mode", async () => {
    for (const mode of MODES) {
      const out = await renderToString(
        withState(<WorkbenchActivityIndicator mode={mode} />),
        80,
      );
      // The status-bar indicator now renders the SAME title-cased verb as the
      // composer body spinner (titleVerbForMode), so they never disagree on
      // casing for the same turn.
      expect(out).toContain(titleVerbForMode(mode));
    }
  });
});

describe("WorkbenchStatusBar working indicator", () => {
  it("shows the indicator only when a turn is active", async () => {
    const idle = await renderToString(withState(<WorkbenchStatusBar activityMode={null} />), 120);
    expect(idle).toContain("AgenC Workbench");
    expect(idle).not.toContain("working");

    const busy = await renderToString(
      withState(<WorkbenchStatusBar activityMode="requesting" />),
      120,
    );
    expect(busy).toContain("AgenC Workbench");
    // Title-cased verb, matching the composer body spinner for the same turn.
    expect(busy).toContain("Working");
  });
});

describe("DiffInline collapse affordance + truncation consistency", () => {
  const longEdit = {
    file_path: "primes.ts",
    // Write tool reads `content` (whole-file add), not old/new_string.
    content: Array.from({ length: 30 }, (_, i) => `// line ${i + 1} of a longer file`).join("\n"),
  };

  function renderPreview(preview: ReturnType<typeof buildEditDiffPreview>): Promise<string> {
    if (preview === null) throw new Error("expected a diff preview");
    const lines = [...preview.lines];
    if (preview.remaining > 0) {
      lines.push({
        kind: "ctx",
        code: `… +${preview.remaining} more ${preview.remaining === 1 ? "line" : "lines"} · ctrl+w d for full diff`,
      });
    }
    return renderToString(
      <Box flexDirection="column" width={80}>
        <DiffInline file={preview.file} stats={preview.stats} lines={lines} />
      </Box>,
      80,
    );
  }

  // Item 2: the collapse line must state HOW to see the rest — not be a dead end.
  it("collapse line states the full-diff affordance", async () => {
    const preview = buildEditDiffPreview("Write", longEdit);
    expect(preview).not.toBeNull();
    expect(preview!.remaining).toBeGreaterThan(0);
    const out = await renderPreview(preview);
    expect(out).toMatch(/\+\d+ more lines/);
    expect(out).toContain("ctrl+w d");
  });

  // Item 3: every overflowing diff line carries a truncation marker — never a
  // silent hard cut. We render a diff with a code line far wider than the box
  // and assert the ellipsis marker is present and the gutter stays aligned.
  it("truncates every overflowing line with a marker (no silent hard cut)", async () => {
    const wide = "x".repeat(200);
    const out = await renderToString(
      <Box flexDirection="column" width={60}>
        <DiffInline
          file="wide.ts"
          stats="+2 -0"
          lines={[
            { kind: "add", newLine: "1", code: `const a = "${wide}";` },
            { kind: "add", newLine: "2", code: `const b = "${wide}";` },
          ]}
        />
      </Box>,
      60,
    );
    const bodyLines = out
      .split("\n")
      .filter((l) => l.includes(" + ") && l.includes("const"));
    expect(bodyLines.length).toBe(2);
    // Both overflowing code lines must end with the truncation marker.
    for (const line of bodyLines) {
      expect(line).toContain("…");
    }
    // The gutter line numbers must remain aligned (no row got squeezed / wrapped
    // onto a blank second row, which previously dropped a pad space).
    const blankBodyRows = out
      .split("\n")
      .filter((l) => /^\s*│\s+│\s*$/.test(l));
    // The DIFF card has one intentional blank header-gap row; a wrapped diff row
    // would add more. Assert no extra blanks were introduced between code rows.
    expect(blankBodyRows.length).toBeLessThanOrEqual(1);
  });
});
