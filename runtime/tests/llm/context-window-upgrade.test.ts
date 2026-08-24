/**
 * Tests for the sync context-window upgrade-message helper used by the
 * post-compact stdout breadcrumb.
 */

import { afterEach, describe, expect, test } from "vitest";

import { getUpgradeMessage } from "./context-window-upgrade.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { ModelInfo } from "../session/turn-context.js";
import type { ModelsManager, Session } from "../session/session.js";

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

function buildSession(
  currentModel: string,
  models: ReadonlyArray<ModelInfo>,
): Session {
  return {
    config: { model: currentModel },
    services: { modelsManager: buildManager(models) },
  } as unknown as Session;
}

function withSession<T>(
  currentModel: string,
  models: ReadonlyArray<ModelInfo>,
  callback: () => T,
): T {
  return runWithCurrentRuntimeSession(
    buildSession(currentModel, models),
    callback,
  );
}

afterEach(() => {
  clearCurrentRuntimeSession();
});

describe("getUpgradeMessage", () => {
  test("returns null when no snapshot is registered", () => {
    expect(getUpgradeMessage("tip")).toBeNull();
    expect(getUpgradeMessage("warning")).toBeNull();
  });

  test("returns null when current model has no context window", () => {
    expect(
      withSession(
        "weird-model",
        [buildModel("weird-model", undefined)],
        () => getUpgradeMessage("tip"),
      ),
    ).toBeNull();
  });

  test("returns null when no same-family larger sibling exists", () => {
    expect(
      withSession(
        "grok-4",
        [
        buildModel("grok-4", 256_000),
        buildModel("gpt-5", 1_000_000),
        ],
        () => getUpgradeMessage("tip"),
      ),
    ).toBeNull();
  });

  test("emits a warning string with the upgrade slug", () => {
    expect(
      withSession(
        "claude-opus-4-7",
        [
        buildModel("claude-opus-4-7", 200_000),
        buildModel("claude-opus-4-7-1m", 1_000_000),
        ],
        () => getUpgradeMessage("warning"),
      ),
    ).toBe("/model claude-opus-4-7-1m");
  });

  test("emits a multiplier-aware tip when upgrade is at least 2x larger", () => {
    expect(
      withSession(
        "claude-opus-4-7",
        [
        buildModel("claude-opus-4-7", 200_000),
        buildModel("claude-opus-4-7-1m", 1_000_000),
        ],
        () => getUpgradeMessage("tip"),
      ),
    ).toBe(
      "Tip: You have access to claude-opus-4-7-1m with 5x more context",
    );
  });

  test("emits a generic larger-window tip when upgrade is less than 2x", () => {
    expect(
      withSession(
        "gpt-5",
        [
        buildModel("gpt-5", 1_000_000),
        buildModel("gpt-5-pro", 1_500_000),
        ],
        () => getUpgradeMessage("tip"),
      ),
    ).toBe(
      "Tip: You have access to gpt-5-pro with a larger context window",
    );
  });

  test("prefers the smallest qualifying upgrade", () => {
    expect(
      withSession(
        "grok-4",
        [
        buildModel("grok-4", 256_000),
        buildModel("grok-4-large", 512_000),
        buildModel("grok-4-huge", 2_000_000),
        ],
        () => getUpgradeMessage("warning"),
      ),
    ).toBe("/model grok-4-large");
  });

  test("keeps concurrent session model catalogs isolated", async () => {
    const sessionA = buildSession("grok-4", [
      buildModel("grok-4", 256_000),
      buildModel("grok-4-large", 512_000),
    ]);
    const sessionB = buildSession("gpt-5", [
      buildModel("gpt-5", 1_000_000),
      buildModel("gpt-5-pro", 1_500_000),
    ]);

    const [messageA, messageB] = await Promise.all([
      runWithCurrentRuntimeSession(sessionA, async () => {
        await Promise.resolve();
        return getUpgradeMessage("warning");
      }),
      runWithCurrentRuntimeSession(sessionB, async () => {
        await Promise.resolve();
        return getUpgradeMessage("warning");
      }),
    ]);

    expect(messageA).toBe("/model grok-4-large");
    expect(messageB).toBe("/model gpt-5-pro");
  });
});
