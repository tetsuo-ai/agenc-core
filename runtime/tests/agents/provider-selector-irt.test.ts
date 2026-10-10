import { describe, expect, test } from "vitest";

import {
  IRT_REVISION,
  predictSuccess,
  updateAbility,
  validAbility,
  validFeatures,
  type ModelAbility,
  type TaskFeatures,
} from "../../src/agents/provider-selector-irt.js";

function features(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    skill: "coding",
    difficulty: 0,
    discrimination: 1,
    ...overrides,
  };
}

function ability(overrides: Partial<ModelAbility> = {}): ModelAbility {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    skill: "coding",
    revision: IRT_REVISION,
    mean: 0,
    variance: 1.5,
    observations: 0,
    ...overrides,
  };
}

describe("validFeatures", () => {
  test("accepts finite skill, difficulty, and discrimination inside the published bounds", () => {
    expect(validFeatures(features())).toBe(true);
    expect(validFeatures(features({ difficulty: 6, discrimination: 0.25 }))).toBe(true);
    expect(validFeatures(features({ difficulty: -6, discrimination: 2 }))).toBe(true);
  });

  test("rejects unknown skills and values outside the published bounds", () => {
    expect(validFeatures(features({ skill: "general" as TaskFeatures["skill"] }))).toBe(
      false,
    );
    expect(validFeatures(features({ difficulty: 6.0001 }))).toBe(false);
    expect(validFeatures(features({ difficulty: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(validFeatures(features({ discrimination: 0.249 }))).toBe(false);
    expect(validFeatures(features({ discrimination: 2.001 }))).toBe(false);
    expect(validFeatures(features({ discrimination: Number.NaN }))).toBe(false);
  });
});

describe("validAbility", () => {
  test("accepts a current-revision posterior inside the published bounds", () => {
    expect(validAbility(ability())).toBe(true);
    expect(validAbility(ability({ mean: 8, variance: 0.01, observations: 3 }))).toBe(
      true,
    );
    expect(validAbility(ability({ mean: -8, variance: 4 }))).toBe(true);
  });

  test("rejects a stale revision or out-of-range posterior", () => {
    expect(validAbility(ability({ revision: "child-irt-v2" }))).toBe(false);
    expect(validAbility(ability({ mean: 8.1 }))).toBe(false);
    expect(validAbility(ability({ variance: 0.009 }))).toBe(false);
    expect(validAbility(ability({ variance: 4.001 }))).toBe(false);
    expect(validAbility(ability({ observations: -1 }))).toBe(false);
    expect(validAbility(ability({ observations: 1.5 }))).toBe(false);
  });
});

describe("IRT gates", () => {
  test("predictSuccess and updateAbility fail closed on invalid local state", () => {
    expect(() => predictSuccess(ability({ revision: "stale" }), features())).toThrow(
      RangeError,
    );
    expect(() => updateAbility(ability(), features({ skill: "reasoning" }), true)).toThrow(
      RangeError,
    );
    expect(updateAbility(ability(), features(), true).observations).toBe(1);
  });
});
