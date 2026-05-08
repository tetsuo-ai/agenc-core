/**
 * Many-turns endurance scenario.
 *
 * Submits 4 short messages in one --yolo session. Catches: gradual
 * resource leaks (file descriptors, daemon memory, transcript bloat
 * over time, conversation-context-window misaccounting). Distinct from
 * 08 multi-turn (which is 2 turns) — this exercises the longer arc.
 *
 * Skipped today because GAP-DMN-AGENT-NOT-FOUND blocks even 2-turn
 * --yolo. Unskip when GAP-DMN-AGENT-NOT-FOUND lands.
 */
export const meta = {
  description: "--yolo: 4 turns survive the agent-not-found race.",
  args: ["--yolo"],
  timeoutMs: 600_000,
  slimCwd: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  for (const turn of ["one", "two", "three", "four"]) {
    await session.type(`reply with the single word ${turn}`);
    await session.submit();
    await session.waitForIdle({ timeout: 120_000 });
  }
}
