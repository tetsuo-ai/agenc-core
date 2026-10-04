/**
 * `agenc onboard` scenario.
 *
 * The explicit onboard subcommand boots the TUI with the first-run wizard
 * forced. Drive the whole wizard with the mock openai-compatible provider
 * (keyless local provider path), finish it, then complete a real first turn
 * against the mock model — the Phase 0 acceptance criterion.
 *
 * Finishing the wizard after a successful connection check makes the TUI
 * send a starter turn on its own (useOnboardingStarterTurn in
 * src/onboarding). The scenario waits for that turn to answer and for the
 * TUI to go idle before it sends its own turn. The composer placeholder is
 * not an anchor: it only shows before the first submit, and the starter
 * turn is that submit.
 */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { waitForFrameText } from "../helpers/frame.mjs";

export const meta = {
  description:
    "agenc onboard forces the setup wizard; completing it reaches a first model turn.",
  timeoutMs: 180_000,
  slimCwd: true,
  sandboxMode: "danger-full-access",
  args: ["onboard"],
};

export default async function (session) {
  await session.start();

  // Preflight renders as a full paint — anchor that the wizard is showing.
  // (Later steps repaint as cell diffs that split words with cursor jumps,
  // so phrase anchors are only reliable on this first screen; subsequent
  // steps are driven input→idle. The wizard's input protocol is fixed:
  // src/onboarding/Onboarding.tsx submitFirstRunOnboardingInput.)
  await session.waitFor(/Press Enter to continue/, { timeout: 60_000 });

  await session.submit("");
  await waitForFrameText(
    session,
    /Press Enter to keep (?:auto|dark|light)|Tip:.*terminal background/iu,
    "onboarding theme step",
    60_000,
  );
  await session.submit("1");
  await waitForFrameText(
    session,
    /type a number or provider slug/u,
    "onboarding provider step",
    60_000,
  );
  await session.submit("openai-compatible");
  await waitForFrameText(
    session,
    /Sign in or create an AgenC account/u,
    "onboarding model-access step",
    60_000,
  );

  const accessFrame = session.latestFrame;
  assert.match(
    accessFrame,
    /Sign in or create an AgenC account/u,
    "model access must offer AgenC account sign-in/signup",
  );
  assert.match(
    accessFrame,
    /Sign in with X \/ xAI/u,
    "model access must offer X / xAI sign-in",
  );
  assert.match(
    accessFrame,
    /Configure later/u,
    "model access must offer a credential-free continuation",
  );

  await session.submit("");
  await waitForFrameText(
    session,
    /Press Enter to (?:test openai-compatible|run the connection check)/u,
    "onboarding connection-check step",
    60_000,
  );
  await session.submit("");
  await waitForFrameText(
    session,
    /Press Enter to keep these security defaults/u,
    "onboarding security step",
    60_000,
  );
  await session.submit("");
  await waitForFrameText(
    session,
    /Press Enter to finish onboarding/u,
    "onboarding terminal-setup step",
    60_000,
  );
  await session.submit("");

  // Wizard done: the starter turn is the first model turn. Wait for its
  // answer and for the composer to accept input again.
  await waitForFrameText(
    session,
    /Introduce yourself in a sentence/u,
    "automatic onboarding starter turn",
    60_000,
  );
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForPrompt({ timeout: 30_000 });

  // A turn the user sends after onboarding completes against the mock model.
  // Match the reply row under the AGENC header: the transcript also shows the
  // submitted prompt, which contains the same word.
  await session.submit("reply with the single word ONBOARDED");
  await session.waitForAssistantReply({ timeout: 60_000 });
  await waitForFrameText(
    session,
    /\u2502 AGENC[^\n]*\n\u2502 ONBOARDED\b/u,
    "ONBOARDED reply",
    15_000,
  );
  await session.waitForIdle({ timeout: 30_000 });

  // The wizard persisted completion in the temp home.
  assert.ok(session.tempHome, "scenario must run under a temp home");
  const statePath = path.join(session.tempHome, ".agenc", "onboarding.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.completed, true, "onboarding.json must record completion");
}
