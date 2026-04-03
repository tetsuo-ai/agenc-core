import { describe, it, expect } from "vitest";
import { SocialMemoryManager } from "./social-memory.js";
import { InMemoryBackend } from "./in-memory/backend.js";

function createMgr() {
  return new SocialMemoryManager({ memoryBackend: new InMemoryBackend() });
}

describe("SocialMemoryManager", () => {
  describe("social memory (agent-to-agent)", () => {
    it("records and retrieves inter-agent interactions", async () => {
      const mgr = createMgr();
      await mgr.recordInteraction("agent-a", "agent-b", "world-1", {
        timestamp: Date.now(),
        summary: "Alice greeted Bob",
      });

      const rel = await mgr.getRelationship("agent-a", "agent-b", "world-1");
      expect(rel).not.toBeNull();
      expect(rel!.interactions).toHaveLength(1);
      expect(rel!.interactions[0]!.summary).toBe("Alice greeted Bob");
    });

    it("isolates social memory by world", async () => {
      const mgr = createMgr();
      await mgr.recordInteraction("a", "b", "world-1", { timestamp: 1, summary: "w1" });
      await mgr.recordInteraction("a", "b", "world-2", { timestamp: 2, summary: "w2" });

      const w1 = await mgr.getRelationship("a", "b", "world-1");
      const w2 = await mgr.getRelationship("a", "b", "world-2");
      expect(w1!.interactions[0]!.summary).toBe("w1");
      expect(w2!.interactions[0]!.summary).toBe("w2");
    });
  });

  describe("shared world state", () => {
    it("adds observable facts with trust, provenance, and audit metadata", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "The server is running on port 8080", "agent-a", "world-visible", undefined, {
        trustSource: "system",
        confidence: 0.95,
        provenance: [{
          type: "gm_observation",
          source: "system",
          sourceId: "concordia-gm",
          worldId: "w1",
          timestamp: 1,
        }],
      });

      expect(fact.content).toBe("The server is running on port 8080");
      expect(fact.visibility).toBe("world-visible");
      expect(fact.trust.source).toBe("system");
      expect(fact.trust.score).toBeGreaterThan(0.8);
      expect(fact.provenance[0]!.type).toBe("gm_observation");
      expect(fact.auditTrail[0]!.action).toBe("write");
    });

    it("confirms facts from multiple agents and raises trust", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "Build succeeded", "agent-a", "shared", ["agent-a", "agent-b"], {
        trustSource: "agent",
        confidence: 0.7,
      });
      const confirmed = await mgr.confirmWorldFact(fact.id, "w1", "agent-b", {
        trustSource: "system",
        confidence: 0.9,
      });

      expect(confirmed!.confirmations).toBe(2);
      expect(confirmed!.confirmedBy).toContain("agent-a");
      expect(confirmed!.confirmedBy).toContain("agent-b");
      expect(confirmed!.trust.score).toBeGreaterThan(fact.trust.score);
      expect(confirmed!.auditTrail.at(-1)?.action).toBe("confirm");
    });

    it("enforces private visibility (only observer can see)", async () => {
      const mgr = createMgr();
      await mgr.addWorldFact("w1", "secret", "agent-a", "private");

      const agentAFacts = await mgr.getWorldFacts("w1", "agent-a");
      const agentBFacts = await mgr.getWorldFacts("w1", "agent-b");

      expect(agentAFacts).toHaveLength(1);
      expect(agentBFacts).toHaveLength(0);
    });

    it("enforces shared visibility (only allowed agents)", async () => {
      const mgr = createMgr();
      await mgr.addWorldFact("w1", "shared secret", "agent-a", "shared", ["agent-a", "agent-b"]);

      const aFacts = await mgr.getWorldFacts("w1", "agent-a");
      const bFacts = await mgr.getWorldFacts("w1", "agent-b");
      const cFacts = await mgr.getWorldFacts("w1", "agent-c");

      expect(aFacts).toHaveLength(1);
      expect(bFacts).toHaveLength(1);
      expect(cFacts).toHaveLength(0);
    });

    it("treats lineage-shared facts as visible within the scoped lineage namespace", async () => {
      const mgr = createMgr();
      await mgr.addWorldFact("world:market::lineage:l1", "lineage memory", "agent-a", "lineage-shared");

      const visible = await mgr.getWorldFacts("world:market::lineage:l1", "agent-b");
      expect(visible).toHaveLength(1);
      expect(visible[0]!.visibility).toBe("lineage-shared");
    });

    it("world-visible visibility is accessible to all agents", async () => {
      const mgr = createMgr();
      await mgr.addWorldFact("w1", "public fact", "agent-a", "world-visible");

      const aFacts = await mgr.getWorldFacts("w1", "agent-a");
      const bFacts = await mgr.getWorldFacts("w1", "agent-b");
      const cFacts = await mgr.getWorldFacts("w1", "agent-c");

      expect(aFacts).toHaveLength(1);
      expect(bFacts).toHaveLength(1);
      expect(cFacts).toHaveLength(1);
    });

    it("promotes collectively confirmed facts to world-visible with audit trail", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "market opens at dawn", "agent-a", "shared", ["agent-a", "agent-b", "agent-c"]);
      await mgr.confirmWorldFact(fact.id, "w1", "agent-b");
      await mgr.confirmWorldFact(fact.id, "w1", "agent-c");

      const promoted = await mgr.checkCollectiveEmergence("w1", 3);
      expect(promoted).toHaveLength(1);
      expect(promoted[0]!.visibility).toBe("world-visible");
      expect(promoted[0]!.auditTrail.at(-1)?.action).toBe("promote_visibility");
    });
  });
});
