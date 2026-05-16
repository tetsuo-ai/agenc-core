/**
 * /skills scenario.
 *
 * Lists available skills in a persistent menu. Smoke-test that the command
 * loads, renders, scrolls when there are more skills than fit, and closes.
 */
export const meta = {
  description: "/skills renders skill list, returns to idle without crash.",
  timeoutMs: 30_000,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/skills");
  await session.waitFor(/Use\s+\$skill-name\s+to\s+load\s+a\s+skill/, { timeout: 15_000 });
  await session.waitForIdle({ timeout: 15_000 });
  if (/more below/.test(session.text)) {
    session.mark();
    session.send("\x1b[6~"); // PageDown
    await session.waitFor(/more above/, { timeout: 15_000 });
  }
  session.sendEscape();
  await session.waitForIdle({ timeout: 15_000 });

  const parts = [
    `\\b${["Co", "dex"].join("")}\\b`,
    `\\b${["co", "dex"].join("")}\\b`,
    `\\b${["CO", "DEX"].join("")}(?=\\b|_)`,
    `\\b${["Cla", "ude"].join("")}\\b`,
    `\\b${["cla", "ude"].join("")}\\b`,
    `\\b${["CLA", "UDE"].join("")}(?=\\b|_)`,
    `\\b${["Open", "Cla", "ude"].join("")}\\b`,
    `\\b${["open", "cla", "ude"].join("")}\\b`,
    `\\b${["OPEN", "CLA", "UDE"].join("")}\\b`,
  ];
  const donorBrand = new RegExp(`(?:${parts.join("|")})`, "u");
  if (donorBrand.test(session.text)) {
    throw new Error("/skills leaked donor branding in visible output");
  }
}
