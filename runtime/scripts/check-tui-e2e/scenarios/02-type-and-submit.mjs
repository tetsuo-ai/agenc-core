/**
 * Type-and-submit scenario.
 *
 * Types "hello", presses Enter, expects a streaming assistant reply, expects
 * the prompt to come back idle. This is the canonical "does the TUI work
 * end-to-end" test.
 *
 * Regression catch: this is the scenario that would have caught the
 * dist/tui/daemon-session.js bundling bug fixed in d7616a4a. Submit was
 * crashing in `loadCreateDaemonTuiSession` with ERR_MODULE_NOT_FOUND because
 * the production bundle never included the dynamic-import target.
 */
export const meta = {
  description: "Type 'hello', submit, expect streaming reply, no crash.",
  // The scenario verifies TUI/daemon/model wiring. Platform sandbox
  // fail-closed behavior has dedicated coverage and may be unavailable in
  // the outer container running this local gate.
  args: ["--yolo"],
  slimCwd: true,
  timeoutMs: 60_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hello");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 45_000 });
  await session.waitForPrompt({ timeout: 30_000 });
}
