/**
 * Project trust: a folder that ships no AgenC settings.
 *
 * Trust would turn nothing on here (no repository settings, no hooks of the
 * user's own), so the TUI starts straight at the prompt with no trust card
 * and records the folder as trusted automatically, not explicitly.
 */
import { TRUST_CARD, expectTrustKind } from "../helpers/trust.mjs";

export const meta = {
  description: "A folder with nothing to review starts without the trust card.",
  timeoutMs: 45_000,
  preTrust: false,
};

export default async function (session) {
  const env = await session.prepare();
  expectTrustKind(session, env, "none", "before start");
  await session.start();
  await session.waitForPrompt({ timeout: 20_000 });
  if (TRUST_CARD.test(session.text)) {
    throw new Error("the trust card appeared for a folder with nothing to review");
  }
  expectTrustKind(session, env, "automatic", "after start");
}
