/**
 * The daemon sizes a prompt before publishing it, for the turn it starts: a
 * skill turn on the skill's own model and context window, every other turn on
 * the session's.
 */
import { afterEach, expect, test, vi } from "vitest";

import { setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import type { Session } from "../../src/session/session.js";
import type { SkillInvocationTurnOverrides } from "../../src/session/turn-context.js";
import { installPreparedCompactionPressure } from "../helpers/prepared-compaction-pressure.js";
import { mkProvider, mkSession } from "../fixtures.js";

function setup() {
  const provider = mkProvider({ content: "ok" });
  installPreparedCompactionPressure(provider, (request) => 500 + request.messages.reduce((n, m) => {
    const text = typeof m.content === "string"
      ? m.content
      : m.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    // Count the controlled fixture input, ignoring runtime reminder messages.
    return n + (/^x+$/.test(text) ? text.length : 0);
  }, 0));
  const { session, events } = mkSession({
    provider,
    model: "test-model",
    modelInfo: { contextWindow: 4096, maxOutputTokens: 2048 },
  });
  setAutoCompactImplForTests(vi.fn(async () => ({ wasCompacted: false, skippedCode: "no_shrink" as const })));
  return { session, events };
}

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

function skillTurn(session: Session, model: string, contextWindow: number): SkillInvocationTurnOverrides {
  return {
    invocation: { name: "sized-skill", requested: { model }, model, allowedTools: [] },
    modelInfo: { ...session.modelInfo, slug: model, contextWindow, maxOutputTokens: 2048 },
  };
}

test("the daemon preflight sizes a skill turn's prompt on the skill's model", async () => {
  const { session, events } = setup();

  // 5,000 characters do not fit the session's model (2,572 left), but fit a
  // skill model with a larger window.
  await expect(session.assertUserPromptFits("x".repeat(5000))).rejects.toThrow(/prompt.*5,000.*2,572/is);
  await expect(
    session.assertUserPromptFits("x".repeat(5000), skillTurn(session, "wide-model", 100_000)),
  ).resolves.toBeUndefined();

  // 2,000 fit the session's model, but not a skill model with a smaller one.
  await expect(session.assertUserPromptFits("x".repeat(2000))).resolves.toBeUndefined();
  await expect(
    session.assertUserPromptFits("x".repeat(2000), skillTurn(session, "narrow-model", 3072)),
  ).rejects.toThrow(/prompt.*2,000.*1,548/is);

  expect(events.some((event) => event.msg.type === "user_message")).toBe(false);
  // The session keeps its own model.
  expect(session.config.model).toBe("test-model");
});
