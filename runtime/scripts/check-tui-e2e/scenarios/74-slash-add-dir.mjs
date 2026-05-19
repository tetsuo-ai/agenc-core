/**
 * /add-dir scenario.
 *
 * `/add-dir` adds an additional working directory to the session's scope.
 * Without an argument it should open its picker / prompt UI. Smoke-test
 * that it loads and returns to idle.
 */
export const meta = {
  description: "/add-dir opens directory picker UI, returns to idle.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/add-dir");
  await session.waitForIdle({ timeout: 15_000 });
}
