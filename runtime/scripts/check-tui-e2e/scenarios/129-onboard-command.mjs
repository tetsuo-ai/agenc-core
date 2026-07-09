/**
 * `agenc onboard` scenario (TODO task 2).
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
  useTempHome: true,
  slimCwd: true,
  args: ["onboard"],
};

export default async function (session) {
  await session.start();

  // Preflight renders as a full paint — anchor that the wizard is showing.
  // (Later steps repaint as cell diffs that split words with cursor jumps,
  // so phrase anchors are only reliable on this first screen; subsequent
  // steps are driven input→idle. The wizard's input protocol is fixed:
  // src/onboarding/Onboarding.tsx submitFirstRunOnboardingInput.)
  await session.waitFor(/Type next to continue\./, { timeout: 60_000 });

  const wizardInputs = [
    "next", // preflight → theme
    "1", // theme: dark → provider
    "openai-compatible", // provider (mock server) → api-key
    "next", // api-key: keyless local provider → connection-test
    "next", // connection-test: runs the mock-server check → security
    "next", // security: keep defaults → terminal-setup
    "done", // terminal-setup: finish onboarding
  ];
  for (const input of wizardInputs) {
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
