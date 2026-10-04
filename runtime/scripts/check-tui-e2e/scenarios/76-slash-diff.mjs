/**
 * /diff scenario.
 *
 * `/diff` shows pending file changes (or a diff over a range). The runner
 * seeds a deterministic tracked modification so this proves changed-file
 * rendering instead of only opening the empty-state panel.
 *
 * `/diff` opens the diff menu (src/commands/diff-menu.tsx): one row per file
 * with a status glyph, status, line delta and path, tracked changes first and
 * untracked files after them.
 */
import { waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description: "/diff renders diff UI and restores slash input after close.",
  dirtyCwd: true,
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/diff");
  await waitForFrameText(
    session,
    /DIFF[\s\S]*\*\s+modified\s+\+1 -0\s+diff-fixture\.txt[\s\S]*\?\s+untracked\s+\+0 -0\s+untracked-fixture\.txt/u,
    "/diff menu with the tracked and untracked fixtures",
    15_000,
  );
  session.send("q");
  await session.waitForIdle({ timeout: 15_000 });
  await session.type("/");
  await session.waitFor(/SLASH COMMANDS/u, {
    timeout: 10_000,
    label: "slash menu after closing /diff",
  });
  session.sendEscape();
  session.send("\x7f");
}
