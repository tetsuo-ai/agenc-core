import { describe, it, expect } from "vitest";
import { AgentIdentityManager, createAgentIdentityProvider } from "./agent-identity.js";
import { InMemoryBackend } from "./in-memory/backend.js";

function createManager() {
  return new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });
}

describe("AgentIdentityManager", () => {
  it("creates a new agent identity", async () => {
    const mgr = createManager();
    const identity = await mgr.upsert({
      agentId: "agent-1",
      name: "Alice",
      corePersonality: "Friendly and helpful research assistant",
      workspaceId: "ws1",
    });

    expect(identity.agentId).toBe("agent-1");
    expect(identity.name).toBe("Alice");
    expect(identity.personalityVersion).toBe(1);
    expect(identity.learnedTraits).toHaveLength(0);
    expect(identity.beliefs).toEqual({});
  });

  it("persists and loads identity", async () => {
    const mgr = createManager();
    await mgr.upsert({
      agentId: "agent-1",
      name: "Alice",
      corePersonality: "Helpful assistant",
      workspaceId: "ws1",
    });

    const loaded = await mgr.load("agent-1", "ws1");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Alice");
    expect(loaded!.corePersonality).toBe("Helpful assistant");
  });

  it("versions personality on change and resets learned traits (skeptic)", async () => {
    const mgr = createManager();
    const v1 = await mgr.upsert({
      agentId: "agent-1",
      name: "Alice",
      corePersonality: "Version 1 personality",
      workspaceId: "ws1",
    });
    await mgr.addLearnedTraits("agent-1", ["likes Python"], "ws1");

    // Change personality → version increments, learned traits reset
    const v2 = await mgr.upsert({
      agentId: "agent-1",
      name: "Alice",
      corePersonality: "Version 2 personality",
      workspaceId: "ws1",
    });

    expect(v2.personalityVersion).toBe(2);
    expect(v2.learnedTraits).toHaveLength(0); // Reset!
    expect(v2.corePersonality).toBe("Version 2 personality");
  });

  it("adds learned traits without replacing core", async () => {
    const mgr = createManager();
    await mgr.upsert({
      agentId: "a1",
      name: "Bob",
      corePersonality: "Core stays",
      workspaceId: "ws1",
    });

    const updated = await mgr.addLearnedTraits(
      "a1",
      ["prefers concise answers", "good at debugging"],
      "ws1",
    );

    expect(updated!.corePersonality).toBe("Core stays"); // Core unchanged
    expect(updated!.learnedTraits).toContain("prefers concise answers");
    expect(updated!.learnedTraits).toContain("good at debugging");
  });

  it("deduplicates learned traits", async () => {
    const mgr = createManager();
    await mgr.upsert({ agentId: "a1", name: "C", corePersonality: "x", workspaceId: "ws1" });
    await mgr.addLearnedTraits("a1", ["trait1", "trait2"], "ws1");
    const updated = await mgr.addLearnedTraits("a1", ["trait2", "trait3"], "ws1");

    expect(updated!.learnedTraits).toEqual(["trait1", "trait2", "trait3"]);
  });

  it("stores beliefs with evidence (edge case X5: rejects ungrounded)", async () => {
    const mgr = createManager();
    await mgr.upsert({ agentId: "a1", name: "D", corePersonality: "x", workspaceId: "ws1" });

    // Grounded belief — accepted
    const result = await mgr.upsertBelief("a1", "testing", {
      belief: "pytest is better than unittest",
      confidence: 0.8,
      evidence: ["entry-123", "entry-456"],
      formedAt: Date.now(),
    }, "ws1");
    expect(result).not.toBeNull();
    expect(result!.beliefs.testing.belief).toBe("pytest is better than unittest");

    // Ungrounded belief — rejected (X5)
    const rejected = await mgr.upsertBelief("a1", "ungrounded", {
      belief: "hallucinated opinion",
      confidence: 0.9,
      evidence: [], // No evidence!
      formedAt: Date.now(),
    }, "ws1");
    expect(rejected).toBeNull();
  });

  it("isolates identities by workspace", async () => {
    const mgr = createManager();
    await mgr.upsert({ agentId: "a1", name: "WS1-Agent", corePersonality: "ws1 personality", workspaceId: "ws1" });
    await mgr.upsert({ agentId: "a1", name: "WS2-Agent", corePersonality: "ws2 personality", workspaceId: "ws2" });

    const ws1 = await mgr.load("a1", "ws1");
    const ws2 = await mgr.load("a1", "ws2");

    expect(ws1!.corePersonality).toBe("ws1 personality");
    expect(ws2!.corePersonality).toBe("ws2 personality");
  });

  it("resets learned traits keeping core personality", async () => {
    const mgr = createManager();
    await mgr.upsert({ agentId: "a1", name: "E", corePersonality: "core stays", workspaceId: "ws1" });
    await mgr.addLearnedTraits("a1", ["trait1"], "ws1");
    await mgr.upsertBelief("a1", "topic", {
      belief: "something",
      confidence: 0.7,
      evidence: ["e1"],
      formedAt: Date.now(),
    }, "ws1");

    const reset = await mgr.resetLearned("a1", "ws1");
    expect(reset!.corePersonality).toBe("core stays"); // Core preserved
    expect(reset!.learnedTraits).toHaveLength(0); // Traits cleared
    expect(Object.keys(reset!.beliefs)).toHaveLength(0); // Beliefs cleared
  });

  it("formats identity for prompt injection with budget cap", async () => {
    const mgr = createManager();
    await mgr.upsert({
      agentId: "a1",
      name: "Verbose Agent",
      corePersonality: "A very detailed personality description...",
      workspaceId: "ws1",
    });
    await mgr.addLearnedTraits("a1", ["likes TypeScript", "prefers functional style"], "ws1");

    const identity = (await mgr.load("a1", "ws1"))!;
    const formatted = mgr.formatForPrompt(identity);

    expect(formatted).toContain("# Agent Identity: Verbose Agent");
    expect(formatted).toContain("## Learned Traits");
    expect(formatted.length).toBeLessThanOrEqual(2003);
  });

  it("single-agent default mode works without overhead", async () => {
    const mgr = createManager();
    const identity = await mgr.upsert({
      agentId: "default",
      name: "agenc-agent",
      corePersonality: "Helpful AI assistant",
    });

    expect(identity.agentId).toBe("default");
    expect(identity.personalityVersion).toBe(1);
    // Default agent works exactly like any other — no special overhead
  });

  describe("createAgentIdentityProvider (Phase 5.4)", () => {
    it("returns formatted prompt for existing agent identity", async () => {
      const mgr = createManager();
      await mgr.upsert({
        agentId: "agent-1",
        name: "Alice",
        corePersonality: "Friendly research assistant",
        workspaceId: "ws1",
      });

      const provider = createAgentIdentityProvider(mgr, "agent-1", "ws1");
      const result = await provider.retrieve("hello", "session-1");

      expect(result).toBeDefined();
      expect(result).toContain("Agent Identity: Alice");
      expect(result).toContain("Friendly research assistant");
    });

    it("returns undefined when agent identity does not exist", async () => {
      const mgr = createManager();
      const provider = createAgentIdentityProvider(mgr, "nonexistent");
      const result = await provider.retrieve("hello", "session-1");
      expect(result).toBeUndefined();
    });

    it("includes learned traits and beliefs in prompt", async () => {
      const mgr = createManager();
      const identity = await mgr.upsert({
        agentId: "agent-2",
        name: "Bob",
        corePersonality: "Analytical assistant",
      });

      await mgr.addLearnedTraits("agent-2", ["precise", "detail-oriented"]);
      await mgr.upsertBelief("agent-2", "testing", {
        belief: "Tests are essential",
        confidence: 0.8,
        evidence: ["entry-1"],
        formedAt: Date.now(),
      });

      const provider = createAgentIdentityProvider(mgr, "agent-2");
      const result = await provider.retrieve("query", "s1");

      expect(result).toContain("precise");
      expect(result).toContain("Tests are essential");
    });
  });
});
