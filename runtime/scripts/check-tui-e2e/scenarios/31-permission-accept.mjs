/**
 * Permission overlay accept scenario.
 *
 * Default mode (no --dangerously-bypass-approvals-and-sandbox). Submits a prompt that triggers Bash, reads
 * the card like a person would, and accepts it the way the card says. Since
 * 2026-10-14 only 1, 2, 3, the arrows and Enter answer the card; a letter is
 * typing. On an empty composer a "y" therefore moves to the composer draft and
 * the card asks for Tab before it takes a choice again. The scenario checks
 * that "y" decided nothing, then reviews the card with Tab, approves once with
 * "1", and verifies the command ran from the rollout's completed Bash stdout
 * marker while the draft kept the "y". This keeps the scenario scoped to tool
 * approval rather than sandbox file-write policy or assistant echo behavior.
 */
import { frameText, waitForFrameText } from "../helpers/frame.mjs";

const marker = "agenc-permission-accept-marker-3a9c";
const prompt = [
  "Use the Bash tool to run exactly:",
  `printf '%s\\n' ${shellQuote(marker)}`,
].join(" ");
// Longer than the approval typing guard's quiet window (500 ms): a person
// reads the card before answering it.
const READ_CARD_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const meta = {
  description: "Permission overlay (default mode): accept path runs the tool.",
  timeoutMs: 120_000,
  slimCwd: true,
  sandboxMode: "danger-full-access",
  args: ["--permission-mode", "default"],
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(prompt);
  await session.submit();
  await session.waitForPermissionOverlay({ timeout: 60_000 });
  await sleep(READ_CARD_MS);
  session.send("y");
  await waitForFrameText(
    session,
    /Draft saved: y[\s\S]*Tab reviews approval/u,
    "the y keypress kept as draft text",
  );
  await sleep(READ_CARD_MS);
  session.send("\t");
  await sleep(READ_CARD_MS);
  session.send("1");
  await session.waitForIdle({ idleWindow: 4_000, timeout: 90_000 });
  await session.assertRolloutToolOutput(marker, { label: "approved Bash output" });
  // The composer row separates the prompt glyph with a no-break space.
  if (!/^\s*❯\s+y\s*$/mu.test(frameText(session))) {
    throw new Error(`the composer did not keep the "y" draft:\n${frameText(session)}`);
  }
}
