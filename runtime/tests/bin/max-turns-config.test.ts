import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { maxTurnsFromAgenCConfig } from "./bootstrap.js";

describe("maxTurnsFromAgenCConfig (todo-105)", () => {
  it("maps positive max_turns from schema/TOML config", () => {
    expect(maxTurnsFromAgenCConfig({ max_turns: 7 })).toBe(7);
    expect(maxTurnsFromAgenCConfig(defaultConfig())).toBe(
      defaultConfig().max_turns,
    );
    expect(defaultConfig().max_turns).toBe(50);
  });

  it("ignores non-positive values", () => {
    expect(maxTurnsFromAgenCConfig({ max_turns: 0 })).toBeUndefined();
    expect(maxTurnsFromAgenCConfig({ max_turns: -1 })).toBeUndefined();
    expect(maxTurnsFromAgenCConfig({})).toBeUndefined();
  });
});
