import { expect, test } from "vitest";

import type { Frame } from "./frame.js";
import { LogUpdate } from "./log-update.js";
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from "./screen.js";

function collectStdout(diff: ReturnType<LogUpdate["render"]>): string {
  return diff
    .filter(
      (patch): patch is Extract<(typeof diff)[number], { type: "stdout" }> =>
        patch.type === "stdout",
    )
    .map((patch) => patch.content)
    .join("");
}

function frameFromLine(line: string): {
  readonly frame: Frame;
  readonly stylePool: StylePool;
} {
  const stylePool = new StylePool();
  const charPool = new CharPool();
  const hyperlinkPool = new HyperlinkPool();
  const screen = createScreen(
    Math.max(1, line.length),
    1,
    stylePool,
    charPool,
    hyperlinkPool,
  );
  for (const [x, char] of [...line].entries()) {
    setCellAt(screen, x, 0, {
      char,
      styleId: stylePool.none,
      width: CellWidth.Narrow,
    });
  }
  return {
    stylePool,
    frame: {
      screen,
      viewport: { width: Math.max(1, line.length), height: 10 },
      cursor: { x: 0, y: 1, visible: true },
    },
  };
}

test("force repaint keeps the incremental diff path instead of re-emitting an unchanged frame", () => {
  const { frame: prev, stylePool } = frameFromLine("same");
  const { frame: next } = frameFromLine("same");
  const log = new LogUpdate({ isTTY: true, stylePool });

  const diff = log.render(prev, next, true, true, false, true);
  const stdout = collectStdout(diff);

  expect(stdout).not.toContain("same");
  expect(diff.some((patch) => patch.type === "clearTerminal")).toBe(false);
});
