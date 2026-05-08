/**
 * /keybindings scenario.
 *
 * /keybindings spawns $EDITOR (or /usr/bin/nano if EDITOR is unset) on
 * ~/.agenc/keybindings.json. The runtime hands off to alternate-screen
 * mode before the spawn (runtime/src/commands/keybindings.ts:175-184) so
 * the editor process gets a clean terminal. We force EDITOR=/bin/true so
 * the spawned editor exits immediately, which lets us assert the command
 * dispatched, alt-screen handoff worked, and Ink resumed cleanly.
 */
export const meta = {
  description: "/keybindings hands off to editor without corrupting Ink.",
  timeoutMs: 30_000,
  env: { EDITOR: "/bin/true" },
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/keybindings");
  await session.waitForIdle({ timeout: 20_000 });
}
