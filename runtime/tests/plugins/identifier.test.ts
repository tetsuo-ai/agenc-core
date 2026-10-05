import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_SERVER_IDENTIFIER_LENGTH,
  boundScopedServerIdentifier,
} from "../../src/identifiers/server-name.js";
import {
  buildPluginIdentifier,
  isCanonicalMarketplaceName,
  isCanonicalPluginIdentity,
  isCanonicalPluginName,
  parsePluginIdentifier,
} from "../../src/plugins/identifier.js";
import {
  canonicalPluginRuntimeNamespace,
  pluginScopedServerIdentifier,
} from "../../src/plugins/identifier-normalization.js";

describe("plugin identity parsing", () => {
  it("keeps a name without a marketplace", () => {
    expect(parsePluginIdentifier("sample")).toEqual({ name: "sample" });
    expect(buildPluginIdentifier("sample")).toBe("sample");
    expect(isCanonicalPluginIdentity("sample")).toBe(true);
  });

  it("splits name@marketplace without discarding a suffix after the first @", () => {
    expect(parsePluginIdentifier("sample@official")).toEqual({
      name: "sample",
      marketplace: "official",
    });
    expect(parsePluginIdentifier("sample@official@extra")).toEqual({
      name: "sample",
      marketplace: "official@extra",
    });
    expect(isCanonicalPluginIdentity("sample@official")).toBe(true);
    expect(isCanonicalPluginIdentity("sample@official@extra")).toBe(false);
  });

  it("does not treat a leading @ as a marketplace marker", () => {
    expect(parsePluginIdentifier("@evil")).toEqual({ name: "@evil" });
    expect(isCanonicalPluginIdentity("@evil")).toBe(false);
  });

  it("refuses a trailing @ because the rebuilt identity would drop it", () => {
    expect(parsePluginIdentifier("sample@")).toEqual({ name: "sample" });
    expect(isCanonicalPluginIdentity("sample@")).toBe(false);
  });

  it("accepts the published name and marketplace spellings and rejects the rest", () => {
    for (const name of ["a", "1plugin", "foo-bar", "foo.bar", "foo_bar"]) {
      expect(isCanonicalPluginName(name), name).toBe(true);
    }
    for (const name of ["", "Foo", "-foo", "foo/bar", "foo bar"]) {
      expect(isCanonicalPluginName(name), name).toBe(false);
    }
    for (const market of ["official", "a1", "foo.bar", "foo-bar"]) {
      expect(isCanonicalMarketplaceName(market), market).toBe(true);
    }
    for (const market of ["", "Official", "1market", "-market", "foo@bar"]) {
      expect(isCanonicalMarketplaceName(market), market).toBe(false);
    }
  });
});

describe("canonical plugin runtime namespace", () => {
  it("keeps a simple kebab-case id readable", () => {
    expect(canonicalPluginRuntimeNamespace("sample")).toBe("sample");
    expect(canonicalPluginRuntimeNamespace("foo-bar")).toBe("foo-bar");
  });

  it("encodes every other canonical id behind a prefix simple ids cannot produce", () => {
    expect(canonicalPluginRuntimeNamespace("foo.bar")).toBe("p_foo_2ebar");
    expect(canonicalPluginRuntimeNamespace("foo@bar")).toBe("p_foo_40bar");
    expect(canonicalPluginRuntimeNamespace("sample")).not.toMatch(/^p_/u);
    expect(() => canonicalPluginRuntimeNamespace("Not Canonical")).toThrow(
      /Invalid canonical plugin ID/u,
    );
  });
});

describe("bound scoped server identifiers", () => {
  it("leaves identifiers that already fit the DTO bound alone", () => {
    expect(boundScopedServerIdentifier("plugin:sample:local")).toBe(
      "plugin:sample:local",
    );
    const exact = "a".repeat(MAX_SERVER_IDENTIFIER_LENGTH);
    expect(boundScopedServerIdentifier(exact)).toBe(exact);
  });

  it("compacts a longer identifier to exactly 256 characters with a sha256 suffix", () => {
    const long = `plugin:sample:${"x".repeat(300)}`;
    const compacted = boundScopedServerIdentifier(long);
    const digest = createHash("sha256").update(long, "utf8").digest("hex");
    expect(compacted).toHaveLength(MAX_SERVER_IDENTIFIER_LENGTH);
    expect(compacted.endsWith(`:${digest}`)).toBe(true);
    expect(compacted.startsWith(long.slice(0, 191))).toBe(true);
    expect(boundScopedServerIdentifier(`${long}y`)).not.toBe(compacted);
  });

  it("applies the same bound after plugin server-name normalization", () => {
    const scoped = pluginScopedServerIdentifier(
      "sample",
      `local:${"n".repeat(300)}`,
    );
    expect(scoped).toHaveLength(MAX_SERVER_IDENTIFIER_LENGTH);
    expect(scoped.startsWith("plugin:sample:local:")).toBe(true);
  });
});
