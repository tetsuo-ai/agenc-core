import { describe, it, expect } from "vitest";
import {
  computeTrustScore,
  inferTrustSource,
  DEFAULT_TRUST_THRESHOLD,
} from "./trust-scoring.js";

describe("computeTrustScore", () => {
  it("assigns highest trust to system-sourced entries", () => {
    const score = computeTrustScore({
      source: "system",
      confidence: 0.9,
      ageMs: 0,
      accessCount: 10,
      confirmed: true,
    });
    expect(score).toBeGreaterThan(0.9);
  });

  it("assigns lower trust to external entries", () => {
    const external = computeTrustScore({
      source: "external",
      confidence: 0.5,
      ageMs: 86_400_000 * 60, // 60 days old
      accessCount: 0,
      confirmed: false,
    });
    const system = computeTrustScore({
      source: "system",
      confidence: 0.9,
      ageMs: 0,
      accessCount: 10,
      confirmed: true,
    });
    expect(external).toBeLessThan(system);
  });

  it("decays trust over time (temporal decay)", () => {
    const fresh = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 0,
      accessCount: 5,
      confirmed: false,
    });
    const old = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 86_400_000 * 90, // 90 days old
      accessCount: 5,
      confirmed: false,
    });
    expect(fresh).toBeGreaterThan(old);
  });

  it("boosts trust for frequently accessed entries", () => {
    const lowAccess = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 0,
      accessCount: 0,
      confirmed: false,
    });
    const highAccess = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 0,
      accessCount: 100,
      confirmed: false,
    });
    expect(highAccess).toBeGreaterThan(lowAccess);
  });

  it("gives confirmation bonus", () => {
    const unconfirmed = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 0,
      accessCount: 5,
      confirmed: false,
    });
    const confirmed = computeTrustScore({
      source: "agent",
      confidence: 0.7,
      ageMs: 0,
      accessCount: 5,
      confirmed: true,
    });
    expect(confirmed).toBeGreaterThan(unconfirmed);
  });

  it("returns score in [0, 1] range", () => {
    const score = computeTrustScore({
      source: "unknown",
      confidence: 0,
      ageMs: 86_400_000 * 365,
      accessCount: 0,
      confirmed: false,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("inferTrustSource", () => {
  it("identifies system sources", () => {
    expect(inferTrustSource({ type: "session_summary" }, "system")).toBe("system");
    expect(inferTrustSource({ type: "consolidated_fact" }, "assistant")).toBe("system");
    expect(inferTrustSource({ provenance: "consolidation:ep" }, "system")).toBe("system");
  });

  it("identifies user sources", () => {
    expect(inferTrustSource({ provenance: "ingestion:turn" }, "user")).toBe("user");
  });

  it("identifies agent sources", () => {
    expect(inferTrustSource({ provenance: "ingestion:turn" }, "assistant")).toBe("agent");
  });

  it("identifies tool sources", () => {
    expect(inferTrustSource({ type: "entity_fact" }, "system")).toBe("tool");
  });

  it("defaults to unknown for missing metadata", () => {
    expect(inferTrustSource(undefined, "assistant")).toBe("unknown");
  });

  it("default trust threshold is reasonable", () => {
    expect(DEFAULT_TRUST_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_TRUST_THRESHOLD).toBeLessThan(0.5);
  });
});
