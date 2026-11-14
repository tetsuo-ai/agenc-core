/**
 * The closing line under a finished turn is short by default.
 *
 * Owner report (2026-11-14): "done in 2s · 1 call · input 13.9K · cached 71% ·
 * output 149" under every reply, while the footer already shows the session's
 * cache share and cost, repeats facts. The default (`tui.turnStats = "brief"`)
 * is the 0.19.32 line again: the duration, plus the model calls when there
 * were several. The live calls and input line under the working line is gone.
 */
import assert from "node:assert/strict";

import { renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "Default turn stats: the closing line is only the duration and the model calls, and no live stats line runs.",
  timeoutMs: 120_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = (session) =>
  renderCellFrame(session.raw, { cols: session.cols, rows: session.rows }).map((row) => row.text);
const LIVE_LINE = /^\s*\d+ calls?(?: · input \S+)?\s*$/u;

function closingLines(session) {
  return rowsOf(session).map((row) => row.trim()).filter((row) => row.startsWith("done in "));
}

export default async function (session) {
  session.cols = 100;
  session.rows = 40;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await session.submit("Reply with the streamed markdown fixture owner-session");
  await session.waitFor(/Estado/u, { timeout: 30_000, label: "stream started" });
  for (let i = 0; i < 6; i += 1) {
    const rows = rowsOf(session);
    const live = rows.find((row) => LIVE_LINE.test(row));
    assert.equal(live, undefined, `a live stats line is shown by default:\n${rows.join("\n")}`);
    await sleep(250);
  }
  await session.waitForIdle({ idleWindow: 3_000, timeout: 60_000 });
  let lines = closingLines(session);
  assert.ok(lines.length >= 1, `no closing line after the turn:\n${rowsOf(session).join("\n")}`);
  assert.match(lines.at(-1), /^done in \d+(?:\.\d+)?m?s$/u, `the single-call closing line is not just the duration: ${lines.at(-1)}`);

  await session.submit("Use the Bash tool to run exactly: echo turn-stats-155");
  await session.waitFor(/turn-stats-155/u, { timeout: 30_000, label: "command output" });
  await session.waitForIdle({ idleWindow: 3_000, timeout: 60_000 });
  lines = closingLines(session);
  const last = lines.at(-1) ?? "";
  assert.match(last, /^done in \d+(?:\.\d+)?m?s · \d+ model calls$/u, `the tool turn's closing line is not duration plus model calls: ${last}`);
  for (const word of ["input", "cached", "output"]) {
    assert.ok(!lines.some((line) => line.includes(word)), `the default closing line shows "${word}": ${lines.join(" | ")}`);
  }
}
