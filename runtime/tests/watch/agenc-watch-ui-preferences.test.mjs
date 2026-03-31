import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchLocalConfigReport,
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

test("createWatchUiPreferences normalizes matrix aliases", () => {
  const preferences = createWatchUiPreferences({
    themeName: "neo",
  });

  assert.equal(preferences.themeName, "matrix");
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

test("buildWatchLocalConfigReport includes statusline and quick toggles", () => {
  const report = buildWatchLocalConfigReport({
    preferences: {
      inputModeProfile: "vim",
      keybindingProfile: "vim",
      themeName: "aurora",
    },
    composerMode: "insert",
    statuslineEnabled: true,
  });

  assert.match(report, /Statusline: on/);
  assert.match(report, /- \/vim \[show\|on\|off\|toggle\]/);
  assert.match(report, /- \/statusline \[show\|on\|off\|toggle\]/);
  assert.match(report, /- \/theme \[show\|default\|aurora\|ember\|matrix\]/);
});
