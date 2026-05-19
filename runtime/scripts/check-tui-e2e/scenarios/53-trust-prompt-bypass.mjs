/**
 * Trust prompt pre-population scenario.
 *
 * The harness calls ensureProjectTrusted (or temp-HOME equivalent)
 * before spawning so the trust dialog never appears at cold start.
 * This scenario asserts the dialog is NOT visible — would catch
 * regressions in the trust file format / loader (the famous
 * "version field is required" gotcha).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const meta = {
  description: "Trust dialog does not appear when project is pre-trusted.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await sleep(500);
  if (/Trust\s*this\s*project/i.test(session.text)) {
    throw new Error(
      "trust dialog appeared despite ensureProjectTrusted — trust file format may have regressed (check version field)",
    );
  }
}
