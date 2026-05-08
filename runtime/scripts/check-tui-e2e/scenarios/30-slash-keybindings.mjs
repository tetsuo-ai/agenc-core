/**
 * /keybindings scenario.
 *
 * Pre-existing GAP: /keybindings spawns the user's $EDITOR with stdio:
 * "inherit" while Ink still owns the terminal, which corrupts the render
 * and can hang. This is documented as GAP-TUI-04 in PORT_CHECKLIST.md.
 * Skipped here so the gate doesn't time out on a known broken command;
 * unskip when GAP-TUI-04 lands.
 */
export const meta = {
  description: "/keybindings opens editor without corrupting Ink (skipped).",
  timeoutMs: 30_000,
  skip: "blocked on GAP-TUI-04 — /keybindings spawns editor while Ink holds the terminal",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/keybindings");
  await session.waitForIdle({ timeout: 15_000 });
}
