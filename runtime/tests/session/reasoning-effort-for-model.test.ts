import { describe, expect, test } from "vitest";
import type { AgenCConfig } from "../../src/config/schema.js";
import {
  droppedReasoningEffortNotice,
  reasoningEffortForModel,
  withSessionReasoningEffort,
} from "../../src/session/reasoning-effort-for-model.js";

const kept = (reasoningEffort: string) => ({ reasoningEffort });
const dropped = (reasoningEffort: string) => ({
  reasoningEffort: undefined,
  dropped: reasoningEffort,
});

describe("reasoning effort across a model switch", () => {
  test.each([
    // The two reported cases: /effort default used to pin these.
    ["gemini", "gemma-4-31b-it", "medium", false],
    ["openai", "gpt-6-sol", "none", true],
    // A level the new model lists stays.
    ["gemini", "gemma-4-31b-it", "high", true],
    ["gemini", "gemini-3.1-pro-preview", "high", true],
    ["grok", "grok-4.6", "low", true],
    ["mistral", "mistral-medium-latest", "none", true],
    ["deepseek", "deepseek-v4-flash", "max", true],
    // A level it does not list goes, as the old switch check refused it.
    ["gemini", "gemini-3.1-pro-preview", "xhigh", false],
    ["gemini", "gemini-3.1-pro-preview", "minimal", false],
    ["gemini", "gemini-3-pro-preview", "medium", false],
    ["grok", "grok-4.6", "minimal", false],
    ["gemini", "gemini-2.5-flash", "high", false],
    ["deepseek", "deepseek-v4-flash", "medium", false],
    // None is checked too: Gemini sends no thinking config for it, so the
    // model would think at its default while the session claimed "off".
    ["gemini", "gemini-3.5-flash", "none", false],
    ["gemini", "gemini-2.5-flash", "none", false],
    // Sonnet 5.5 turns up-front reasoning off with none, outside its levels.
    ["anthropic", "claude-sonnet-5-5", "none", true],
    ["anthropic", "claude-opus-5-5", "none", false],
    // A model that takes no effort at all drops any level.
    ["grok", "grok-4", "high", false],
    ["anthropic", "claude-haiku-4-5", "low", false],
  ] as const)("%s/%s keeps %s: %s", (provider, model, reasoningEffort, keeps) => {
    expect(reasoningEffortForModel({ provider, model, reasoningEffort })).toEqual(
      keeps ? kept(reasoningEffort) : dropped(reasoningEffort),
    );
  });

  test("a session with no effort has nothing to keep or drop", () => {
    expect(
      reasoningEffortForModel({
        provider: "gemini",
        model: "gemma-4-31b-it",
        reasoningEffort: undefined,
      }),
    ).toEqual({ reasoningEffort: undefined });
  });

  test("a configured capability override that rules effort out drops it", () => {
    const config = {
      providers: { grok: { capability_overrides: { acceptsReasoningEffort: false } } },
    } as unknown as AgenCConfig;
    const effort = { provider: "grok", model: "grok-4.6", reasoningEffort: "high" };
    expect(reasoningEffortForModel(effort)).toEqual(kept("high"));
    expect(reasoningEffortForModel({ ...effort, config })).toEqual(dropped("high"));
  });

  test("a Bedrock profile is judged as the Claude model a configured override maps it to", () => {
    const profile =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
    const effort = (config: unknown) =>
      reasoningEffortForModel({
        provider: "amazon-bedrock",
        model: profile,
        reasoningEffort: "max",
        config: config as AgenCConfig,
      });
    expect(effort({ modelOverrides: { "claude-opus-5-5": profile } })).toEqual(kept("max"));
    // Unmapped, the profile names no model and cannot take the effort.
    expect(effort({})).toEqual(dropped("max"));
  });

  test("clears a level on purpose, and a later level ends the cleared state", () => {
    const configuration = {
      cwd: "/repo",
      collaborationMode: { model: "grok-4.6", reasoningEffort: "high" as const },
    };
    const cleared = withSessionReasoningEffort(configuration, null);
    expect(cleared).toEqual({
      cwd: "/repo",
      collaborationMode: { model: "grok-4.6" },
      reasoningEffortCleared: true,
    });
    expect(withSessionReasoningEffort(cleared, "low")).toEqual({
      cwd: "/repo",
      collaborationMode: { model: "grok-4.6", reasoningEffort: "low" },
    });
  });

  test("tells the user which level the new model does not take", () => {
    expect(droppedReasoningEffortNotice("gemma-4-31b-it", "medium")).toBe(
      "gemma-4-31b-it does not support medium reasoning effort, so the session now uses its default effort.",
    );
    expect(droppedReasoningEffortNotice("gemini-3.5-flash", "none")).toBe(
      "gemini-3.5-flash cannot turn reasoning off, so the session now uses its default effort.",
    );
  });
});
