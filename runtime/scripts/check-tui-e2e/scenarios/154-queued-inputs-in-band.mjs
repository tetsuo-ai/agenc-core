/**
 * Queued inputs wait inside the prompt band (owner pick 2026-11-14, queue
 * option A "In the input box"), in the dark and the light theme.
 *
 * While a slow streamed reply holds the turn, seven inputs are typed. The band
 * must show, above the input line: a "next" header with the drop hint at the
 * right, five numbered entries (a long one wraps under its own first
 * character), one row that counts the other two, and a hairline. Dropping the
 * last input with ctrl+x backspace leaves one counted. On a 40-column
 * terminal the hint goes before any entry is cut. When the turn ends every
 * remaining input is sent and the band is back to its usual height.
 */
import assert from "node:assert/strict";

import { renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "Queued inputs sit in the prompt band: header, five entries, a count, a hairline; drop-last and a narrow width work, in dark and light.",
  timeoutMs: 240_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HINT = "ctrl+x backspace drops the last";
/** Band margin 2, band padding 1, then the two cells of "❯ ". */
const INSET = "     ";
const LONG =
  "please check the vbmeta flags too and then flash boot_b with the patched image, reboot into slot b and tell me if root works";
const SHORT = [2, 3, 4, 5, 6, 7].map((n) => `queued input ${n}`);
const rowsOf = (session) =>
  renderCellFrame(session.raw, { cols: session.cols, rows: session.rows }).map((row) => row.text);

async function setTheme(session, name) {
  await session.submitSlashCommand(`/theme ${name}`);
  await session.waitFor(new RegExp(`Theme set to ${name}`, "u"), { timeout: 15_000, label: `theme ${name}` });
  await session.waitForIdle({ idleWindow: 1_000, timeout: 15_000 });
}

async function typeAndQueue(session, text) {
  await session.type(text, { perCharMs: 3 });
  await sleep(60);
  session.send("\r");
  await sleep(120);
}

async function resize(session, cols) {
  session.term.resize(cols, session.rows);
  session.cols = cols;
  await sleep(900);
}

async function round(session, theme) {
  await setTheme(session, theme);
  // A slow streamed reply (about 11 s) holds the turn while inputs queue.
  await session.submit("Reply with the slow streamed markdown fixture owner-session");
  await session.waitFor(/Estado/u, { timeout: 30_000, label: `${theme} stream started` });
  for (const text of [LONG, ...SHORT]) await typeAndQueue(session, text);
  await sleep(400);

  let rows = rowsOf(session);
  let picture = rows.join("\n");
  const label = `${theme}:`;
  const header = rows.findIndex((row) => row.startsWith(`${INSET}next `) && row.trimEnd().endsWith(HINT));
  assert.ok(header >= 0, `${label} no "next" header with the drop hint in the band:\n${picture}`);
  assert.ok(!rows.some((row) => row.includes("queued for next turn")), `${label} the old list above the prompt is drawn:\n${picture}`);
  assert.ok(rows[header + 1].startsWith(`${INSET}1  please check the vbmeta`), `${label} the long entry does not start with its first character:\n${picture}`);
  assert.ok(rows[header + 2].startsWith(`${INSET}   `) && rows[header + 2].trim().length > 0, `${label} the long entry does not hang under its text:\n${picture}`);
  assert.deepEqual(
    rows.slice(header + 3, header + 8).map((row) => row.trimEnd()),
    [
      `${INSET}2  queued input 2`,
      `${INSET}3  queued input 3`,
      `${INSET}4  queued input 4`,
      `${INSET}5  queued input 5`,
      `${INSET}   2 more queued`,
    ],
    `${label} five entries and a count are not listed in order:\n${picture}`,
  );
  assert.match(rows[header + 8].trim(), /^─+$/u, `${label} no hairline under the entries:\n${picture}`);
  assert.ok(rows[header + 9].includes("❯"), `${label} the input line is not right under the hairline:\n${picture}`);

  // Drop the last queued input: one is still counted.
  session.send("\x18");
  await sleep(100);
  session.send("\x7f");
  await sleep(500);
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(rows.some((row) => row.trimEnd() === `${INSET}   1 more queued`), `${label} the count did not drop to one:\n${picture}`);

  // A narrow terminal drops the hint before it cuts an entry.
  await resize(session, 40);
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(!rows.some((row) => row.includes(HINT)), `${label} the hint is still shown at 40 columns:\n${picture}`);
  const narrow = rows.findIndex((row) => row.trimEnd() === `${INSET}next`);
  assert.ok(narrow >= 0, `${label} no bare "next" header at 40 columns:\n${picture}`);
  assert.ok(rows[narrow + 1].startsWith(`${INSET}1  please`), `${label} the first entry is cut at 40 columns:\n${picture}`);
  await resize(session, 100);

  // The turn ends; every remaining input is sent and the band shrinks back.
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(!rows.some((row) => row.includes(HINT)), `${label} the queue is still shown after it was sent:\n${picture}`);
  assert.ok(!rows.some((row) => row.startsWith(`${INSET}next`)), `${label} the band still holds the queue header:\n${picture}`);
  assert.ok(rows.some((row) => row.trimStart().startsWith("queued input 6")), `${label} the last remaining input was not sent:\n${picture}`);
}

export default async function (session) {
  session.cols = 100;
  session.rows = 44;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await round(session, "dark");
  await round(session, "light");
}
