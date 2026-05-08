/**
 * /rewind scenario.
 *
 * `/rewind` is documented to restore code and/or conversation to a
 * previous point. The full UI lives in REPL.tsx (orphaned shell — see
 * GAP-TUI-12); App.tsx (the live shell) does not yet mount it. The
 * command should still dispatch without crashing — either by no-op'ing
 * or by printing a "not available" message. Smoke-test that it doesn't
 * blow up the Ink tree.
 */
export const meta = {
  description: "/rewind dispatches without crashing.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/rewind");
  await session.waitForIdle({ timeout: 15_000 });
}
