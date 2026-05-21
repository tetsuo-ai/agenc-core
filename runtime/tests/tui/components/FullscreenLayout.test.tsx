import { describe, expect, test } from "vitest";
import React from "react";

import {
  calculateFullscreenLayoutBudget,
  calculateModalViewport,
  FullscreenLayout,
  DesignTopChrome,
  formatDesignBottomChromeLabels,
  isNoColorEnv,
} from "./FullscreenLayout.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import { Box, Text } from "../ink.js";
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

  test("keeps the v2 header wordmark aligned to the design grid", async () => {
    const output = await renderToString(
      <DesignTopChrome columns={148} noColor={true} />,
      148,
    );
    const header =
      output.split(/\r?\n/u).find(line => line.includes("agenc")) ?? "";

    expect(header.indexOf("▮")).toBe(2);
    expect(header.indexOf("agenc")).toBe(4);
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

  test.each([
    ["plan", true],
    ["default", false],
    ["acceptEdits", false],
  ] as const)(
    "renders the plan banner only while permission mode is %s",
    async (mode, shouldRenderBanner) => {
      const state = getDefaultAppState();
      const output = await renderToString(
        <AppStateProvider
          initialState={{
            ...state,
            toolPermissionContext: {
              ...state.toolPermissionContext,
              mode,
            },
          }}
        >
          <FullscreenLayout
            scrollable={<Text>proposal body</Text>}
            bottom={<Text>prompt row</Text>}
          />
        </AppStateProvider>,
        { columns: 120, rows: 30 },
      );

      expect(output.includes("PLAN MODE")).toBe(shouldRenderBanner);
      expect(output.includes("AgenC will propose changes first")).toBe(
        shouldRenderBanner,
      );
    },
  );

  test("formats bottom chrome with user-facing mode labels", () => {
    expect(
      formatDesignBottomChromeLabels(100, "grok-4-fast", "bypassPermissions", "main · abc1234", "42%", "$0.04", "12.4K"),
    ).toEqual({
      left: "● YOLO · grok-4-fast · main · abc1234",
      right: "ctx 42% · spend $0.04 · ◆ 12.4K",
    });

    expect(
      formatDesignBottomChromeLabels(60, "grok-4-fast", "acceptEdits", "main · abc1234", "0%", "$0.00", "12.4K"),
    ).toEqual({
      left: "● accept edits on · grok-4-fast · main · abc1234",
      right: "ctx 0% · spend $0.00 · ◆ 12.4K",
    });
  });

  test.each([
    [148, 40],
    [120, 30],
    [80, 24],
  ])("smoke-renders the v2 frame at %ix%i", async (columns, rows) => {
    const state = getDefaultAppState();
    const output = await renderToString(
      <AppStateProvider initialState={state}>
        <FullscreenLayout
          scrollable={
            <Box flexDirection="column">
              <Text>ready.</Text>
              <Text>/help for commands · /claim for protocol tasks</Text>
            </Box>
          }
          bottom={<Text>prompt owns this row</Text>}
        />
      </AppStateProvider>,
      { columns, rows },
    );

    const lines = output.split(/\r?\n/u);
    expect(output).toContain("agenc");
    expect(output).toContain("agenc · orchestrator");
    expect(output).toContain("mode · default");
    expect(output).toContain("● default on");
    expect(output).toContain("ctx 0%");
    expect(output).toContain("spend $0.00");
    expect(output).toContain("◆ 12.4K");
    expect(output).toMatch(/[░▒▓]/u);
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("NaN");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });
});
