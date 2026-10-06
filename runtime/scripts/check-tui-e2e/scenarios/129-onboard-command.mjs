/**
 * `agenc onboard` scenario.
 *
 * The explicit onboard subcommand boots the TUI with the first-run wizard
 * forced. Drive the whole wizard with the mock openai-compatible provider
 * (keyless local provider path): theme, the provider list narrowed by
 * typing, the readiness check that runs when a running provider is picked,
 * the model-access options, and the Ready summary. Finishing setup sends
 * nothing on the user's behalf, so the first model turn is the scenario's
 * own (the Phase 0 acceptance criterion).
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

  // The theme card is the first full paint. Later steps repaint as cell
  // diffs, so they are read from the rendered frame instead of the raw
  // stream. The wizard's input protocol is fixed in
  // src/onboarding/Onboarding.tsx submitFirstRunOnboardingInput.
  await session.waitFor(/How\s*should\s*AgenC\s*look/, { timeout: 60_000 });

  await session.submit("1");
  await waitForFrameText(
    session,
    /Which provider should AgenC use\?/u,
    "onboarding provider step",
    60_000,
  );
  // The mock answers on the configured local endpoint, so the list shows it
  // as running, with the same wording as /providers.
  await waitForFrameText(
    session,
    /OpenAI-compatible\s+running/u,
    "running local provider in the list",
    30_000,
  );

  // Typing narrows the list as the user types, before Enter.
  await session.type("compat");
  await waitForFrameText(
    session,
    /Enter picks the highlighted provider\./u,
    "provider list narrowed to the typed text",
    30_000,
  );
  assert.match(
    session.latestFrame,
    /› OpenAI-compatible\s+running/u,
    "the matching provider is highlighted",
  );
  assert.doesNotMatch(
    session.latestFrame,
    /xAI Grok/u,
    "typing narrows the list to matching providers",
  );

  // Enter on a running provider checks it in place. The mock lists one
  // model, so there is nothing to choose and the result shows.
  await session.submit("");
  await waitForFrameText(
    session,
    /✓ openai-compatible is running and \S+ is available\./u,
    "readiness result after picking a running provider",
    60_000,
  );

  // back opens the model-access options for this provider. The result card
  // asks the same question, so wait for an option row instead.
  await session.submit("back");
  await waitForFrameText(
    session,
    /How should AgenC reach openai-compatible[\s\S]*Set up later/u,
    "onboarding model-access step",
    60_000,
  );

  const accessFrame = session.latestFrame;
  assert.match(
    accessFrame,
    /This machine\s+no key needed, check it is running/u,
    "a local provider's own option comes first and needs no key",
  );
  assert.match(
    accessFrame,
    /AgenC account\s+sign in for hosted models/u,
    "model access must offer AgenC account sign-in/signup",
  );
  assert.match(
    accessFrame,
    /Set up later/u,
    "model access must offer a credential-free continuation",
  );
  assert.doesNotMatch(
    accessFrame,
    /X \/ xAI/u,
    "X / xAI sign-in is only offered for Grok",
  );

  // Enter picks the highlighted local option and runs the check in place.
  await session.submit("");
  await waitForFrameText(
    session,
    /✓ openai-compatible is running and \S+ is available\./u,
    "onboarding readiness result",
    60_000,
  );
  await session.submit("");
  await waitForFrameText(
    session,
    /AgenC is set up for this machine\./u,
    "onboarding ready step",
    60_000,
  );
  const readyFrame = session.latestFrame;
  assert.match(readyFrame, /Access\s+local, no key needed/u);
  assert.match(readyFrame, /Model\s+openai-compatible \//u);
  await session.submit("");

  // Wizard done. Nothing was sent for the user: the composer is idle and the
  // transcript has no model turn yet.
  await session.waitForPrompt({ timeout: 30_000 });
  assert.doesNotMatch(
    session.text,
    /Introduce yourself/u,
    "finishing setup must not send a starter message",
  );

  // The first turn is the user's own, against the mock model. Match the
  // agent's reply row (a ● then the text): the transcript also shows the
  // submitted prompt, which contains the same word after a ❯.
  await session.submit("reply with the single word ONBOARDED");
  await session.waitForAssistantReply({ timeout: 60_000 });
  await waitForFrameText(
    session,
    /^\s*\u25cf ONBOARDED\b/mu,
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
