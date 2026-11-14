/**
 * A sent message sits in a band with one empty row above and one below.
 *
 * Owner report (2026-11-14): "❯ hi" in its band looked cramped. The band now
 * has an empty row of the same fill above and below the text, the same height
 * as the prompt band it was typed in, in the dark and the light theme.
 */
import assert from "node:assert/strict";

import { renderPtyRows } from "../harness.mjs";

export const meta = {
  description: "A sent message band has one empty band row above and below its text, dark and light.",
  timeoutMs: 90_000,
  // The band is a background color. A bare CI=1 (no known CI vendor) turns
  // color off, so the scenario asks for it instead of taking it from the host.
  env: { FORCE_COLOR: "3" },
};

const MESSAGE = "Reply with the single word ALPHA";

function checkBand(session, label) {
  const rows = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows, background: true });
  const fills = rows.backgrounds;
  const frame = rows.join("\n");
  const sent = rows.findIndex((row) => row.includes(MESSAGE));
  assert.ok(sent >= 2 && sent + 2 < rows.length, `${label}: the sent message is not on screen:\n${frame}`);
  const textColumn = rows[sent].indexOf(MESSAGE);
  const band = fills[sent][textColumn];
  assert.notEqual(band, "", `${label}: the sent message has no band:\n${frame}`);
  for (const row of [sent - 1, sent + 1]) {
    assert.equal(rows[row].trim(), "", `${label}: row ${row} next to the message is not empty:\n${frame}`);
    assert.equal(fills[row][textColumn], band, `${label}: row ${row} is not part of the band:\n${frame}`);
  }
  for (const row of [sent - 2, sent + 2]) {
    assert.notEqual(fills[row][textColumn], band, `${label}: the band is taller than one row each side at row ${row}:\n${frame}`);
  }
}

export default async function (session) {
  session.cols = 100;
  session.rows = 30;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submit(MESSAGE);
  await session.waitForAssistantReply({ timeout: 30_000 });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
  checkBand(session, "default theme");

  for (const theme of ["dark", "light"]) {
    await session.submitSlashCommand(`/theme ${theme}`);
    await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });
    checkBand(session, theme);
  }
}
