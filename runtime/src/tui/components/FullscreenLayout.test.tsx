import { describe, expect, test } from "vitest";
import React from "react";

import {
  calculateFullscreenLayoutBudget,
  calculateModalViewport,
  DesignTopChrome,
  formatDesignBottomChromeLabels,
  isNoColorEnv,
} from "./FullscreenLayout.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import { renderToString } from "../../utils/staticRender.js";

describe("FullscreenLayout modal viewport", () => {
  test.each([0, 1, 2, 3])(
    "clamps modal rows and maxHeight for tiny terminal height %i",
    (rows) => {
      const viewport = calculateModalViewport(rows, 3);

      expect(viewport.rows).toBeGreaterThanOrEqual(0);
      expect(viewport.columns).toBeGreaterThanOrEqual(0);
      expect(viewport.maxHeight).toBeGreaterThanOrEqual(0);
    },
  );

  test("preserves normal modal sizing on larger terminals", () => {
    expect(calculateModalViewport(24, 100)).toEqual({
      rows: 21,
      columns: 96,
      maxHeight: 22,
    });
  });

  test.each([
    [0, { showTopChrome: false, showScrollable: false, showBottomChrome: false, bottomMaxHeight: 1 }],
    [1, { showTopChrome: false, showScrollable: false, showBottomChrome: false, bottomMaxHeight: 1 }],
    [3, { showTopChrome: false, showScrollable: true, showBottomChrome: false, bottomMaxHeight: 2 }],
    [5, { showTopChrome: false, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 2 }],
    [8, { showTopChrome: true, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 2 }],
    [24, { showTopChrome: true, showScrollable: true, showBottomChrome: true, bottomMaxHeight: 10 }],
  ])("keeps a positive bottom slot budget at terminal height %i", (rows, expected) => {
    expect(calculateFullscreenLayoutBudget(rows)).toEqual(expected);
  });

  test("detects no-color terminal modes", () => {
    expect(isNoColorEnv({ NO_COLOR: "1" })).toBe(true);
    expect(isNoColorEnv({ FORCE_COLOR: "0" })).toBe(true);
    expect(isNoColorEnv({ TERM: "dumb" })).toBe(true);
    expect(isNoColorEnv({ TERM: "xterm-256color" })).toBe(false);
  });

  test("renders v2 top chrome without fake error and warning labels", async () => {
    const output = await renderToString(
      <DesignTopChrome columns={100} noColor={true} />,
      100,
    );

    expect(output).toContain("agenc");
    expect(output).toContain("agenc · orchestrator");
    expect(output).toContain("mode · default");
    expect(output).toContain("task");
    expect(output).not.toContain("ERR");
    expect(output).not.toContain("WARN");
    expect(output).not.toContain("ERR WARN OK");
    expect(output).not.toContain("TASK SYSTEMIC");
  });

  test("renders the header mode pill from AppState permission mode", async () => {
    const state = getDefaultAppState();
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...state,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            mode: "plan",
          },
        }}
      >
        <DesignTopChrome columns={100} noColor={false} />
      </AppStateProvider>,
      100,
    );

    expect(output).toContain("mode · plan");
  });

  test("formats bottom chrome with user-facing mode labels", () => {
    expect(
      formatDesignBottomChromeLabels(100, "grok-4-fast", "bypassPermissions"),
    ).toEqual({
      left: "MODEL grok-4-fast",
      right: "MODE YOLO  CONTEXT live",
    });

    expect(
      formatDesignBottomChromeLabels(60, "grok-4-fast", "acceptEdits"),
    ).toEqual({
      left: "grok-4-fast",
      right: "accept edits on",
    });
  });
});
