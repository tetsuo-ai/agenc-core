/**
 * Yolo + Bash tool round-trip.
 *
 * --yolo bypasses permission prompts. Submits a prompt that explicitly
 * asks the model to run a Bash command, then asserts the command's output
 * appears in the captured buffer. This is the most-traveled tool path:
 * if Bash round-trip is broken, every multi-step task is broken.
 *
 * Note on flakiness: the model has to decide to call Bash. Qwen3 with the
 * explicit "use Bash" instruction reliably does so in our config; if a
 * future model change breaks that, this scenario gates the regression.
 */
export const meta = {
  description: "--yolo: model uses Bash, command output renders in transcript.",
  args: ["--yolo"],
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: echo agenc-e2e-marker-7f3b",
  );
  await session.submit();
  // Wait for the unique marker the Bash command should print. If we just
  // wait for idle the scenario can't tell whether Bash actually ran.
  await session.waitFor(/agenc-e2e-marker-7f3b/, { timeout: 60_000, label: "bash output" });
  await session.waitForIdle({ timeout: 30_000 });
}
