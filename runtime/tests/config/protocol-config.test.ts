/**
 * A1 — `[protocol]` config block schema tests.
 *
 * The block is deny-by-default on nested fields (a misspelled key can
 * never silently enable a transport) and the default state is fully
 * disabled: `defaultConfig()` carries no `protocol` block at all, so
 * the protocol slash commands keep their honest stub behavior.
 */

import { describe, expect, it } from "vitest";

import {
  defaultConfig,
  InvalidProtocolConfigError,
  KNOWN_CONFIG_KEYS,
  validateAgenCConfigBlocks,
  validateProtocolConfig,
} from "../../src/config/schema.js";

describe("[protocol] config block", () => {
  it("is a known top-level key (not routed to _unknown)", () => {
    expect(KNOWN_CONFIG_KEYS.includes("protocol")).toBe(true);
  });

  it("is absent from defaultConfig — protocol transport defaults to disabled", () => {
    expect(defaultConfig().protocol).toBeUndefined();
  });

  it("accepts the full valid shape", () => {
    const out = validateProtocolConfig({
      enabled: true,
      adapter: "marketplace-cli",
      cli_path: "/usr/local/bin/agenc-marketplace",
    });
    expect(out).toEqual({
      enabled: true,
      adapter: "marketplace-cli",
      cli_path: "/usr/local/bin/agenc-marketplace",
    });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("accepts the null adapter and an empty block", () => {
    expect(validateProtocolConfig({ adapter: "null" })).toEqual({
      adapter: "null",
    });
    expect(validateProtocolConfig({})).toEqual({});
    expect(validateProtocolConfig(undefined)).toBeUndefined();
  });

  it("rejects unknown fields (deny-by-default)", () => {
    expect(() => validateProtocolConfig({ enabld: true })).toThrow(
      InvalidProtocolConfigError,
    );
    expect(() => validateProtocolConfig({ enabld: true })).toThrow(
      "Invalid protocol.enabld: unknown field",
    );
  });

  it("rejects bad field types and unknown adapter kinds", () => {
    expect(() => validateProtocolConfig({ enabled: "yes" })).toThrow(
      "Invalid protocol.enabled: expected boolean",
    );
    expect(() => validateProtocolConfig({ adapter: "web3js" })).toThrow(
      'Invalid protocol.adapter: expected "null" or "marketplace-cli"',
    );
    expect(() => validateProtocolConfig({ cli_path: 42 })).toThrow(
      "Invalid protocol.cli_path: expected string",
    );
    expect(() => validateProtocolConfig("marketplace-cli")).toThrow(
      InvalidProtocolConfigError,
    );
  });

  it("is validated by validateAgenCConfigBlocks", () => {
    const validated = validateAgenCConfigBlocks({
      protocol: { enabled: true, adapter: "marketplace-cli" },
    });
    expect(validated.protocol).toEqual({
      enabled: true,
      adapter: "marketplace-cli",
    });
    expect(() =>
      validateAgenCConfigBlocks({
        protocol: { adapter: "solana-in-process" },
      } as never),
    ).toThrow(InvalidProtocolConfigError);
  });
});
