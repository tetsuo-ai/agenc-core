/**
 * The screen after a streamed message equals the same content drawn from scratch.
 *
 * Owner report (2026-11-11, second screenshot): in a live session, the lines
 * that held an emoji showed corrupted words ("ImagenpMagisk", "fmstboot",
 * "conoMagisk") and a stray letter stood at the right edge of several rows.
 * The text of the model was fine. The program and the terminal disagreed on
 * the width of an emoji, so every partial repaint wrote into cells one
 * column off and left old characters behind.
 *
 * The gate model streams a message like that one in small pieces, then runs
 * a tool with a long command line while the status line ticks. The screen is
 * read in terminal cells. Then a resize by one column and back makes the
 * program draw everything from scratch, and the two screens must be equal
 * cell by cell. This runs at 140, 120 and 160 columns, each reached by a
 * resize, on a screen short enough that the transcript scrolls.
 *
 * Terminals do not agree on the width of every emoji. The comparison is
 * therefore made four times, each time laying the same output out with
 * another width rule (helpers/cell-frame.mjs, WIDTH_PROFILES). Under the
 * Unicode rule the message must also read right, word for word.
 */
import assert from "node:assert/strict";

import { renderCellFrame, WIDTH_PROFILES } from "../helpers/cell-frame.mjs";

export const meta = {
  description: "A streamed message with emoji leaves the same screen as a redraw from scratch, at 120, 140 and 160 columns.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 300_000,
};

const ROWS = 30;
const LONG_COMMAND =
  "sleep 0.6; echo '=== P4-EDL: w boot_b magisk_patched.img ===' && echo timeout 600 python3 edl.py --loader ../qcm2290_fhprg.elf w boot_b magisk_patched.img --memory=ufs --debugmode streamed-screen-marker";

const frameOf = (session, from, cellsOf) =>
  renderCellFrame(session.raw.slice(from), { cols: session.cols, rows: session.rows, cellsOf });

const picture = (frame) => frame.map((row) => row.text).join("\n");

async function resizeTo(session, cols) {
  const from = session.raw.length;
  session.term.resize(cols, session.rows);
  session.cols = cols;
  await session.waitForIdle({ idleWindow: 1_500, timeout: 20_000 });
  return from;
}

/** Stream the message, run the tool, then compare the screen with a redraw. */
async function streamAndCompare(session, from, label) {
  await session.submit("Reply with the streamed markdown fixture owner-session");
  await session.waitFor(/Contin\S+o con el flash EDL de boot_b\?/u, { timeout: 60_000, label: `${label}: streamed reply` });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 20_000 });

  await session.submit(`Use the Bash tool to run exactly: ${LONG_COMMAND}`);
  await session.waitFor(/tool complete/u, { timeout: 60_000, label: `${label}: tool turn` });
  await session.waitForIdle({ idleWindow: 2_000, timeout: 20_000 });
  // The shell may still be finishing in the background. The footer then
  // counts it ("1 agent", "1 shell still running") and drops the count a
  // moment later. Wait until it is gone, so the live screen and the redraw
  // show the same state.
  const footerBusy = () =>
    /\d+ agents?\b|still running|to stop agents/u.test(
      picture(frameOf(session, from)).split("\n").slice(-8).join("\n"),
    );
  for (let waited = 0; footerBusy() && waited < 20_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await session.waitForIdle({ idleWindow: 1_500, timeout: 20_000 });

  const cols = session.cols;
  const liveEnd = session.raw.length;
  await resizeTo(session, cols + 1);
  const redrawFrom = await resizeTo(session, cols);

  for (const [profile, cellsOf] of Object.entries(WIDTH_PROFILES)) {
    const live = renderCellFrame(session.raw.slice(from, liveEnd), { cols, rows: session.rows, cellsOf });
    const redrawn = frameOf(session, redrawFrom, cellsOf);
    const different = [];
    for (let index = 0; index < live.length; index += 1) {
      if (live[index].cells !== redrawn[index].cells) {
        different.push(`row ${index + 1}\n  live:   ${live[index].text}\n  redraw: ${redrawn[index].text}`);
      }
    }
    assert.equal(
      different.length,
      0,
      `${label}, width rule ${profile}: ${different.length} rows differ between the live screen and the redraw:\n${different.join("\n")}`,
    );
    if (profile === "unicode") {
      // The words that were corrupted on the owner's screen read right. The
      // message may have scrolled partly out of view, so only the rows that
      // the redraw shows are checked, and at least two of them must be there.
      const text = (frame) => picture(frame).replace(/\s+/gu, " ");
      const phrases = [
        "✅ Imagen Magisk generada y validada",
        "ramdisk con Magisk inyectado, DTB intacto",
        "fastboot rechazó el flash",
        "solo envió, no escribió",
        "estaba corriendo cuando lo interrumpiste",
        "¿Continúo con el flash EDL de boot_b?",
      ].filter((phrase) => text(redrawn).includes(phrase));
      assert.ok(phrases.length >= 2, `${label}: the message is not on screen:\n${picture(redrawn)}`);
      for (const phrase of phrases) {
        assert.ok(text(live).includes(phrase), `${label}: "${phrase}" is not on screen as written:\n${picture(live)}`);
      }
    }
  }
  return redrawFrom;
}

export default async function (session) {
  session.cols = 140;
  session.rows = ROWS;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  let from = await streamAndCompare(session, 0, "140 columns");
  from = await resizeTo(session, 120);
  from = await streamAndCompare(session, from, "120 columns after a resize");
  from = await resizeTo(session, 160);
  await streamAndCompare(session, from, "160 columns after a resize");
}
