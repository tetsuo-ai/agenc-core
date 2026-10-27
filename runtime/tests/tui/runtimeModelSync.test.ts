import { expect, it, vi } from "vitest";
import { syncRuntimeModelEventToAppState } from "../../src/tui/state/runtimeModelSync.js";
import type { AppState } from "../../src/tui/state/AppState.js";

it("replaces stale command chrome with the canonical model and preserves other state", () => {
  let state = { mainLoopModel: "deepseek-v4-pro", mainLoopModelForSession: "deepseek-v4-pro", effortValue: "max" } as AppState;
  const set = (update: (previous: AppState) => AppState) => { state = update(state); };
  syncRuntimeModelEventToAppState({ msg: { type: "run_runtime_settings_changed", payload: { provider: "deepseek", model: "deepseek-flash" } } }, set);
  expect(state).toMatchObject({ mainLoopModel: "deepseek-flash", mainLoopModelForSession: "deepseek-flash", effortValue: "max" });
  const previous = state;
  syncRuntimeModelEventToAppState({ type: "run_runtime_settings_changed", payload: { provider: "deepseek", model: "deepseek-flash" } }, set);
  expect(state).toBe(previous);
});

it("ignores unrelated events and incomplete or invalid provider/model pairs", () => {
  const set = vi.fn();
  for (const event of [
    { type: "warning", payload: { provider: "deepseek", model: "deepseek-flash" } },
    { type: "run_runtime_settings_changed", payload: { model: "deepseek-flash" } },
    { type: "run_runtime_settings_changed", payload: { provider: "unknown", model: "deepseek-flash" } },
    { type: "run_runtime_settings_changed", payload: { provider: "deepseek", model: "" } },
    { type: "run_runtime_settings_changed", payload: { provider: "deepseek", model: " deepseek-flash " } },
  ]) syncRuntimeModelEventToAppState(event, set);
  expect(set).not.toHaveBeenCalled();
});
