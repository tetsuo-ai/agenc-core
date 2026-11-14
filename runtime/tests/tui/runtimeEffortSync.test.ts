import { expect, it, vi } from "vitest";
import { syncRuntimeEffortEventToAppState } from "../../src/tui/state/runtimeEffortSync.js";
import type { AppState } from "../../src/tui/state/AppState.js";
import { getSessionEffortLabelForContext } from "../../src/utils/effort.js";
import { getEffortNotificationText } from "../../src/tui/components/EffortIndicator.js";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "./remoteAuthSessionContext.fixture.js";

it("displays canonical none as effort off in both footer and notification", () => {
  expect(getSessionEffortLabelForContext("gpt-5.4", "none" as never, TEST_REMOTE_AUTH_SESSION_CONTEXT)).toBe("effort off");
  expect(getEffortNotificationText("none" as never, "gpt-5.4", TEST_REMOTE_AUTH_SESSION_CONTEXT)).toBe("effort off · /effort");
});

it("uses the canonical reload effort instead of a stale session choice", () => {
  let state = { effortValue: "max" } as AppState;
  const set = (update: (value: AppState) => AppState) => { state = update(state); };
  syncRuntimeEffortEventToAppState({ type: "run_runtime_settings_changed", payload: { reasoningEffort: "high" } }, set);
  expect(state.effortValue).toBe("high");
  syncRuntimeEffortEventToAppState({ msg: { type: "run_runtime_settings_changed", payload: { reasoningEffort: "none" } } }, set);
  expect(state.effortValue).toBe("none");
  syncRuntimeEffortEventToAppState({ type: "run_runtime_settings_changed", payload: { reasoningEffort: null } }, set);
  expect(state.effortValue).toBeUndefined();
});
it("ignores unrelated or malformed effort events", () => {
  const set = vi.fn();
  for (const event of [{ type: "warning", payload: { reasoningEffort: "high" } }, { type: "run_runtime_settings_changed", payload: {} }, { type: "run_runtime_settings_changed", payload: { reasoningEffort: "deep" } }]) syncRuntimeEffortEventToAppState(event, set);
  expect(set).not.toHaveBeenCalled();
});

it("marks an effort that arrives with the session's initial settings, so the prompt does not flash it", () => {
  let state = {} as AppState;
  const set = (update: (value: AppState) => AppState) => { state = update(state); };
  // The lean Light request defaults native DeepSeek to low; the initial settings carry it.
  syncRuntimeEffortEventToAppState({ type: "run_runtime_settings_changed", payload: { reason: "initial", reasoningEffort: "low" } }, set);
  expect(state.effortValue).toBe("low");
  expect(state.effortFromInitialSettings).toBe(true);
  // A later change (a model switch or a config reload) is a real change again.
  syncRuntimeEffortEventToAppState({ type: "run_runtime_settings_changed", payload: { reason: "model_provider_changed", reasoningEffort: "high" } }, set);
  expect(state.effortValue).toBe("high");
  expect(state.effortFromInitialSettings).toBe(false);
});
