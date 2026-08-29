/**
 * Print mode + --dangerously-bypass-approvals-and-sandbox scenario.
 *
 * --dangerously-bypass-approvals-and-sandbox + -p should print and exit. Catches yolo-specific print-mode
 * regressions (permission elision, status-line drift in headless mode).
 */
export const meta = {
  description: "agenc --dangerously-bypass-approvals-and-sandbox -p prints model reply and exits cleanly.",
  timeoutMs: 90_000,
};

export default async function (session) {
  const result = await session.runAgenc(
    ["--dangerously-bypass-approvals-and-sandbox", "-p", "say only the word HELLO and nothing else"],
    { timeoutMs: 80_000 },
  );
  // Strip the noisy config-migration banner so the assertion error
  // surfaces the actual cause.
  const cleanStderr = result.stderr
    .split("\n")
    .filter((line) => !line.includes("[agenc:config-migration]"))
    .join("\n");
  if (result.code !== 0) {
    throw new Error(
      `yolo print mode exited code=${result.code}; stderr: ${cleanStderr.slice(0, 600)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `yolo print mode produced no stdout; stderr: ${cleanStderr.slice(0, 600)}`,
    );
  }
}
