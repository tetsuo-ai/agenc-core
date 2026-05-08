/**
 * Cold-start scenario.
 *
 * The TUI launches, replies to XTVERSION + DA1, paints first frame, and
 * shows the input prompt. Catches: import-time crashes, missing dist
 * artifacts, async-reply crashes that paint-only smokes miss.
 *
 * This is functionally what `check-tui-runtime-startup.mjs` covers; we
 * include it here as the floor of the e2e battery so all gate failures
 * surface in one place.
 */
export const meta = {
  description: "Cold start to first prompt under default mode.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
}
