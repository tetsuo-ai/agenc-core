/**
 * /skills scenario.
 *
 * Lists available skills. Smoke-test that the command loads, renders,
 * and returns to idle.
 */
export const meta = {
  description: "/skills renders skill list, returns to idle without crash.",
  timeoutMs: 30_000,
  slimCwd: true,
  useTempHome: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.submitSlashCommand("/skills");
  await session.waitFor(/SKILLS\b/i, { timeout: 15_000 });
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
