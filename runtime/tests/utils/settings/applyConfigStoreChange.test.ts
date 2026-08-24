import { describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../../src/config/store.js";
import { defaultConfig } from "../../../src/config/schema.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import type { AppState } from "../../../src/tui/state/AppState.js";
import { applyConfigStoreChange } from "../../../src/utils/settings/applyConfigStoreChange.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";

describe("applyConfigStoreChange", () => {
  test("projects the supplied session store instead of an ambient authority", async () => {
    const sessionStore = new ConfigStore({
      base: {
        ...defaultConfig(),
        reasoning_effort: "high",
        swarmMode: true,
      },
      env: {},
    });
    const ambientStore = new ConfigStore({
      base: {
        ...defaultConfig(),
        reasoning_effort: "low",
        swarmMode: false,
      },
      env: {},
    });
    let state = {
      settings: ambientStore.current(),
      toolPermissionContext: createEmptyToolPermissionContext(),
    } as AppState;
    const setAppState = vi.fn((update: (previous: AppState) => AppState) => {
      state = update(state);
    });

    runWithCanonicalSettingsAuthority(ambientStore, () => {
      applyConfigStoreChange(sessionStore, setAppState);
    });

    await vi.waitFor(() => expect(setAppState).toHaveBeenCalledTimes(1));
    expect(state.settings.reasoning_effort).toBe("high");
    expect(state.settings.swarmMode).toBe(true);
    expect(state.effortValue).toBe("high");
    expect(state.swarmMode).toBe(true);
  });
});
