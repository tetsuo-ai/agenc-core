import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FullscreenLayout } from "./FullscreenLayout.js";
import { FullscreenModeProvider } from "../context/fullscreenModeContext.js";
import { SessionUsageContext } from "../context/sessionUsageContext.js";
import { AppStateProvider, getDefaultAppState } from "../state/AppState.js";
import { Text } from "../ink.js";
import { renderToString } from "../../utils/staticRender.js";

const mocks = vi.hoisted(() => ({ getTotalCost: vi.fn(() => 9) }));

vi.mock("../../cost/tracker.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../cost/tracker.js")>(),
  getTotalCost: mocks.getTotalCost,
}));

beforeEach(() => mocks.getTotalCost.mockClear());
afterEach(() => vi.restoreAllMocks());

describe("alternate fullscreen canonical spend", () => {
  test.each([
    [{ costUsd: 1.25, hasUnknownCost: false }, "$1.25"],
    [{ costUsd: 0, hasUnknownCost: false }, "$0.00"],
    [{ costUsd: 0.5, hasUnknownCost: true }, "$0.500 +?"],
    [null, "—"],
  ] as const)("renders the scoped snapshot %j without sidecar polling", async (usage, label) => {
    const timer = vi.spyOn(globalThis, "setInterval");
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <SessionUsageContext value={usage}>
          <FullscreenModeProvider enabled>
            <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
          </FullscreenModeProvider>
        </SessionUsageContext>
      </AppStateProvider>,
      { columns: 100, rows: 24 },
    );
    expect(output).toContain(`spend ${label}`);
    expect(mocks.getTotalCost).not.toHaveBeenCalled();
    expect(timer.mock.calls.some((call) => call[1] === 5_000)).toBe(false);
  });

  test("retains the sidecar fallback outside a daemon usage provider", async () => {
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <FullscreenModeProvider enabled>
          <FullscreenLayout scrollable={<Text>ready</Text>} bottom={<Text>prompt</Text>} />
        </FullscreenModeProvider>
      </AppStateProvider>,
      { columns: 100, rows: 24 },
    );
    expect(output).toContain("spend $9.00");
    expect(mocks.getTotalCost).toHaveBeenCalled();
  });
});
