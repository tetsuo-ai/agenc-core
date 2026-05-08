/**
 * Yolo footer glyph scenario.
 *
 * Per CLAUDE.md learned rule: AgenC TUI parity must NOT show the local
 * "⚠" permission-mode glyph in the footer. The upstream-derived
 * footer should render correctly. This catches regressions where the
 * old AgenC glyph leaks back in.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "--yolo footer does NOT display the legacy ⚠ glyph.",
  args: ["--yolo"],
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await sleep(500);
  if (/⚠/.test(session.text)) {
    throw new Error(
      "footer/prompt contains the banned ⚠ glyph — see CLAUDE.md AgenC TUI Parity rule",
    );
  }
}
