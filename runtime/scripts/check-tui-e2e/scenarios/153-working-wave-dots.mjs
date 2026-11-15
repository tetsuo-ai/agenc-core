/**
 * While a turn runs, three dots light up left to right before the verb, and a
 * running tool row breathes on one dot. No star frames are drawn.
 *
 * Owner pick (2026-11-14, mockup C "Wave"): the Working line starts with three
 * dots lit in the accent one after another, the word itself holds still, a
 * running tool or agent row shows a dot that fades between two grays, and a
 * finished row keeps a solid dot.
 */
import assert from "node:assert/strict";

import { renderPtyRows } from "../harness.mjs";

export const meta = {
  description: "The Working line shows the three-dot wave, a running tool breathes on one dot, and no star glyph appears.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 90_000,
  // The wave is a change of color. A bare CI=1 (no known CI vendor) turns
  // color off, so the scenario asks for it instead of taking it from the host.
  env: { FORCE_COLOR: "3" },
};

const STARS = /[✢✳✶✻✽]/u;
const DOT_COLOR = /\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m•/gu;

export default async function (session) {
  session.cols = 100;
  session.rows = 30;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  const from = session.raw.length;
  // The shell keeps the command for about a second before it moves it to the
  // background, so the turn shows the Working line and a running tool row.
  await session.submit("Use the Bash tool to run exactly: sleep 4; echo wave-done");
  await session.waitFor(/••• \S/u, { timeout: 30_000, label: "the wave dots before the verb" });
  const rows = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
  const frame = rows.join("\n");
  assert.ok(rows.some((row) => /^\s*••• \S/u.test(row)), `no Working line with the three dots:\n${frame}`);

  await session.waitForIdle({ idleWindow: 2_000, timeout: 30_000 });
  // What is drawn in the window: the terminal title (an OSC sequence) is left out.
  const turn = session.raw.slice(from).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "");
  // The dots change tone as the light moves across them.
  const tones = new Set([...turn.matchAll(DOT_COLOR)].map((match) => match[0]));
  assert.ok(tones.size >= 2, `the wave dots do not change tone (${tones.size} tone seen)`);
  const after = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
  const afterFrame = after.join("\n");
  assert.ok(!STARS.test(turn), `a star glyph was drawn:\n${afterFrame}`);
  assert.ok(!after.some((row) => /^\s*••• \S/u.test(row)), `the wave is still on screen after the turn:\n${afterFrame}`);
  assert.ok(after.some((row) => /^\s*● Ran sleep 4/u.test(row)), `the finished tool row has no solid dot:\n${afterFrame}`);
}
