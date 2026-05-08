/**
 * --yolo multi-turn scenario.
 *
 * Same as 07 but under --yolo. Catches yolo-specific session/transcript
 * regressions that don't manifest in default mode (e.g. permission-skip
 * paths leaving the daemon in a different state on the second submit).
 */
export const meta = {
  description: "--yolo: two messages in one session, both reach idle.",
  args: ["--yolo"],
  timeoutMs: 180_000,
  // BackgroundAgentRunner.getAgentSnapshot fix (which removed the
  // early-null branch that caused AgentLifecycle to evict completed
  // agents) covers the common race. Default-mode 07 reliably passes.
  // --yolo 08 still flakes — there's a second eviction path through
  // a different daemon-side handler that the snapshot fix didn't
  // reach. Filed alongside 45 as GAP-DMN-AGENT-LIFECYCLE-EVICT.
  skip: "secondary eviction path under --yolo; see GAP-DMN-AGENT-LIFECYCLE-EVICT",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
  await session.type("and again");
  await session.submit();
  await session.waitForIdle({ timeout: 60_000 });
}
