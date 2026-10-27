/**
 * A model switch applies without printing its provider diagnostics.
 *
 * Owner report (0.19.11): after switching from Venice to DeepSeek, the
 * transcript showed the raw `provider_switched` warning, "provider venice ->
 * deepseek; model ... -> deepseek-flash; previous_response_id reset; ...".
 * The /model command already says what changed, so that line is diagnosis
 * data for the session event log only.
 *
 * This drives the owner's switch through the real TUI and daemon: Venice at
 * medium effort, `/model deepseek-flash`, then one more turn. DeepSeek has no
 * medium level, so the effort falls back to the model default. The switch
 * must apply to the next turn, the warning must stay in the event log, and no
 * frame may show it. Both providers point at the local mock model.
 */
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModelServer } from "../../local-openai-compatible-mock.mjs";

export const meta = {
  description: "A model switch applies without printing provider diagnostics.",
  timeoutMs: 120_000,
};

const SWITCH_DIAGNOSTICS =
  "provider venice -> deepseek; model qwen3-5-35b-a3b -> deepseek-flash; " +
  "previous_response_id reset; deepseek-flash does not support medium " +
  "reasoning effort, so the session now uses its default effort.";

async function rolloutAfterSwitch(session) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    session.throwIfAborted();
    const items = await session.readRolloutItems();
    const warnings = items
      .filter((item) => item.type === "event_msg")
      .map((item) => item.payload.msg)
      .filter((msg) => msg?.type === "warning" && msg.payload?.cause === "provider_switched");
    const turns = items
      .filter((item) => item.type === "turn_context")
      .map((item) => item.payload);
    if ((warnings.length > 0 && turns.length >= 2) || Date.now() > deadline) {
      return { warnings, turns };
    }
    await delay(100);
  }
}

export default async function (session) {
  // A saved effort level, as the owner had. Venice's qwen3-5-35b-a3b accepts it.
  await appendFile(
    join(session.gateState.agencHome, "config.toml"),
    'reasoning_effort = "medium"\n',
  );
  const mock = await startMockModelServer();
  try {
    Object.assign(session.envOverrides, {
      AGENC_PROVIDER: "venice",
      AGENC_MODEL: "qwen3-5-35b-a3b",
      VENICE_API_KEY: "local-inert-switch-key",
      VENICE_BASE_URL: `${mock.baseUrl}/v1`,
      DEEPSEEK_API_KEY: "local-inert-switch-key",
      DEEPSEEK_BASE_URL: `${mock.baseUrl}/v1`,
      AGENC_AUTH_MANAGED_KEYS_ENABLED: "0",
    });
    await session.start();
    await session.waitForPrompt({ timeout: 15_000 });
    await session.submit("Reply with the single word ALPHA");
    await session.waitForAssistantReply({ timeout: 30_000 });
    await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });

    // The command feedback still tells the user about the effort fallback.
    await session.submitSlashCommand("/model deepseek-flash");
    await session.waitFor(
      /Model switched to "deepseek-flash" on "deepseek"[\s\S]*?does not support medium/u,
      { timeout: 15_000, label: "/model feedback" },
    );
    await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });

    // The pending switch is published when the next turn starts.
    await session.submit("Reply with the single word BRAVO");
    await session.waitForAssistantReply({ timeout: 30_000 });
    await session.waitForIdle({ idleWindow: 1_500, timeout: 15_000 });

    const { warnings, turns } = await rolloutAfterSwitch(session);
    assert.deepEqual(
      warnings.map((msg) => msg.payload.message),
      [SWITCH_DIAGNOSTICS],
      "the switch diagnostics stay in the session event log",
    );
    assert.deepEqual(
      turns.map((turn) => [turn.modelProviderId, turn.model, turn.effort ?? null]),
      [
        ["venice", "qwen3-5-35b-a3b", "medium"],
        ["deepseek", "deepseek-flash", null],
      ],
      "the next turn runs on DeepSeek at its default effort",
    );

    // Read the whole PTY stream: a transient row must not slip through.
    const shown = /[^\r\n]*previous_response_id[^\r\n]*/u.exec(session.plainText)?.[0] ??
      /[^\n]*provider venice -> deepseek[^\n]*/u.exec(session.latestFrame)?.[0];
    assert.equal(shown, undefined, `the switch diagnostics reached the screen: ${shown}`);
  } finally {
    await mock.close();
  }
}
