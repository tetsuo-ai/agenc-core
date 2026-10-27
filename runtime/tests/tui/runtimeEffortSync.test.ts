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
