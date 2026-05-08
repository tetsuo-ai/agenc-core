/**
 * Multi-tool pipeline scenario.
 *
 * Asks the model to do a multi-step task that requires more than one
 * Bash invocation. Catches: tool-chain regressions, between-call state
 * loss, model-side handoff bugs.
 */
export const meta = {
  description: "--yolo: model chains two Bash calls in a single turn.",
  args: ["--yolo"],
  timeoutMs: 120_000,
  // The model (qwen3 via LMStudio) often only runs the first echo and
  // narrates the second instead of actually invoking Bash for it. The
  // chain pattern we need is provider/model-dependent and unstable in
  // CI; either prompt-engineer harder or pin a more obedient model.
  // Until then, skip.
  skip: "model-dependent: chain not reliably triggered with current LMStudio config",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool twice: first run 'echo step-one-pipeline', then run 'echo step-two-pipeline'.",
  );
  await session.submit();
  await session.waitFor(/step-one-pipeline/, {
    timeout: 90_000,
    label: "step one output",
  });
  await session.waitFor(/step-two-pipeline/, {
    timeout: 60_000,
    label: "step two output",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
