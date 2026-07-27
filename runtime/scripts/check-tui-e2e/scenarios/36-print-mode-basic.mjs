/**
 * Print mode basic scenario.
 *
 * `agenc -p "hi"` should print the model's reply to stdout and exit
 * cleanly. No TUI, no PTY needed. Catches: print-mode-only crashes,
 * stdout buffering bugs, exit-code regressions.
 */
export const meta = {
  description: "agenc -p prints model reply and exits cleanly.",
  timeoutMs: 90_000,
};

export default async function (session) {
  const result = await session.runAgenc(
    ["--yolo", "-p", "say only the word HELLO and nothing else"],
    { timeoutMs: 80_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `print mode exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `print mode produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
}
