/**
 * /diff scenario.
 *
 * `/diff` shows pending file changes (or a diff over a range). The runner
 * seeds a deterministic tracked modification so this proves changed-file
 * rendering instead of only opening the empty-state panel.
 */
export const meta = {
  description: "/diff renders diff UI and restores slash input after close.",
  dirtyCwd: true,
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/diff");
  await session.waitFor(/DIFF[\s\S]*M diff-fixture\.txt/u, {
    timeout: 15_000,
    label: "/diff surface with tracked fixture",
  });
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
