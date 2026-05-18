import { describe, expect, test } from "vitest";
import {
  getAutoFixConfig,
  parseAutoFixConfig,
} from "./autoFixConfig.js";
import {
  KNOWN_CONFIG_KEYS,
  normalizeRawConfig,
} from "../../config/schema.js";

describe("parseAutoFixConfig", () => {
  test("parses valid full config", () => {
    const result = parseAutoFixConfig({
      enabled: true,
      lint: "eslint . --fix",
      test: "vitest run",
      maxRetries: 3,
      timeout: 30_000,
    });
    expect(result.success).toBe(true);
    expect(result.success ? result.data : null).toEqual({
      enabled: true,
      lint: "eslint . --fix",
      test: "vitest run",
      maxRetries: 3,
      timeout: 30_000,
    });
  });

  test("parses minimal config with defaults", () => {
    const result = parseAutoFixConfig({ enabled: true, lint: "eslint ." });
    expect(result.success).toBe(true);
    expect(result.success ? result.data : null).toEqual({
      enabled: true,
      lint: "eslint .",
      maxRetries: 3,
      timeout: 30_000,
    });
  });

  test("rejects config with enabled but no lint or test", () => {
    const result = parseAutoFixConfig({ enabled: true });
    expect(result.success).toBe(false);
  });

  test("accepts disabled config without commands", () => {
    const result = parseAutoFixConfig({ enabled: false });
    expect(result.success).toBe(true);
    expect(result.success ? result.data : "failure").toBeNull();
  });

  test("rejects negative maxRetries", () => {
    const result = parseAutoFixConfig({
      enabled: true,
      lint: "eslint .",
      maxRetries: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects maxRetries above 10", () => {
    const result = parseAutoFixConfig({
      enabled: true,
      lint: "eslint .",
      maxRetries: 11,
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty command strings", () => {
    const result = parseAutoFixConfig({
      enabled: true,
      lint: "   ",
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.reason).toContain("lint");
  });

  test("invalid integer diagnostics name the field", () => {
    const result = parseAutoFixConfig({
      enabled: true,
      lint: "eslint .",
      timeout: "slow",
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.reason).toContain("timeout");
  });
});

describe("getAutoFixConfig", () => {
  test("returns null when settings have no autoFix", () => {
    expect(getAutoFixConfig(undefined)).toBeNull();
  });

  test("returns null when autoFix is disabled", () => {
    expect(getAutoFixConfig({ enabled: false })).toBeNull();
  });

  test("returns parsed config when valid and enabled", () => {
    const result = getAutoFixConfig({ enabled: true, lint: "eslint ." });
    expect(result).toEqual({
      enabled: true,
      lint: "eslint .",
      maxRetries: 3,
      timeout: 30_000,
    });
  });
});

describe("AgenC config integration", () => {
  test("top-level autoFix is preserved on the typed config path", () => {
    const raw = {
      autoFix: {
        enabled: true,
        lint: "eslint .",
        test: "vitest run",
      },
    };
    const result = normalizeRawConfig(raw);
    expect(result.autoFix).toEqual(raw.autoFix);
    expect(result._unknown?.autoFix).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("autoFix")).toBe(true);
  });
});
