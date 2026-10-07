/**
 * `agenc --continue` in a second TUI, started while the restarted daemon is
 * still restoring the session, opens the restored agent.
 *
 * The TUI resume path shares the cold resume of scenario 143: it found no
 * agent while the restore ran, got CANONICAL_SESSION_ALREADY_ACTIVE from the
 * one-shot daemon client as a plain Error, and exited 1 with "canonical
 * session ... already has a live daemon agent" instead of attaching.
 */
export const meta = {
  description: "A TUI --continue during startup restores attaches to the restored agent.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  env: { OPENAI_COMPATIBLE_API_KEY: "" },
  timeoutMs: 180_000,
  slimCwd: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForIdle({ timeout: 60_000 });
  await session.restartGateDaemon();

  const resumed = new session.constructor({
    args: [...session.args, "--continue"],
    env: session.envOverrides,
    cwd: session.cwd,
    gateState: session.gateState,
  });
  try {
    await resumed.start();
    try {
      await resumed.waitForPrompt({ timeout: 30_000 });
    } catch (error) {
      throw new Error(`${error.message}; resumed TUI output: ${resumed.text.slice(-600)}`);
    }
    resumed.assertNoCrash();
    await resumed.type("and again");
    await resumed.submit();
    await resumed.waitForAssistantReply({ timeout: 60_000 });
  } finally {
    await resumed.cleanup();
  }
}
