/**
 * `agenc --no-tui '<prompt>'` scenario.
 *
 * The --no-tui flag is documented as forcing the daemon-backed
 * one-shot path even inside a TTY. Verify it works and produces
 * model output to stdout.
 */
export const meta = {
  description: "--no-tui forces daemon one-shot path; produces stdout.",
  timeoutMs: 120_000,
  slimCwd: true,
};

export default async function (session) {
  const result = await session.runAgenc(
    ["--yolo", "--no-tui", "reply with the single word NOTUI"],
    {
      cwd: session.cwd,
      timeoutMs: 110_000,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `--no-tui exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `--no-tui produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
}
