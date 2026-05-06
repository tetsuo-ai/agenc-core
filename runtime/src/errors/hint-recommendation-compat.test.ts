import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  _resetAgenCCodeHintStore,
  getPendingHintSnapshot,
} from "./hints.js";

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
}));

vi.mock("../agenc/upstream/services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn(() => true),
}));

vi.mock("../agenc/upstream/services/analytics/index.js", () => ({
  logEvent: vi.fn(),
}));

vi.mock("../agenc/upstream/utils/config.js", () => ({
  getGlobalConfig: () => state.config,
  saveGlobalConfig: (
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    state.config = updater(state.config);
  },
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: vi.fn(),
}));

vi.mock("../agenc/upstream/utils/plugins/installedPluginsManager.js", () => ({
  isPluginInstalled: vi.fn(() => false),
}));

vi.mock("../agenc/upstream/utils/plugins/marketplaceManager.js", () => ({
  getPluginById: vi.fn(async (pluginId: string) => ({
    entry: { name: pluginId, description: "test plugin" },
  })),
}));

vi.mock("../agenc/upstream/utils/plugins/pluginIdentifier.js", () => ({
  isOfficialMarketplaceName: vi.fn((marketplace: string | undefined) =>
    marketplace === "official",
  ),
  parsePluginIdentifier: vi.fn((pluginId: string) => {
    const [name, marketplace] = pluginId.split("@");
    return { name, marketplace };
  }),
}));

vi.mock("../agenc/upstream/utils/plugins/pluginPolicy.js", () => ({
  isPluginBlockedByPolicy: vi.fn(() => false),
}));

import {
  _resetHintRecommendationForTesting,
  disableHintRecommendations,
  markHintPluginShown,
  maybeRecordPluginHint,
} from "../agenc/upstream/utils/plugins/hintRecommendation.js";

describe("hint recommendation config compatibility", () => {
  beforeEach(() => {
    state.config = {};
    _resetAgenCCodeHintStore();
    _resetHintRecommendationForTesting();
  });

  test("honors disabled legacy hint state", () => {
    state.config = {
      // branding-scan: allow persisted legacy config key
      claudeCodeHints: { disabled: true },
    };

    maybeRecordPluginHint({
      v: 1,
      type: "plugin",
      value: "lint@official",
      sourceCommand: "lint",
    });

    expect(getPendingHintSnapshot()).toBeNull();
  });

  test("migrates shown-plugin state when recording a prompt", () => {
    state.config = {
      // branding-scan: allow persisted legacy config key
      claudeCodeHints: { plugin: ["old@official"] },
    };

    markHintPluginShown("new@official");

    expect(state.config).toMatchObject({
      agencCodeHints: { plugin: ["old@official", "new@official"] },
      // branding-scan: allow persisted legacy config key
      claudeCodeHints: { plugin: ["old@official"] },
    });
  });

  test("migrates disabled state without losing shown plugins", () => {
    state.config = {
      // branding-scan: allow persisted legacy config key
      claudeCodeHints: { plugin: ["old@official"] },
    };

    disableHintRecommendations();

    expect(state.config).toMatchObject({
      agencCodeHints: { plugin: ["old@official"], disabled: true },
    });
  });
});
