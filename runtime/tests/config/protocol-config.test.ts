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

  it("accepts an explicit disabled block", () => {
    expect(validateProtocolConfig({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(validateProtocolConfig(undefined)).toBeUndefined();
  });

  it("rejects no-op protocol combinations", () => {
    expect(() => validateProtocolConfig({})).toThrow(
      "Invalid protocol.enabled: is required",
    );
    expect(() => validateProtocolConfig({ enabled: true })).toThrow(
      'must be "marketplace-cli"',
    );
    expect(() => validateProtocolConfig({
      enabled: false,
      adapter: "marketplace-cli",
    })).toThrow("must be absent");
    expect(() => validateProtocolConfig({
      enabled: false,
      cli_path: "/unused",
    })).toThrow("must be absent");
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
    expect(() => validateProtocolConfig({ enabled: true, adapter: "web3js" })).toThrow(
      'Invalid protocol.adapter: expected "marketplace-cli"',
    );
    expect(() => validateProtocolConfig({
      enabled: true,
      adapter: "marketplace-cli",
      cli_path: 42,
    })).toThrow(
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
        protocol: { enabled: true, adapter: "solana-in-process" },
      } as never),
    ).toThrow(InvalidProtocolConfigError);
  });
});
