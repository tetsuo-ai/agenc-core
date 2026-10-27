/**
 * /theme scenario.
 *
 * Opens the theme picker, moves the selection (a live preview) and presses
 * Esc: nothing is saved. Opens it again, moves to "dark" and presses Enter:
 * the private user config.toml now holds the theme.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "/theme previews on move, Esc saves nothing, Enter saves to config.toml.",
  timeoutMs: 45_000,
};

async function savedConfig(session) {
  try {
    return await readFile(path.join(session.tempHome, ".agenc", "config.toml"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function openPicker(session) {
  await session.submitSlashCommand("/theme");
  await session.waitFor(/THEME[\s\S]*esc cancel/u, { timeout: 15_000, label: "theme picker" });
}

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await openPicker(session);
  session.send("\x1b[B");
  await sleep(300);
  session.sendEscape();
  await session.waitForIdle({ idleWindow: 1_000, timeout: 15_000 });
  if (/"theme"/u.test(await savedConfig(session))) {
    throw new Error("Esc in the theme picker saved a theme");
  }

  await openPicker(session);
  // The saved theme (olive) is last; down wraps to auto, then dark.
  session.send("\x1b[B");
  await sleep(200);
  session.send("\x1b[B");
  await sleep(200);
  session.send("\r");
  const deadline = Date.now() + 10_000;
  while (!/"theme" = "dark"/u.test(await savedConfig(session))) {
    if (Date.now() > deadline) {
      throw new Error(`Enter in the theme picker did not save dark:\n${await savedConfig(session)}`);
    }
    await sleep(100);
  }
  await session.waitForIdle({ idleWindow: 1_000, timeout: 15_000 });
}
