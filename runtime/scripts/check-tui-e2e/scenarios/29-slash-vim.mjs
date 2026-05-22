/**
 * Removed /vim command scenario.
 *
 * The runtime slash surface intentionally removed the legacy /vim command.
 * Unit coverage locks the registry contract; this E2E keeps the workbench
 * palette path honest by checking that typing /vim does not surface an
 * executable /vim row.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Removed /vim command stays absent from the slash palette.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("/vim");
  await sleep(300);

  const visible = session.text;
  if (/SLASH COMMANDS[\s\S]*❯\s*\/vim\b/i.test(visible)) {
    throw new Error(`/vim appeared as a selectable slash command: ${visible.slice(-500)}`);
  }

  session.sendEscape();
  await sleep(80);
  session.sendEscape();
  await session.waitForIdle({ idleWindow: 1_000, timeout: 10_000 });
}
