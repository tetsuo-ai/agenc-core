import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  autoCompactEnabled: false,
  percentLeft: 7,
  suppressWarning: false,
  upgradeMessage: "/model sonnet[1m]",
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../services/compact/autoCompact.js", () => ({
  calculateTokenWarningState: () => ({
    isAboveAutoCompactThreshold: false,
    isAboveErrorThreshold: false,
    isAboveWarningThreshold: true,
    isAtBlockingLimit: false,
    percentLeft: harness.percentLeft,
  }),
  getEffectiveContextWindowSize: () => 200_000,
  isAutoCompactEnabled: () => harness.autoCompactEnabled,
}));

vi.mock("../../services/compact/compactWarningHook.js", () => ({
  useCompactWarningSuppression: () => harness.suppressWarning,
}));

vi.mock("../../services/contextCollapse/index.js", () => ({
  isContextCollapseEnabled: () => false,
}));

vi.mock("../../utils/model/contextWindowUpgradeCheck.js", () => ({
  getUpgradeMessage: () => harness.upgradeMessage,
}));

import { renderToString } from "../../utils/staticRender.js";
import { createRoot } from "../ink.js";
import { getInkInstance } from "../ink/instances.js";
import { cellAt } from "../ink/screen.js";
import { TokenWarning } from "./TokenWarning.js";

describe("TokenWarning coverage", () => {
  test("renders the manual compact warning with upgrade guidance", async () => {
    const output = await renderToString(
      <TokenWarning tokenUsage={193_000} model="sonnet" />,
      120,
    );

    expect(output).toContain("Context low (7% remaining)");
    expect(output).toContain("/model sonnet[1m]");
    expect(output).not.toContain("Run /compact to compact & continue");
  });

  test("refreshes manual and auto compact warning text on rerender", async () => {
    harness.autoCompactEnabled = false;
    harness.percentLeft = 7;
    harness.upgradeMessage = null;
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<TokenWarning tokenUsage={193_000} model="sonnet" />);
      await sleep();

      expect(screenText(stdout)).toContain("Context low (7% remaining)");

      harness.autoCompactEnabled = true;
      root.render(<TokenWarning tokenUsage={193_000} model="sonnet" />);
      await sleep();

      expect(screenText(stdout)).toContain("7% until auto-compact");
      expect(screenText(stdout)).not.toContain("Context low (7% remaining)");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});

function sleep(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function screenText(stdout: PassThrough): string {
  const instance = getInkInstance(stdout);
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      line += cellAt(screen, x, y)?.char ?? " ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
