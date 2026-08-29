/**
 * /rewind scenario.
 *
 * `/rewind` mounts the live message selector. With no earlier prompt it
 * must render the empty state, close on Escape, and return to the composer.
 */
export const meta = {
  description: "/rewind renders and closes its empty state.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/rewind");
  await session.waitFor(/Nothing to rewind to yet\./u, { timeout: 15_000 });
  session.sendEscape();
  await session.waitForPrompt({ timeout: 15_000 });
}
