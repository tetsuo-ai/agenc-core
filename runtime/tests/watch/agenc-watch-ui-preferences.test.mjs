import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchUiPreferencesReport,
  createWatchUiPreferences,
} from "../../src/watch/agenc-watch-ui-preferences.mjs";

test("createWatchUiPreferences normalizes persisted values", () => {
  const preferences = createWatchUiPreferences({
    inputModeProfile: "vim",
    keybindingProfile: "vim",
    themeName: "sunset",
  });

  assert.deepEqual(preferences, {
    inputModeProfile: "vim",
    keybindingProfile: "vim",
    themeName: "ember",
  });
});

test("buildWatchUiPreferencesReport renders the active mode and theme", () => {
  const report = buildWatchUiPreferencesReport({
    preferences: {
      inputModeProfile: "vim",
      keybindingProfile: "vim",
      themeName: "aurora",
    },
    composerMode: "normal",
  });

  assert.match(report, /Input mode: vim \(normal\)/);
  assert.match(report, /Theme: aurora/);
});
