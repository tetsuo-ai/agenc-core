import { describe, expect, it } from "vitest";
import {
  MAX_CATALOG_JSON_BYTES,
  catalogDigestMatches,
  computeMCPToolCatalogSha256,
} from "./supply-chain.js";

describe("computeMCPToolCatalogSha256", () => {
  it("is stable across re-orderings of the tool array (canonical sort)", () => {
    const a = computeMCPToolCatalogSha256([
      { name: "beta", description: "b", inputSchema: { type: "object" } },
      { name: "alpha", description: "a", inputSchema: { type: "object" } },
    ]);
    const b = computeMCPToolCatalogSha256([
      { name: "alpha", description: "a", inputSchema: { type: "object" } },
      { name: "beta", description: "b", inputSchema: { type: "object" } },
    ]);
    expect(a.sha256).toBe(b.sha256);
  });

  it("is stable across object-key reordering inside inputSchema", () => {
    const a = computeMCPToolCatalogSha256([
      {
        name: "t",
        inputSchema: { type: "object", properties: { a: {}, b: {} } },
      },
    ]);
    const b = computeMCPToolCatalogSha256([
      {
        name: "t",
        inputSchema: { properties: { b: {}, a: {} }, type: "object" },
      },
    ]);
    expect(a.sha256).toBe(b.sha256);
  });

  it("changes when a tool description changes", () => {
    const a = computeMCPToolCatalogSha256([
      { name: "t", description: "v1" },
    ]);
    const b = computeMCPToolCatalogSha256([
      { name: "t", description: "v2" },
    ]);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it("returns a 64-char hex string", () => {
    const { sha256 } = computeMCPToolCatalogSha256([{ name: "t" }]);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores unknown top-level keys (supply-chain narrowing)", () => {
    const a = computeMCPToolCatalogSha256([
      { name: "t", description: "x" } as unknown as { name: string },
    ]);
    const b = computeMCPToolCatalogSha256([
      {
        name: "t",
        description: "x",
        // @ts-expect-error — runtime-only extra field
        annotations: { risky: true },
      },
    ]);
    expect(a.sha256).toBe(b.sha256);
  });

  it("throws when canonical JSON exceeds the I-76 cap", () => {
    // Build an inputSchema past the 5MB canonical threshold.
    const huge = "a".repeat(MAX_CATALOG_JSON_BYTES + 100);
    expect(() =>
      computeMCPToolCatalogSha256([
        { name: "big", inputSchema: { payload: huge } },
      ]),
    ).toThrow(/exceeds I-76 cap/);
  });
});

describe("catalogDigestMatches", () => {
  it("returns true when expected is undefined (no pin)", () => {
    expect(catalogDigestMatches("deadbeef", undefined)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(catalogDigestMatches("ABC123", "abc123")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(catalogDigestMatches("abc", "  abc\n")).toBe(true);
  });

  it("returns false on mismatch", () => {
    expect(catalogDigestMatches("abc", "def")).toBe(false);
  });
});
