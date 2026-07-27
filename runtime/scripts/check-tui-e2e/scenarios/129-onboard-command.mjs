/**
 * `agenc onboard` scenario.
 *
 * The explicit onboard subcommand boots the TUI with the first-run wizard
 * forced. Drive the whole wizard with the mock openai-compatible provider
 * (keyless local provider path), finish it, then complete a real first turn
 * against the mock model — the Phase 0 acceptance criterion.
 */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

  const setupInputs = [
    "", // preflight: Enter → theme
    "1", // theme: dark → provider
    "openai-compatible", // provider (mock server) → model access
  ];
  for (const input of setupInputs) {
    await session.submit(input);
    await session.waitForIdle({ timeout: 60_000 });
  }

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

  const remainingWizardInputs = [
    "", // model access: Enter configures later → connection-test
    "", // connection-test: Enter runs the mock-server check → security
    "", // security: Enter keeps defaults → terminal-setup
    "", // terminal-setup: Enter finishes onboarding
  ];
  for (const input of remainingWizardInputs) {
    await session.submit(input);
    // Bytes-quiet is the only repaint-agnostic step barrier; a rejected
    // input stalls the wizard and the post-wizard asserts below fail loudly.
    await session.waitForIdle({ timeout: 60_000 });
  }

  // Wizard done: the normal composer prompt appears; complete a first turn.
  await session.waitForPrompt({ timeout: 60_000 });
  await session.submit("reply with the single word ONBOARDED");
  await session.waitFor(/ONBOARDED/, { timeout: 60_000 });
  await session.waitForIdle({ timeout: 30_000 });

  // The wizard persisted completion in the temp home.
  assert.ok(session.tempHome, "scenario must run under a temp home");
  const statePath = path.join(session.tempHome, ".agenc", "onboarding.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.completed, true, "onboarding.json must record completion");
}
