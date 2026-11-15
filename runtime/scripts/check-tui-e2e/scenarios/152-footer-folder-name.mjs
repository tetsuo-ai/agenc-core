/**
 * The status line shows only the folder's own name and no unknown ZDR badge.
 *
 * Owner report (2026-11-14): "too long the dir name under the input": the
 * footer showed a path cut in the middle ("/Users/tetsuoa…23137/project").
 * It now shows only the last name of the working folder. The gate's model is
 * an OpenAI-compatible server on 127.0.0.1, so AgenC cannot tell whether
 * data is kept, and the line shows no "ZDR?" for that.
 */
import assert from "node:assert/strict";
import { basename } from "node:path";

import { renderPtyRows } from "../harness.mjs";

export const meta = {
  description: "The footer shows the working folder's last name only, with no ZDR? badge.",
  timeoutMs: 60_000,
};

export default async function (session) {
  session.cols = 120;
  session.rows = 24;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submit("Reply with the single word ALPHA");
  await session.waitForAssistantReply({ timeout: 30_000 });
  await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });

  const rows = renderPtyRows(session.raw, { cols: session.cols, rows: session.rows });
  const frame = rows.join("\n");
  const status = rows.filter((row) => row.trim().length > 0).at(-1) ?? "";
  const folder = basename(session.cwd);
  assert.ok(folder.length > 0, "the gate has a working folder");
  assert.ok(status.trimStart().startsWith(`${folder} · `), `the status line does not start with "${folder} · ":\n${frame}`);
  const facts = status.trim().split(" · ")[0];
  assert.equal(facts, folder, `the folder fact is not the bare name:\n${frame}`);
  assert.ok(!status.includes("/"), `the status line shows a path:\n${frame}`);
  assert.ok(!frame.includes("ZDR?"), `an unknown ZDR state is shown:\n${frame}`);
}
