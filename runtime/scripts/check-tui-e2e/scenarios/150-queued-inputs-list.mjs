/**
 * Inputs typed while a turn runs are listed by number, and the queue works.
 *
 * Owner report (2026-11-11, third screenshot): queued inputs were drawn as
 * tinted bands with a "queued" label each, and one message appeared without
 * its first letter. The list is now one gray header line and one numbered
 * entry per input, each shown from its first character.
 *
 * While the gate model streams a long reply, three inputs are typed. The
 * frame must show the header once and the three entries in order. Then the
 * last one is dropped with ctrl+x backspace, and when the turn ends the two
 * that remain are sent, in order.
 */
import assert from "node:assert/strict";

import { renderCellFrame } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "Queued inputs are listed by number from their first character; drop last and send on next turn still work.",
  timeoutMs: 120_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HEADER = "queued for next turn · ctrl+x backspace drops the last";
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
  const header = rows.findIndex((row) => row.includes(HEADER));
  assert.ok(header >= 0, `no queued inputs header in the frame:\n${picture}`);
  assert.equal(rows.filter((row) => row.includes("queued for next turn")).length, 1, `the header is shown more than once:\n${picture}`);
  assert.deepEqual(
    rows.slice(header + 1, header + 4),
    [`  1  ${FIRST}`, "  2  check now ✅", "  3  drop me"],
    `the entries are not listed in order from their first character:\n${picture}`,
  );
  assert.equal(rows[header - 1].trim(), "", `no blank row above the list:\n${picture}`);
  assert.ok(!rows.slice(header, header + 4).some((row) => row.includes("❯")), `an entry carries a prompt arrow:\n${picture}`);

  // Drop the last queued input.
  session.send("\x18");
  await sleep(100);
  session.send("\x7f");
  await sleep(500);
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(rows.some((row) => row.includes("2  check now ✅")), `the second input is gone after the drop:\n${picture}`);
  assert.ok(!rows.some((row) => row.includes("drop me")), `the last input was not dropped:\n${picture}`);

  // When the turn ends the queued inputs are sent, in order.
  await session.waitForIdle({ idleWindow: 4_000, timeout: 60_000 });
  rows = rowsOf(session);
  picture = rows.join("\n");
  assert.ok(!rows.some((row) => row.includes("queued for next turn")), `the list is still shown after the queue was sent:\n${picture}`);
  const sentFirst = rows.findIndex((row) => row.includes(`❯ ${FIRST}`));
  assert.ok(sentFirst >= 0, `the first queued input was not sent from its first character:\n${picture}`);
  const sentSecond = rows.findIndex((row) => row.includes("❯ check now ✅"));
  assert.ok(sentSecond > sentFirst, `the second queued input was not sent after the first:\n${picture}`);
}
