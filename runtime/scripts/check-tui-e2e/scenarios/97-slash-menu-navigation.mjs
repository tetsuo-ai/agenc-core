/**
 * Slash menu navigation under fullscreen workbench.
 *
 * This catches regressions where workbench pane keybindings steal the
 * autocomplete menu's up/down arrows while the slash-command picker is open.
 */
export const meta = {
  description: "slash-command menu opens in workbench mode and arrow navigation changes the highlighted command.",
  timeoutMs: 30_000,
  env: {
    AGENC_NO_FLICKER: "1",
    AGENC_TUI_WORKBENCH: "1",
    AGENC_TUI_GLYPHS: "ascii",
  },
  useTempHome: true,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedCommand(frame) {
  const match = /^.*>\s+(\/[A-Za-z0-9][^\s]*)/mu.exec(frame);
  return match?.[1] ?? null;
}

async function waitForSelectedCommand(session, predicate, label) {
  const deadline = Date.now() + 5_000;
  let last = null;
  while (Date.now() < deadline) {
    last = selectedCommand(session.latestFrame);
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected slash command: ${label}; last=${last ?? "none"}`);
}

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await session.type("/");
  await session.waitFor(/SLASH COMMANDS/, { timeout: 10_000, label: "slash menu" });

  const initial = await waitForSelectedCommand(session, () => true, "initial selection");
  session.send("\x1b[B");
  const afterDown = await waitForSelectedCommand(
    session,
    (command) => command !== initial,
    "down arrow changed selection",
  );

  session.send("\x1b[A");
  await waitForSelectedCommand(
    session,
    (command) => command === initial,
    `up arrow restored selection from ${afterDown}`,
  );

  session.sendEscape();
  session.send("\x7f");
  await sleep(100);
}
