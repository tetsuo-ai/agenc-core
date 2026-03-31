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

    it("accumulates multiple interactions", async () => {
      const mgr = createMgr();
      await mgr.recordInteraction("a", "b", "w1", {
        timestamp: 1, summary: "First meeting",
      });
      await mgr.recordInteraction("a", "b", "w1", {
        timestamp: 2, summary: "Second meeting",
      });

      const rel = await mgr.getRelationship("a", "b", "w1");
      expect(rel!.interactions).toHaveLength(2);
    });

    it("lists known agents in a world", async () => {
      const mgr = createMgr();
      await mgr.recordInteraction("a", "b", "w1", { timestamp: 1, summary: "x" });
      await mgr.recordInteraction("a", "c", "w1", { timestamp: 2, summary: "y" });

      const known = await mgr.listKnownAgents("a", "w1");
      expect(known).toContain("b");
      expect(known).toContain("c");
      expect(known).toHaveLength(2);
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
    it("adds observable facts to world state", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "The server is running on port 8080", "agent-a");

      expect(fact.content).toBe("The server is running on port 8080");
      expect(fact.observedBy).toBe("agent-a");
      expect(fact.confirmations).toBe(1);
      expect(fact.visibility).toBe("world");
    });

    it("confirms facts from multiple agents", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "Build succeeded", "agent-a");
      const confirmed = await mgr.confirmWorldFact(fact.id, "w1", "agent-b");

      expect(confirmed!.confirmations).toBe(2);
      expect(confirmed!.confirmedBy).toContain("agent-a");
      expect(confirmed!.confirmedBy).toContain("agent-b");
    });

    it("prevents duplicate confirmations", async () => {
      const mgr = createMgr();
      const fact = await mgr.addWorldFact("w1", "fact", "a");
      await mgr.confirmWorldFact(fact.id, "w1", "a"); // Same agent

      const result = await mgr.confirmWorldFact(fact.id, "w1", "a");
      expect(result!.confirmations).toBe(1); // Not double-counted
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
      expect(cFacts).toHaveLength(0); // Not in allowed list
    });

    it("world visibility is accessible to all agents", async () => {
      const mgr = createMgr();
      await mgr.addWorldFact("w1", "public fact", "agent-a", "world");

      const aFacts = await mgr.getWorldFacts("w1", "agent-a");
      const bFacts = await mgr.getWorldFacts("w1", "agent-b");
      const cFacts = await mgr.getWorldFacts("w1", "agent-c");

      expect(aFacts).toHaveLength(1);
      expect(bFacts).toHaveLength(1);
      expect(cFacts).toHaveLength(1);
    });
  });
});
