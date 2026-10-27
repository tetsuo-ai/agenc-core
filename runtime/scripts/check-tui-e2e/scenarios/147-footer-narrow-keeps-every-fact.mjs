/**
 * A 40-column terminal keeps every status line fact and the ZDR badge.
 *
 * Owner request (2026-10-22): the footer must fit its content to the width so
 * everything stays visible at a small width, and show a ZDR badge. Before,
 * a narrow status line dropped the cache share, the folder, the effort and
 * the off-peak note, and at 40 columns could cut the model name to nothing.
 *
 * The gate's model is an OpenAI-compatible server on 127.0.0.1, which could be a
 * proxy to a cloud API, so the badge reads ZDR? (unknown). After a
 * turn the line has a folder, model, mode, context share and spend; at 40
 * columns they take short forms and the usage block moves to a second row,
 * right under the first, with the prompt above both.
 */
import assert from "node:assert/strict";

import { renderPtyRows } from "../harness.mjs";

export const meta = {
  description: "A 40-column status line keeps every fact and the ZDR badge on two rows.",
  timeoutMs: 60_000,
};

export default async function (session) {
  session.cols = 40;
  session.rows = 24;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submit("Reply with the single word ALPHA");
  await session.waitForAssistantReply({ timeout: 30_000 });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });

  const rows = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
  const filled = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.trim().length > 0);
  const [first, second] = filled.slice(-2);
  const frame = rows.join("\n");
  assert.ok(first !== undefined && second !== undefined, `no status line in:\n${frame}`);
  // Two rows, one under the other: facts on the first, usage and the badge on the second.
  assert.equal(second.index, first.index + 1, `the status rows are not adjacent:\n${frame}`);
  assert.match(first.row, /project · local-pi[^\s]*model · asks\s*$/u, `first status row:\n${frame}`);
  assert.match(second.row, /ctx \d+% · \$0\.00\d* · ZDR\?\s*$/u, `second status row:\n${frame}`);
  // The prompt stays above the status line, not under or over it.
  const prompt = rows.findIndex((row) => row.includes("❯") && !row.includes("ALPHA") && !row.includes("Reply"));
  assert.ok(prompt >= 0 && prompt < first.index, `the prompt is not above the status line:\n${frame}`);
  for (const row of rows) assert.ok(row.length <= session.cols, `a row is wider than the terminal: ${row}`);
}
