import { homedir } from "node:os";

import React from "react";
import { describe, expect, test } from "vitest";

import { Box, Text } from "../../src/tui/ink.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../src/tui/state/AppState.js";
import { WorkbenchStatusBar } from "../../src/tui/workbench/WorkbenchStatusBar.js";
import {
  basenameOf,
  compactCwd,
  isDangerousPermissionMode,
  selectStripSegments,
  WorkbenchContextStrip,
} from "../../src/tui/workbench/WorkbenchContextStrip.js";
import type { PermissionMode } from "../../src/permissions/types.js";
import { renderToString } from "../../src/utils/staticRender.js";

// The context strip restores the always-on session context (model · permission
// mode · cwd) to the workbench status bar after the welcome summary box scrolls
// away. These tests assert:
//   - it shows the real model, permission mode, and a compact cwd
//   - a dangerous/elevated mode renders in the warning style (distinct from dim)
//   - it degrades (drops cwd, then mode) and never overflows the row at narrow
//     widths
//   - revert sensitivity: present-vs-absent + dangerous-vs-normal styling

const TEST_MODEL = "test-model-xyz";

function stateWith(
  overrides: {
    readonly model?: string;
    readonly mode?: PermissionMode;
  } = {},
): AppState {
  const base = getDefaultAppState();
  return {
    ...base,
    mainLoopModelForSession: overrides.model ?? TEST_MODEL,
    toolPermissionContext: {
      ...base.toolPermissionContext,
      mode: overrides.mode ?? "default",
    },
  };
}

function renderStatusBar(
  columns: number,
  overrides: Parameters<typeof stateWith>[0] = {},
): Promise<string> {
  return renderToString(
    <AppStateProvider initialState={stateWith(overrides)}>
      <WorkbenchStatusBar columns={columns} />
    </AppStateProvider>,
    { columns, rows: 3 },
  );
}

/** The single rendered row, trimmed of right padding. */
function statusRow(out: string): string {
  return (out.split("\n")[0] ?? "").replace(/\s+$/u, "");
}

describe("compactCwd / basenameOf helpers", () => {
  test("home-relativizes the cwd to ~", () => {
    const home = homedir();
    expect(compactCwd(`${home}/git/AgenC/agenc-core`, home)).toBe(
      "~/git/AgenC/agenc-core",
    );
  });

  test("leaves non-home paths absolute", () => {
    expect(compactCwd("/var/tmp/work", "/home/someone")).toBe("/var/tmp/work");
  });

  test("does not treat a sibling prefix as the home dir", () => {
    // "/home/me-other" must NOT be relativized against home "/home/me".
    expect(compactCwd("/home/me-other/x", "/home/me")).toBe("/home/me-other/x");
  });

  test("basename of a relativized path is the trailing segment", () => {
    expect(basenameOf("~/git/AgenC/agenc-core")).toBe("agenc-core");
    expect(basenameOf("/var/tmp/work")).toBe("work");
  });
});

describe("isDangerousPermissionMode", () => {
  test("flags elevated/auto modes", () => {
    expect(isDangerousPermissionMode("bypassPermissions")).toBe(true);
    expect(isDangerousPermissionMode("unattended")).toBe(true);
    expect(isDangerousPermissionMode("dontAsk")).toBe(true);
    expect(isDangerousPermissionMode("auto")).toBe(true);
  });

  test("does not flag normal modes", () => {
    expect(isDangerousPermissionMode("default")).toBe(false);
    expect(isDangerousPermissionMode("acceptEdits")).toBe(false);
    expect(isDangerousPermissionMode("plan")).toBe(false);
  });
});

describe("selectStripSegments degradation", () => {
  const parts = {
    model: "test-model-xyz",
    mode: "default" as PermissionMode,
    modeLabel: "default",
    cwd: "~/git/AgenC/agenc-core",
    cwdBasename: "agenc-core",
    dangerous: false,
  };

  test("shows everything when there is room", () => {
    const seg = selectStripSegments(parts, 80);
    expect(seg).not.toBeNull();
    expect(seg?.model).toBe("test-model-xyz");
    expect(seg?.modeLabel).toBe("default");
    expect(seg?.cwd).toBe("~/git/AgenC/agenc-core");
  });

  test("drops full cwd to basename first under pressure", () => {
    // Wide enough for model + mode + basename, not the full path.
    const full = "test-model-xyz".length + 3 + "default".length + 3 + "agenc-core".length;
    const seg = selectStripSegments(parts, full);
    expect(seg?.cwd).toBe("agenc-core");
    expect(seg?.modeLabel).toBe("default");
  });

  test("drops cwd entirely, then the mode, keeping the model", () => {
    const modelOnly = selectStripSegments(parts, "test-model-xyz".length + 1);
    expect(modelOnly?.model).toBe("test-model-xyz");
    expect(modelOnly?.modeLabel).toBeNull();
    expect(modelOnly?.cwd).toBeNull();

    const modelPlusMode = selectStripSegments(
      parts,
      "test-model-xyz".length + 3 + "default".length,
    );
    expect(modelPlusMode?.modeLabel).toBe("default");
    expect(modelPlusMode?.cwd).toBeNull();
  });

  test("never returns a combination wider than the budget", () => {
    for (let available = 0; available <= 60; available += 1) {
      const seg = selectStripSegments(parts, available);
      if (seg === null) continue;
      let width = seg.model.length;
      if (seg.modeLabel !== null) width += 3 + seg.modeLabel.length;
      if (seg.cwd !== null) width += 3 + seg.cwd.length;
      expect(width).toBeLessThanOrEqual(available);
    }
  });

  test("returns null when nothing fits", () => {
    expect(selectStripSegments(parts, 0)).toBeNull();
  });
});

describe("WorkbenchStatusBar context strip rendering", () => {
  test("shows model, permission mode, and a compact cwd at a wide width", async () => {
    const { getCwdState } = await import("../../src/bootstrap/state.js");
    const out = await renderStatusBar(120, { mode: "default" });
    expect(out).toContain(TEST_MODEL);
    expect(out).toContain("default");
    // Compact cwd: the basename of the session cwd (the same stable source the
    // strip reads) is present; the strip never shows the full long path raw.
    const expectedCwd = compactCwd(getCwdState());
    const tail = basenameOf(expectedCwd);
    expect(out).toContain(tail);
  });

  test("shows the dangerous mode label (bypass) when elevated", async () => {
    const out = await renderStatusBar(120, { mode: "bypassPermissions" });
    expect(out).toContain(TEST_MODEL);
    // permissionModeShortTitle("bypassPermissions") === "Bypass" -> lowercased.
    expect(out).toContain("bypass");
  });

  test("the title label is always present alongside the strip", async () => {
    const out = await renderStatusBar(120);
    expect(out).toContain("AgenC Workbench");
  });
});

describe("WorkbenchContextStrip dangerous-mode styling (ANSI)", () => {
  async function renderStripAnsi(
    mode: PermissionMode,
    available = 80,
  ): Promise<string> {
    const { renderToAnsiString } = await import("../../src/utils/staticRender.js");
    return renderToAnsiString(
      <AppStateProvider initialState={stateWith({ mode })}>
        <Box width={available + 4}>
          <WorkbenchContextStrip available={available} />
        </Box>
      </AppStateProvider>,
      // color: true forces chalk into truecolor mode so theme colors emit SGR
      // codes we can assert on (otherwise the PassThrough render is colorless).
      { columns: available + 4, rows: 3, color: true },
    );
  }

  // Count SGR escape sequences so we can prove the dangerous render carries
  // strictly more styling than the all-dim normal render.
  function sgrCount(out: string): number {
    return (out.match(/\u001b\[[0-9;]*m/gu) ?? []).length;
  }

  test("dangerous mode uses the warning color; normal mode does not", async () => {
    // Dark theme 'warning' resolves to truecolor amber (rgb(255,151,72)).
    const WARNING_SGR = "\u001b[38;2;255;151;72m";
    const dangerous = await renderStripAnsi("bypassPermissions");
    const normal = await renderStripAnsi("default");

    // Both render the model + mode label; only the dangerous one styles the
    // mode segment in the warning color.
    expect(dangerous).toContain("bypass");
    expect(normal).toContain("default");
    expect(dangerous).toContain(WARNING_SGR);
    expect(normal).not.toContain(WARNING_SGR);
    // The warning styling is *extra*, so the dangerous render has more SGR codes.
    expect(sgrCount(dangerous)).toBeGreaterThan(sgrCount(normal));
  });
});

describe("WorkbenchContextStrip never overflows the row", () => {
  // Render the full status bar (left label + strip) at a sweep of widths and
  // assert no rendered line exceeds the viewport width. This is the bug class
  // we keep fixing: chrome that bleeds past the column budget.
  for (const columns of [20, 28, 36, 48, 64, 80, 100, 120, 160]) {
    test(`fits within ${columns} columns (default mode)`, async () => {
      const out = await renderStatusBar(columns, { mode: "default" });
      for (const line of out.split("\n")) {
        expect([...line.replace(/\s+$/u, "")].length).toBeLessThanOrEqual(columns);
      }
    });

    test(`fits within ${columns} columns (dangerous mode + long cwd)`, async () => {
      const out = await renderStatusBar(columns, { mode: "unattended" });
      for (const line of out.split("\n")) {
        expect([...line.replace(/\s+$/u, "")].length).toBeLessThanOrEqual(columns);
      }
    });
  }
});

describe("WorkbenchContextStrip revert sensitivity (present vs absent)", () => {
  // When no column budget reaches the strip (status bar omits it), the strip's
  // values must be absent — proving the strip is what surfaces them.
  test("strip absent when no columns are available to it", async () => {
    const tiny = await renderToString(
      <AppStateProvider initialState={stateWith({ model: TEST_MODEL, mode: "default" })}>
        {/* columns omitted -> stripAvailable = 0 -> strip not rendered */}
        <WorkbenchStatusBar />
      </AppStateProvider>,
      { columns: 120, rows: 3 },
    );
    const wide = await renderStatusBar(120, { model: TEST_MODEL, mode: "default" });

    // The same app state, but the model only appears once the strip has room.
    expect(statusRow(tiny)).not.toContain(TEST_MODEL);
    expect(statusRow(wide)).toContain(TEST_MODEL);
    // The title label is present in both (it is not part of the strip).
    expect(tiny).toContain("AgenC Workbench");
  });

  test("a bare strip with zero budget renders nothing", async () => {
    const out = await renderToString(
      <AppStateProvider initialState={stateWith({ mode: "default" })}>
        <Box>
          <Text>EDGE</Text>
          <WorkbenchContextStrip available={0} />
        </Box>
      </AppStateProvider>,
      { columns: 40, rows: 3 },
    );
    expect(out).toContain("EDGE");
    expect(out).not.toContain(TEST_MODEL);
  });
});
