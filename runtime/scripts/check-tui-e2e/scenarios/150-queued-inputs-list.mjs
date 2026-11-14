/**
 * Inputs typed while a turn runs are listed by number, and the queue works.
 *
 * Owner report (2026-11-11, third screenshot): queued inputs were drawn as
 * tinted bands with a "queued" label each, and one message appeared without
 * its first letter. Owner pick (2026-11-14, queue option A): the inputs wait
 * inside the prompt band, above the line the user types on, under a "next"
 * header with the drop hint at the right, then a hairline.
 *
 * While the gate model streams a long reply, three inputs are typed. The
 * frame must show the header once, the three entries in order from their
 * first character (the first one wraps under its own text), the hairline,
 * and right under it the input line. Then the last one is dropped with
 * ctrl+x backspace, and when the turn ends the two that remain are sent, in
 * order, and the band is back to its usual height.
 */
import assert from "node:assert/strict";

import { renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "Queued inputs are listed by number from their first character; drop last and send on next turn still work.",
  timeoutMs: 120_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HINT = "ctrl+x backspace drops the last";
/** Band margin 2, band padding 1, then the two cells of "❯ ". */
const INSET = "     ";
const FIRST = "START / RESTART BOOTLOADER / RECOVERY MODE / POWER OFF. what option i shoudl selecte then";
const rowsOf = (session) =>
  renderCellFrame(session.raw, { cols: session.cols, rows: session.rows }).map((row) => row.text);

async function typeAndQueue(session, text) {
  await session.type(text, { perCharMs: 4 });
  await sleep(80);
  session.send("\r");
  await sleep(120);
}

export default async function (session) {
  session.cols = 100;
  session.rows = 44;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submit("Reply with the streamed markdown fixture owner-session");
  await session.waitFor(/Estado/u, { timeout: 30_000, label: "stream started" });

  await typeAndQueue(session, FIRST);
  await typeAndQueue(session, "check now ✅");
  await typeAndQueue(session, "drop me");
  await sleep(300);

  let rows = rowsOf(session);
  let picture = rows.join("\n");
  const header = rows.findIndex((row) => row.startsWith(`${INSET}next `) && row.trimEnd().endsWith(HINT));
  assert.ok(header >= 0, `no "next" header with the drop hint in the band:\n${picture}`);
  assert.equal(rows.filter((row) => row.includes(HINT)).length, 1, `the header is shown more than once:\n${picture}`);
  assert.ok(!rows.some((row) => row.includes("queued for next turn")), `the old list above the prompt is still drawn:\n${picture}`);
  // The first input is longer than the band: it wraps under its own first character.
  const first = rows[header + 1].slice(INSET.length + 3).trimEnd() + " " + rows[header + 2].slice(INSET.length + 3).trimEnd();
  assert.ok(rows[header + 1].startsWith(`${INSET}1  START / RESTART`), `the first entry does not start with its first character:\n${picture}`);
  assert.ok(rows[header + 2].startsWith(`${INSET}   `) && rows[header + 2].trim().length > 0, `the wrapped entry does not hang under its text:\n${picture}`);
  assert.equal(first.replace(/\s+/gu, " ").trim(), FIRST, `the first entry is not shown in full:\n${picture}`);
  assert.deepEqual(
    rows.slice(header + 3, header + 5).map((row) => row.trimEnd()),
    [`${INSET}2  check now ✅`, `${INSET}3  drop me`],
    `the entries are not listed in order from their first character:\n${picture}`,
  );
  assert.match(rows[header + 5].trim(), /^─+$/u, `no hairline under the entries:\n${picture}`);
  assert.ok(rows[header + 6].includes("❯"), `the input line is not right under the hairline:\n${picture}`);
  assert.ok(!rows.slice(header, header + 6).some((row) => row.includes("❯")), `an entry carries a prompt arrow:\n${picture}`);

  // Drop the last queued input.
  session.send("\x18");
  await sleep(100);
  session.send("\x7f");
  await sleep(500);
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(rows.some((row) => row.startsWith(`${INSET}2  check now ✅`)), `the second input is gone after the drop:\n${picture}`);
  assert.ok(!rows.some((row) => row.includes("drop me")), `the last input was not dropped:\n${picture}`);

  // When the turn ends the queued inputs are sent, in order.
  await session.waitForIdle({ idleWindow: 4_000, timeout: 60_000 });
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(!rows.some((row) => row.includes(HINT)), `the queue is still shown after it was sent:\n${picture}`);
  assert.ok(!rows.some((row) => row.startsWith(`${INSET}next`)), `the band still holds the queue header:\n${picture}`);
  const sentFirst = rows.findIndex((row) => row.includes(`❯ ${FIRST}`));
  assert.ok(sentFirst >= 0, `the first queued input was not sent from its first character:\n${picture}`);
  const sentSecond = rows.findIndex((row) => row.includes("❯ check now ✅"));
  assert.ok(sentSecond > sentFirst, `the second queued input was not sent after the first:\n${picture}`);
}
