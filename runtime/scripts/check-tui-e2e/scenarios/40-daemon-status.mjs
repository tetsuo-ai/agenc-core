/**
 * `agenc daemon status` scenario.
 *
 * Should report the running daemon's PID. Catches: status command
 * regressions, daemon discovery via daemon.pid file, peer auth race
 * during status query.
 */
export const meta = {
  description: "agenc daemon status reports running PID.",
  timeoutMs: 10_000,
};

export default async function (session) {
  const result = await session.runAgenc(["daemon", "status"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `daemon status exited ${result.code}; stderr: ${result.stderr.slice(0, 200)}`,
    );
  }
  if (!/running/.test(result.stdout)) {
    throw new Error(
      `daemon status did not report running: "${result.stdout}"`,
    );
  }
  if (!/pid\s+\d+/.test(result.stdout)) {
    throw new Error(
      `daemon status did not include PID: "${result.stdout}"`,
    );
  }
}
