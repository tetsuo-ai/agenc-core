/**
 * Multi-line paste scenario.
 *
 * Send multi-line content as if pasted. The TUI should accept it as a
 * single multi-line input (not submit on first newline). Pressing
 * Enter at end submits the whole thing.
 *
 * The bracketed-paste sequences `\\x1b[200~` / `\\x1b[201~` mark a
 * paste boundary; many terminal apps use them to distinguish typed
 * vs pasted input. agenc may or may not support them — we send and
 * verify no crash.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Multi-line bracketed paste is accepted without crash.",
  timeoutMs: 90_000,
  args: ["--yolo"],
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  // Enter bracketed paste mode, dump content, exit paste mode.
  session.send("\x1b[200~");
  session.send("Please reply with the literal text PASTE-MULTILINE-OK.\nThe text spans");
  session.send(" multiple lines.\nThanks.");
  session.send("\x1b[201~");
  await sleep(300);
  session.send("\r");
  await session.waitFor(/PASTE-MULTILINE-OK/, {
    timeout: 75_000,
    label: "paste-confirmation marker",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
