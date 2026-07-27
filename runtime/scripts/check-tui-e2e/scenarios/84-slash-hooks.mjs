/**
 * /hooks scenario.
 *
 * Opens the hooks editor (pre/post-tool hooks). A private daemon has no live
 * agent session until the first turn, so seed one before inspecting its real
 * hooks runtime.
 */
export const meta = {
  description: "/hooks opens hooks editor, returns to idle.",
  sandboxMode: "danger-full-access",
  timeoutMs: 90_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hello");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 30_000 });
  await session.submitSlashCommand("/hooks");
  await session.waitFor(/AgenC Hooks|Commands: \/hooks/u, {
    timeout: 15_000,
    label: "live hooks runtime surface",
  });
  await session.waitForIdle({ timeout: 15_000 });
}
