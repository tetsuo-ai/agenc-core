/**
 * `agenc --help` scenario.
 *
 * Prints usage to stdout, exits 0. Should NOT spin up the TUI.
 */
export const meta = {
  description: "agenc --help prints usage and exits cleanly.",
  timeoutMs: 10_000,
};

export default async function (session) {
  const result = await session.runAgenc(["--help"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `--help exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  // Standard usage outputs include one of these markers.
  if (!/usage|Usage|Commands|Options/.test(result.stdout)) {
    throw new Error(`--help stdout has no usage marker: "${result.stdout.slice(0, 200)}"`);
  }
}
