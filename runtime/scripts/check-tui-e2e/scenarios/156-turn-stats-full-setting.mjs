/**
 * `tui.turnStats = "full"` brings back the detailed numbers.
 *
 * With the setting, the closing line under a finished turn carries the model
 * calls and the input (plus the cached share and output when the provider
 * reports them), and a live calls line runs under the working line.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "tui.turnStats = full: the closing line shows calls and input, and the live calls line runs.",
  timeoutMs: 120_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = (session) =>
  renderCellFrame(session.raw, { cols: session.cols, rows: session.rows }).map((row) => row.text);
const LIVE_LINE = /^\s*\d+ calls?(?: · input \S+)?(?: · cached \d+%)?\s*$/u;

export default async function (session) {
  const configPath = join(session.gateState.agencHome, "config.toml");
  const existing = await readFile(configPath, "utf8");
  const updated = /^\[tui\]\s*$/mu.test(existing)
    ? existing.replace(/^\[tui\]\s*$/mu, '[tui]\nturnStats = "full"')
    : `${existing}\n[tui]\nturnStats = "full"\n`;
  await writeFile(configPath, updated);

  session.cols = 100;
  session.rows = 40;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await session.submit("Reply with the streamed markdown fixture owner-session");
  await session.waitFor(/Estado/u, { timeout: 30_000, label: "stream started" });
  let sawLive = false;
  for (let i = 0; i < 12 && !sawLive; i += 1) {
    sawLive = rowsOf(session).some((row) => LIVE_LINE.test(row));
    if (!sawLive) await sleep(150);
  }
  assert.ok(sawLive, `no live calls line while the turn ran:\n${rowsOf(session).join("\n")}`);
  await session.waitForIdle({ idleWindow: 3_000, timeout: 60_000 });
  const lines = rowsOf(session).map((row) => row.trim()).filter((row) => row.startsWith("done in "));
  const last = lines.at(-1) ?? "";
  assert.match(last, /^done in \d+(?:\.\d+)?m?s · 1 call · input \S+/u, `the full closing line is missing calls or input: ${last}`);
}
