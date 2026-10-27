/**
 * /hooks scenario.
 *
 * Opens the hooks surface (pre/post-tool hooks). A private daemon has no live
 * agent session until the first turn, so seed one before inspecting its real
 * hooks runtime. A connected TUI shows the daemon's live hooks status as a
 * read-only menu (8e3abaa0b), not the text overview: every event row, the
 * plain-language explanation of the highlighted one, and only the daemon's
 * supported actions. Esc closes it and the prompt takes input again.
 */
import { frameText, waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description: "/hooks opens the live hooks menu, Esc returns to idle.",
  sandboxMode: "danger-full-access",
  timeoutMs: 90_000,
};

const MENU_TITLE = /HOOKS · ENABLED/u;

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hello");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 30_000 });
  await session.submitSlashCommand("/hooks");
  await session.waitFor(
    /HOOKS · ENABLED[\s\S]*PreToolUse\s+none configured[\s\S]*PostCompact\s+none configured[\s\S]*runs your commands before the agent uses a tool\.[\s\S]*\/hooks show · enable · disable/u,
    { timeout: 15_000, label: "live hooks runtime menu" },
  );
  session.sendEscape();
  await waitForFrameText(
    session,
    { test: (frame) => !MENU_TITLE.test(frame) },
    "closed hooks menu",
  );
  await session.waitForIdle({ timeout: 15_000 });
  if (MENU_TITLE.test(frameText(session))) {
    throw new Error("the hooks menu reopened after Esc");
  }
}
