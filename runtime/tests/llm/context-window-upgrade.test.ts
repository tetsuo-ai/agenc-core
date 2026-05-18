/**
 * Tests for the sync context-window upgrade-message helper used by the
 * post-compact stdout breadcrumb.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  getUpgradeMessage,
  setContextWindowUpgradeContext,
} from "./context-window-upgrade.js";
import type { ModelInfo } from "../session/turn-context.js";
import type { ModelsManager } from "../session/session.js";

function buildModel(slug: string, contextWindow: number | undefined): ModelInfo {
  return {
    slug,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    effectiveContextWindowPercent: 95,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function buildManager(models: ReadonlyArray<ModelInfo>): ModelsManager {
  return {
    async getModelInfo(slug: string) {
      return models.find((m) => m.slug === slug) ?? buildModel(slug, undefined);
    },
    tryListModels() {
      return models;
    },
    async listModels() {
      return models;
    },
  };
}

afterEach(() => {
  setContextWindowUpgradeContext(null);
});

describe("getUpgradeMessage", () => {
  test("returns null when no snapshot is registered", () => {
    expect(getUpgradeMessage("tip")).toBeNull();
    expect(getUpgradeMessage("warning")).toBeNull();
  });

  test("returns null when current model has no context window", () => {
    setContextWindowUpgradeContext({
      currentModel: "weird-model",
      modelsManager: buildManager([buildModel("weird-model", undefined)]),
    });
    expect(getUpgradeMessage("tip")).toBeNull();
  });

  test("returns null when no same-family larger sibling exists", () => {
    setContextWindowUpgradeContext({
      currentModel: "grok-4",
      modelsManager: buildManager([
        buildModel("grok-4", 256_000),
        buildModel("gpt-5", 1_000_000),
      ]),
    });
    expect(getUpgradeMessage("tip")).toBeNull();
  });

  test("emits a warning string with the upgrade slug", () => {
    setContextWindowUpgradeContext({
      currentModel: "claude-opus-4-7",
      modelsManager: buildManager([
        buildModel("claude-opus-4-7", 200_000),
        buildModel("claude-opus-4-7-1m", 1_000_000),
      ]),
    });
    expect(getUpgradeMessage("warning")).toBe("/model claude-opus-4-7-1m");
  });

  test("emits a multiplier-aware tip when upgrade is at least 2x larger", () => {
    setContextWindowUpgradeContext({
      currentModel: "claude-opus-4-7",
      modelsManager: buildManager([
        buildModel("claude-opus-4-7", 200_000),
        buildModel("claude-opus-4-7-1m", 1_000_000),
      ]),
    });
    expect(getUpgradeMessage("tip")).toBe(
      "Tip: You have access to claude-opus-4-7-1m with 5x more context",
    );
  });

  test("emits a generic larger-window tip when upgrade is less than 2x", () => {
    setContextWindowUpgradeContext({
      currentModel: "gpt-5",
      modelsManager: buildManager([
        buildModel("gpt-5", 1_000_000),
        buildModel("gpt-5-pro", 1_500_000),
      ]),
    });
    expect(getUpgradeMessage("tip")).toBe(
      "Tip: You have access to gpt-5-pro with a larger context window",
    );
  });

  test("prefers the smallest qualifying upgrade", () => {
    setContextWindowUpgradeContext({
      currentModel: "grok-4",
      modelsManager: buildManager([
        buildModel("grok-4", 256_000),
        buildModel("grok-4-large", 512_000),
        buildModel("grok-4-huge", 2_000_000),
      ]),
    });
    expect(getUpgradeMessage("warning")).toBe("/model grok-4-large");
  });
});
