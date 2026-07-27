/**
 * `agenc --version` scenario.
 *
 * Prints version string to stdout, exits 0. Catches: version-flag
 * regressions, runtime-side init that runs even on --version (it
 * shouldn't), wrapper-vs-runtime version drift.
 */
export const meta = {
  description: "agenc --version prints semver and exits cleanly.",
  timeoutMs: 10_000,
};

export default async function (session) {
  const result = await session.runAgenc(["--version"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `--version exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  // Expect a number-dot-number-dot-number anywhere in stdout.
  if (!/\d+\.\d+\.\d+/.test(result.stdout)) {
    throw new Error(`--version stdout did not contain semver: "${result.stdout}"`);
  }
}
