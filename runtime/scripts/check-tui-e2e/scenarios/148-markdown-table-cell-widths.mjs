/**
 * A Markdown table with emoji keeps its borders in line.
 *
 * Owner report (2026-11-11): in a table of the chat transcript, the rows
 * whose second cell was a check mark emoji (U+2705) had a stray vertical bar
 * inside the third cell and a right border out of place; the rows with an
 * hourglass (U+23F3) were right. U+2705 was counted as one cell, but a
 * terminal draws it in two, so every cell after it moved one place.
 *
 * The gate model replies with that table. The frame is read in terminal
 * cells (helpers/cell-frame.mjs) and must show every table line with the
 * same width and every vertical border under a joint of the top rule. This
 * is checked at 120 and 80 columns, in the dark and the light theme, and
 * after a resize in both directions while the table is on screen.
 */
import assert from "node:assert/strict";

import { MARKDOWN_REPLY_FIXTURES } from "../../local-openai-compatible-mock.mjs";
import { columnsOf, renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "A table with emoji keeps its borders in line at 80 and 120 columns, dark and light, across a resize.",
  timeoutMs: 180_000,
};

const ROWS = 60;
const JOINTS = "┌┬┐├┼┤└┴┘";
const squeeze = (text) => text.replace(/\s+/gu, "");

// What the cells show: the Markdown without the pipes, the rule and the
// backticks of inline code.
const TABLE_TEXT = squeeze(
  MARKDOWN_REPLY_FIXTURES["owner-table"]
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("|---"))
    .join("")
    .replace(/[|`]/gu, ""),
);

const sorted = (text) => Array.from(text).sort().join("");

/** Check the table in the frame drawn since `from` (an offset into the raw output). */
function checkTable(session, from, label) {
  const frame = renderCellFrame(session.raw.slice(from), { cols: session.cols, rows: session.rows });
  const picture = frame.map((row) => row.text).join("\n");
  // The rules with column joints belong to the table; a notice box has none.
  const top = frame.findLastIndex((row) => row.cells.includes("┬"));
  const bottom = frame.findLastIndex((row) => row.cells.includes("┴"));
  assert.ok(top >= 0 && bottom > top, `${label}: no table box in the frame:\n${picture}`);
  const table = frame.slice(top, bottom + 1);

  const joints = columnsOf(table[0].cells, JOINTS);
  assert.equal(joints.length, 4, `${label}: the top rule does not have three columns:\n${picture}`);
  const width = table[0].cells.length;
  assert.ok(width <= session.cols, `${label}: the table is wider than the terminal:\n${picture}`);

  let shown = "";
  for (const row of table) {
    assert.equal(row.cells.length, width, `${label}: a table line has another width: ${row.text}\n${picture}`);
    const isRule = JOINTS.includes(row.cells[joints[0]]);
    assert.deepEqual(
      columnsOf(row.cells, isRule ? JOINTS : "│"),
      joints,
      `${label}: borders are not in the columns of the top rule: ${row.text}\n${picture}`,
    );
    if (!isRule) shown += row.text.replace(/│/gu, "");
  }

  // Every character of every cell is on screen once: none lost, none doubled.
  assert.equal(sorted(squeeze(shown)), sorted(TABLE_TEXT), `${label}: the cells do not hold the table text:\n${picture}`);
  const count = (mark) => table.filter((row) => row.text.includes(mark)).length;
  assert.equal(count("✅"), 3, `${label}: expected three check mark rows:\n${picture}`);
  assert.equal(count("⏳"), 3, `${label}: expected three hourglass rows:\n${picture}`);
}

async function setTheme(session, name) {
  await session.submitSlashCommand(`/theme ${name}`);
  await session.waitFor(new RegExp(`Theme set to ${name}`, "u"), { timeout: 15_000, label: `theme ${name}` });
  await session.waitForIdle({ idleWindow: 1_000, timeout: 15_000 });
}

/** Resize the terminal and return the offset where the redraw starts. */
async function resize(session, cols) {
  const from = session.raw.length;
  session.term.resize(cols, session.rows);
  session.cols = cols;
  await session.waitForIdle({ idleWindow: 1_500, timeout: 20_000 });
  return from;
}

export default async function (session) {
  session.cols = 120;
  session.rows = ROWS;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await setTheme(session, "dark");

  await session.submit("Reply with the markdown fixture owner-table");
  await session.waitFor(/P6 Root/u, { timeout: 30_000, label: "table reply" });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
  checkTable(session, 0, "120 columns, dark");

  let from = await resize(session, 80);
  checkTable(session, from, "80 columns after a resize, dark");

  await setTheme(session, "light");
  checkTable(session, from, "80 columns, light");

  from = await resize(session, 120);
  checkTable(session, from, "120 columns after a resize, light");
}
