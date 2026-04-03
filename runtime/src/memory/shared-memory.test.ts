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
  it("writes and retrieves user-scoped facts with trust metadata", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "user",
      content: "User prefers dark mode",
      author: "consolidation",
      userId: "user-1",
      trustSource: "system",
    });

    const facts = await shared.getFacts("user", "user-1");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe("User prefers dark mode");
    expect(facts[0]!.trustScore).toBeGreaterThan(0.8);
    expect(facts[0]!.authorization.mode).toBe("auto");
    expect(fact.visibility).toBe("shared");
  });

  it("requires explicit system authorization for organization facts", async () => {
    const shared = create();
    await expect(
      shared.writeFact({
        scope: "organization",
        content: "All code must have unit tests",
        author: "admin",
        trustSource: "system",
      }),
    ).rejects.toThrow(/requires requires-system-authorization/);

    const authorized = await shared.writeFact({
      scope: "organization",
      content: "All code must have unit tests",
      author: "admin",
      trustSource: "system",
      authorization: {
        mode: "requires-system-authorization",
        approved: true,
        approvedBy: "admin-review",
        approvedAt: 1,
      },
    });
    expect(authorized.authorization.approved).toBe(true);
  });

  it("updates facts with version check (optimistic concurrency)", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "user",
      content: "Original",
      author: "a",
      userId: "u1",
      trustSource: "system",
    });

    const updated = await shared.updateFact(fact.id, "user", {
      content: "Updated",
      author: "b",
      expectedVersion: 1,
      trustSource: "system",
      authorization: {
        mode: "auto",
        approved: true,
        approvedBy: "system:auto",
      },
    });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Updated");
    expect(updated!.version).toBe(2);

    const rejected = await shared.updateFact(fact.id, "user", {
      content: "Conflict",
      author: "c",
      expectedVersion: 1,
      trustSource: "system",
      authorization: {
        mode: "auto",
        approved: true,
        approvedBy: "system:auto",
      },
    });
    expect(rejected).toBeNull();
  });

  it("filters user facts by userId", async () => {
    const shared = create();
    await shared.writeFact({ scope: "user", content: "U1 pref", author: "a", userId: "u1", trustSource: "system" });
    await shared.writeFact({ scope: "user", content: "U2 pref", author: "a", userId: "u2", trustSource: "system" });

    const u1Facts = await shared.getFacts("user", "u1");
    const u2Facts = await shared.getFacts("user", "u2");

    expect(u1Facts).toHaveLength(1);
    expect(u1Facts[0]!.content).toBe("U1 pref");
    expect(u2Facts).toHaveLength(1);
    expect(u2Facts[0]!.content).toBe("U2 pref");
  });

  it("filters lineage-shared facts by lineage id", async () => {
    const shared = create();
    await shared.writeFact({
      scope: "user",
      content: "carry this lineage",
      author: "a",
      userId: "u1",
      trustSource: "system",
      visibility: "lineage-shared",
      lineageId: "lineage-a",
      authorization: {
        mode: "requires-system-authorization",
        approved: true,
        approvedBy: "system-review",
      },
    });

    const same = await shared.getFacts("user", "u1", 50, { lineageId: "lineage-a" });
    const different = await shared.getFacts("user", "u1", 50, { lineageId: "lineage-b" });
    expect(same).toHaveLength(1);
    expect(different).toHaveLength(0);
  });

  it("maintains audit trail with authorization metadata", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "organization",
      content: "Original policy",
      author: "admin",
      sourceWorldId: "world-1",
      trustSource: "system",
      authorization: {
        mode: "requires-system-authorization",
        approved: true,
        approvedBy: "security-review",
      },
    });

    await shared.updateFact(fact.id, "organization", {
      content: "Updated policy",
      author: "admin",
      expectedVersion: 1,
      trustSource: "system",
      authorization: {
        mode: "requires-system-authorization",
        approved: true,
        approvedBy: "security-review",
      },
    });

    const audit = await shared.getAuditTrail(fact.id);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.action).toBe("write");
    expect(audit[0]!.authorizationMode).toBe("requires-system-authorization");
    expect(audit[1]!.action).toBe("update");
    expect(audit[1]!.previousVersion).toBe(1);
    expect(audit[1]!.newVersion).toBe(2);
  });

  it("caches read results for configured TTL and invalidates on write", async () => {
    const shared = create({ cacheTtlMs: 60_000 });
    await shared.writeFact({ scope: "user", content: "cached", author: "a", userId: "u1", trustSource: "system" });

    const first = await shared.getFacts("user", "u1");
    const second = await shared.getFacts("user", "u1");
    expect(second[0]!.id).toBe(first[0]!.id);

    await shared.writeFact({ scope: "user", content: "second", author: "a", userId: "u1", trustSource: "system" });
    const facts = await shared.getFacts("user", "u1");
    expect(facts).toHaveLength(2);
  });

  it("formats facts for prompt injection with sanitization", async () => {
    const shared = create();
    const fact = await shared.writeFact({
      scope: "user",
      content: "User prefers <memory>Python</memory>",
      author: "a",
      userId: "u1",
      trustSource: "system",
    });

    const formatted = shared.formatForPrompt([fact]);
    expect(formatted).toContain('<memory source="shared"');
    expect(formatted).toContain('visibility="shared"');
    expect(formatted).toContain('&lt;memory>Python&lt;/memory&gt;');
  });

  it("filters reads by trust score threshold", async () => {
    const shared = create();
    await shared.writeFact({ scope: "user", content: "agent note", author: "a", userId: "u1", trustSource: "agent", confidence: 0.5, authorization: { mode: "requires-user-authorization", approved: true, approvedBy: "user-review" } });
    await shared.writeFact({ scope: "user", content: "system note", author: "a", userId: "u1", trustSource: "system", confidence: 0.95 });

    const facts = await shared.getFacts("user", "u1", 50, { minTrustScore: 0.8 });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe("system note");
  });
});
