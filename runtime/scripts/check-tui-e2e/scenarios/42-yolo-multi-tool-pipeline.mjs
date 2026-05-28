/**
 * Multi-tool pipeline scenario.
 *
 * Asks the model to do a multi-step task that requires more than one
 * Bash invocation. Catches: tool-chain regressions, between-call state
 * loss, model-side handoff bugs.
 */
export const meta = {
  description: "--yolo: model chains two Bash calls in a single turn.",
  args: ["--yolo"],
  timeoutMs: 120_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  const firstMarker = `agenc-pipeline-one-${Date.now()}`;
  const secondMarker = `agenc-pipeline-two-${Date.now()}`;
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    `Use the Bash tool exactly twice. First run only: echo ${firstMarker}. Then run only: echo ${secondMarker}. Do not combine the commands.`,
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 120_000 });
  await session.assertRolloutToolOutputSequence([firstMarker, secondMarker], {
    label: "Bash pipeline outputs",
    toolName: "exec_command",
  });
}
