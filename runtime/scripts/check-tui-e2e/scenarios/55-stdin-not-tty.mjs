/**
 * Non-TTY stdin routing scenario.
 *
 * `echo "<prompt>" | agenc` should route through the daemon-backed
 * one-shot path (route.ts: branch 4). Verifies stdin-piped input
 * doesn't crash and produces output.
 *
 * The actual routing (non-TTY → oneShotCLI) is fast and deterministic.
 * The slow part is the model — qwen3.6 + LMStudio takes anywhere from
 * <1s on a warm cache to 200s+ on cold prefix-cache invalidation. The
 * timeout below has to swallow the worst-case model latency, otherwise
 * the gate flakes when the daemon's KV cache evicts between scenarios.
 * The route's correctness is also covered by check-llm-pipeline scenario
 * 03 (which inspects the rollout for the routing decision regardless of
 * how slow the model responds).
 */
const TIMEOUT_MS = 240_000;

export const meta = {
  description: "Piped stdin (no TTY) routes through one-shot CLI path.",
  timeoutMs: TIMEOUT_MS + 30_000,
  slimCwd: true,
};

export default async function (session) {
  const result = await session.runAgenc(["--yolo"], {
    cwd: session.cwd,
    input: "reply with the single word PIPED",
    timeoutMs: TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `piped stdin exited code=${result.code}; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `piped stdin produced no stdout; stderr: ${result.stderr.slice(0, 400)}`,
    );
  }
}
