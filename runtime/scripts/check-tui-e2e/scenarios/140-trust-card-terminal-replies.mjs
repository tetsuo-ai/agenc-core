/**
 * Project trust: terminal replies never answer the card.
 *
 * The card answers on a single `y` or `n`. Terminals send replies and focus
 * reports on their own (a kitty version reply even contains a `y`). None of
 * them may trust the folder or dismiss the card; only a real `n` exits.
 */
import { TRUST_CARD, expectTrustKind, shipRepoHook } from "../helpers/trust.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL_REPLIES = [
  "\x1bP>|kitty(0.35.2)\x1b\\", // XTVERSION reply
  "\x1b]11;rgb:ffff/ffff/ffff\x1b\\", // OSC 11 background reply
  "\x1b[?62;22c", // DA1 reply
  "\x1b[I", // focus in
  "\x1b[O", // focus out
];

export const meta = {
  description: "Terminal replies while the trust card is up never answer it.",
  timeoutMs: 45_000,
  preTrust: false,
};

export default async function (session) {
  const env = await session.prepare();
  shipRepoHook(session);
  await session.start();
  await session.waitFor(TRUST_CARD, { timeout: 20_000, label: "trust card" });
  for (const reply of TERMINAL_REPLIES) {
    session.send(reply);
    await sleep(150);
  }
  await sleep(1_000);
  if (session.exited) {
    throw new Error("a terminal reply dismissed the trust card");
  }
  if (!TRUST_CARD.test(session.latestFrame)) {
    throw new Error(`the trust card is gone after terminal replies:\n${session.latestFrame}`);
  }
  expectTrustKind(session, env, "none", "after terminal replies");

  session.send("n");
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    if (session.exited) {
      expectTrustKind(session, env, "none", "after n");
      return;
    }
    await sleep(100);
  }
  throw new Error("n did not exit the TUI within 8s");
}
