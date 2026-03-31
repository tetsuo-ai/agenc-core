import { describe, it, expect } from "vitest";
import { SharedMemoryBackend } from "./shared-memory.js";
import { InMemoryBackend } from "./in-memory/backend.js";

function create(config?: { cacheTtlMs?: number }) {
  return new SharedMemoryBackend({
    memoryBackend: new InMemoryBackend(),
    ...config,
  });
}

describe("SharedMemoryBackend", () => {
  it("writes and retrieves user-scoped facts", async () => {
    const shared = create();
    await shared.writeFact({
      scope: "user",
      content: "User prefers dark mode",
      author: "consolidation",
      userId: "user-1",
    });

    const facts = await shared.getFacts("user", "user-1");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe("User prefers dark mode");
    expect(facts[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("writes organization-scoped facts visible to all", async () => {
    const shared = create();
    await shared.writeFact({
      scope: "organization",
      content: "All code must have unit tests",
      author: "admin",
    });

    const facts = await shared.getFacts("organization");
    expect(facts).toHaveLength(1);
  });

  it("updates facts with version check (optimistic concurrency)", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "user",
      content: "Original",
      author: "a",
      userId: "u1",
    });

    // Correct version → success
    const updated = await shared.updateFact(fact.id, "user", {
      content: "Updated",
      author: "b",
      expectedVersion: 1,
    });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Updated");
    expect(updated!.version).toBe(2);

    // Wrong version → rejected (per skeptic: not last-write-wins)
    const rejected = await shared.updateFact(fact.id, "user", {
      content: "Conflict",
      author: "c",
      expectedVersion: 1, // Stale version!
    });
    expect(rejected).toBeNull();
  });

  it("filters user facts by userId", async () => {
    const shared = create();
    await shared.writeFact({ scope: "user", content: "U1 pref", author: "a", userId: "u1" });
    await shared.writeFact({ scope: "user", content: "U2 pref", author: "a", userId: "u2" });

    const u1Facts = await shared.getFacts("user", "u1");
    const u2Facts = await shared.getFacts("user", "u2");

    expect(u1Facts).toHaveLength(1);
    expect(u1Facts[0]!.content).toBe("U1 pref");
    expect(u2Facts).toHaveLength(1);
    expect(u2Facts[0]!.content).toBe("U2 pref");
  });

  it("maintains audit trail", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "organization",
      content: "Original policy",
      author: "admin",
      sourceWorldId: "world-1",
    });

    await shared.updateFact(fact.id, "organization", {
      content: "Updated policy",
      author: "admin",
      expectedVersion: 1,
    });

    const audit = await shared.getAuditTrail(fact.id);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.action).toBe("write");
    expect(audit[1]!.action).toBe("update");
    expect(audit[1]!.previousVersion).toBe(1);
    expect(audit[1]!.newVersion).toBe(2);
  });

  it("caches read results for configured TTL", async () => {
    const shared = create({ cacheTtlMs: 60_000 });
    await shared.writeFact({ scope: "organization", content: "cached", author: "a" });

    // First read populates cache
    const first = await shared.getFacts("organization");
    expect(first).toHaveLength(1);

    // Second read returns cached result (no new DB query)
    const second = await shared.getFacts("organization");
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("invalidates cache on write", async () => {
    const shared = create({ cacheTtlMs: 60_000 });
    await shared.writeFact({ scope: "organization", content: "first", author: "a" });
    await shared.getFacts("organization"); // Populate cache

    // Write invalidates cache
    await shared.writeFact({ scope: "organization", content: "second", author: "a" });
    const facts = await shared.getFacts("organization");
    expect(facts).toHaveLength(2);
  });

  it("formats facts for prompt injection", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "user",
      content: "User prefers Python",
      author: "a",
      userId: "u1",
    });

    const formatted = shared.formatForPrompt([fact]);
    expect(formatted).toContain('<memory source="shared"');
    expect(formatted).toContain('scope="user"');
    expect(formatted).toContain("User prefers Python");
  });

  it("sorts facts by confidence then recency", async () => {
    const shared = create();
    await shared.writeFact({ scope: "organization", content: "low conf", author: "a", confidence: 0.5 });
    await shared.writeFact({ scope: "organization", content: "high conf", author: "a", confidence: 0.95 });

    const facts = await shared.getFacts("organization");
    expect(facts[0]!.content).toBe("high conf");
    expect(facts[1]!.content).toBe("low conf");
  });
});
