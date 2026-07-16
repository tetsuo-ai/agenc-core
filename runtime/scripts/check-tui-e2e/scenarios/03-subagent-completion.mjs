/**
 * Subagent completion scenario.
 *
 * After a turn completes, the daemon sends an `agent_completed` (or similar)
 * persistent message to the TUI client. The client looks the agent up in its
 * local registry and renders the completion. If the lookup misses, the
 * client throws `AgenC daemon agent not found: <id>` and the TUI crashes
 * mid-conversation.
 *
 * This scenario triggers a turn, waits long enough for every post-turn
 * message to flush (the assistant reply, tool use, agent completion event,
 * any housekeeping), then asserts no crash. Distinct from
 * 02-type-and-submit because some crashes only surface several seconds AFTER
 * the prompt comes back — the visible response is fine but the daemon's
 * follow-up message kills the client.
 */
export const meta = {
  description:
    "Run a full turn, wait for daemon post-turn messages to settle, expect no late crash.",
  // Completion ordering is independent of the platform sandbox. Use the
  // explicit test-only bypass so this local mock-provider scenario remains
  // runnable on hosts where unprivileged namespaces are unavailable.
  args: ["--yolo"],
  timeoutMs: 90_000,
  // This scenario exercises daemon/TUI completion ordering, not project
  // context. Keep the writable workspace outside the built runtime so the
  // packaged sandbox helper remains a trusted executable boundary.
  slimCwd: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 30_000 });
  // Linger to let any post-turn daemon messages arrive. The "agent not
  // found" crash this scenario catches fires AFTER the prompt comes back.
  await sleep(5_000);
}
