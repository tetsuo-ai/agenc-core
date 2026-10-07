/**
 * Project trust: a repo that ships a hook.
 *
 * Trusting it would turn the hook on, so the card shows and lists it. Enter
 * alone must do nothing (nothing is selected yet); `y` trusts the folder
 * explicitly and the TUI opens.
 */
import { TRUST_CARD, expectTrustKind, shipRepoHook } from "../helpers/trust.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const meta = {
  description: "A repo with a hook shows the trust card listing it; y trusts.",
  timeoutMs: 45_000,
  preTrust: false,
};

export default async function (session) {
  const env = await session.prepare();
  shipRepoHook(session);
  await session.start();
  await session.waitFor(TRUST_CARD, { timeout: 20_000, label: "trust card" });
  await sleep(500);
  const card = session.latestFrame;
  for (const expected of [
    /Trusting\s+turns\s+on\s+the\s+AgenC\s+settings\s+this\s+repo\s+ships:/u,
    /Hooks\s+\.\/notify\.sh\s+when\s+a\s+turn\s+ends/u,
    /Approvals\s+and\s+the\s+sandbox\s+still\s+apply\./u,
    /\[\s*Exit\s+n\s*\]\s+\[\s*Trust\s+y\s*\]/u,
  ]) {
    if (!expected.test(card)) {
      throw new Error(`trust card is missing ${expected}:\n${card}`);
    }
  }

  // A stray Enter (the launching shell's, or a reflex) answers nothing.
  session.send("\r");
  await sleep(1_000);
  if (session.exited) throw new Error("Enter with nothing selected exited the TUI");
  if (!TRUST_CARD.test(session.latestFrame)) {
    throw new Error("Enter with nothing selected dismissed the trust card");
  }
  expectTrustKind(session, env, "none", "after a stray Enter");

  session.send("y");
  await session.waitForPrompt({ timeout: 20_000 });
  expectTrustKind(session, env, "explicit", "after y");
}
