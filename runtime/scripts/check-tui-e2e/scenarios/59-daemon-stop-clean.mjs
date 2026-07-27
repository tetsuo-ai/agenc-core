/**
 * `agenc daemon stop` then `daemon status` returns stopped.
 *
 * Catches: stop command leaves the daemon zombie, status command
 * misreports state after stop.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStoppedStatus(session, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await session.runAgenc(
      ["daemon", "status"],
      { timeoutMs: 15_000 },
    );
    if (lastStatus.code !== 0 || !/running/.test(lastStatus.stdout)) {
      return lastStatus;
    }
    await sleep(250);
  }
  throw new Error(
    `daemon status still shows running after stop: ${lastStatus?.stdout ?? ""}`,
  );
}

export const meta = {
  description: "daemon stop → status reports stopped, then start works.",
  timeoutMs: 90_000,
};

export default async function (session) {
  // Stop
  const stopResult = await session.runAgenc(
    ["daemon", "stop"],
    { timeoutMs: 20_000 },
  );
  if (stopResult.code !== 0) {
    throw new Error(
      `daemon stop failed (${stopResult.code}): ${stopResult.stderr}${stopResult.stdout}`,
    );
  }
  // Status should report stopped (exit non-zero or message)
  const stoppedStatus = await waitForStoppedStatus(session);
  if (stoppedStatus.code === 0 && /running/.test(stoppedStatus.stdout)) {
    throw new Error(
      `daemon status shows running after stop: ${stoppedStatus.stdout}`,
    );
  }
  // Restore the runner's foreground ownership before continuing.
  await session.startGateDaemon();
  await sleep(5_000);
  const runStatus = await session.runAgenc(
    ["daemon", "status"],
    { timeoutMs: 15_000 },
  );
  if (!/running/.test(runStatus.stdout)) {
    throw new Error(`daemon didn't restart cleanly: ${runStatus.stdout}`);
  }
}
