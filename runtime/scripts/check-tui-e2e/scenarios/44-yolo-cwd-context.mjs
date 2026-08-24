/**
 * Cwd-context scenario.
 *
 * Asks the model to run `pwd`. The output should match the directory
 * the agenc process was launched from. Catches: cwd not propagated to
 * subagent, daemon-side cwd reset, child-shell cd before exec.
 */
export const meta = {
  description: "--dangerously-bypass-approvals-and-sandbox: model uses Bash pwd, output matches launch cwd.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 120_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: pwd",
  );
  await session.submit();
  await session.waitForIdle({ idleWindow: 4_000, timeout: 120_000 });
  await session.assertRolloutToolOutput(session.cwd, {
    label: "pwd output matches launch cwd",
    toolName: "exec_command",
  });
}
