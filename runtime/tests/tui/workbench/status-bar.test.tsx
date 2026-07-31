import React from "react";
import { describe, expect, test } from "vitest";

import { Box, Text } from "../../../src/tui/ink.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../../src/tui/state/AppState.js";
import { WorkbenchStatusBar } from "../../../src/tui/workbench/WorkbenchStatusBar.js";
import type { PermissionMode } from "../../../src/permissions/types.js";
import { renderToString } from "../../../src/utils/staticRender.js";
import { VERSION } from "../../../src/version.js";

const TEST_MODEL = "test-model-xyz";

function stateWith(mode: PermissionMode = "default"): AppState {
  const base = getDefaultAppState();
  return {
    ...base,
    mainLoopModelForSession: TEST_MODEL,
    toolPermissionContext: {
      ...base.toolPermissionContext,
      mode,
    },
  };
}

function renderStatusBar(
  columns: number,
  mode: PermissionMode = "default",
): Promise<string> {
  return renderToString(
    <AppStateProvider initialState={stateWith(mode)}>
      <WorkbenchStatusBar columns={columns} />
    </AppStateProvider>,
    { columns, rows: 3 },
  );
}

describe("WorkbenchStatusBar", () => {
  test("keeps the fixed title row under tall transcript pressure", async () => {
    const pressured = await renderToString(
      <AppStateProvider initialState={stateWith()}>
        <Box flexDirection="column" height={3} overflow="hidden">
          <WorkbenchStatusBar columns={80} />
          <Box height={3} flexShrink={0}>
            <Text>TRANSCRIPT BODY</Text>
          </Box>
        </Box>
      </AppStateProvider>,
      { columns: 80, rows: 3 },
    );
    const shrinkableControl = await renderToString(
      <Box flexDirection="column" height={3} overflow="hidden">
        <Box height={1}>
          <Text>SHRINKABLE TITLE</Text>
        </Box>
        <Box height={3} flexShrink={0}>
          <Text>TRANSCRIPT BODY</Text>
        </Box>
      </Box>,
      { columns: 80, rows: 3 },
    );

    expect(pressured).toContain("agenc");
    expect(pressured).toContain("WORKBENCH");
    expect(shrinkableControl).not.toContain("SHRINKABLE TITLE");
  });

  test("shows the active model and runtime version in a wide title bar", async () => {
    const output = await renderStatusBar(120);

    expect(output).toContain("agenc");
    expect(output).toContain("WORKBENCH");
    expect(output).toContain(TEST_MODEL);
    expect(output).toContain(VERSION);
  });

  test.each([
    ["default", "default"],
    ["plan", "plan"],
    ["bypassPermissions", "bypass"],
  ] as const)(
    "does not duplicate the %s permission mode in title chrome",
    async (mode, label) => {
      const output = await renderStatusBar(120, mode);

      expect(output).toContain(TEST_MODEL);
      expect(output).not.toContain(label);
    },
  );

  test.each([20, 28, 36, 48, 64, 80, 100, 120, 160])(
    "stays within a %i-column viewport",
    async (columns) => {
      const output = await renderStatusBar(columns);

      for (const line of output.split("\n")) {
        expect([...line.replace(/\s+$/u, "")].length).toBeLessThanOrEqual(
          columns,
        );
      }
    },
  );
});
