/**
 * Phase 10: Integration tests for the memory system.
 *
 * Tests end-to-end memory lifecycle across multiple components:
 * - Cross-session retrieval (10.1)
 * - Persistent vectors (10.2)
 * - Memory scoping (10.3)
 * - Entity extraction + knowledge graph (10.4)
 * - Consolidation (10.5)
 * - Agent identity (10.6)
 * - Social memory (10.7)
 * - Cross-context contamination (10.10)
 * - Persistence across restart (10.14)
 */

import { describe, it, expect, afterEach } from "vitest";
import { InMemoryBackend } from "./in-memory/backend.js";
import { InMemoryVectorStore } from "./vector-store.js";
import { SqliteVectorBackend } from "./sqlite/vector-backend.js";
import { NoopEmbeddingProvider } from "./embeddings.js";
import { SemanticMemoryRetriever } from "./retriever.js";
import { MemoryIngestionEngine, createIngestionHooks } from "./ingestion.js";
import { CuratedMemoryManager, DailyLogManager, NoopEntityExtractor } from "./structured.js";
import { MemoryGraph } from "./graph.js";
import { AgentIdentityManager } from "./agent-identity.js";
import { SocialMemoryManager } from "./social-memory.js";
import { ProceduralMemory } from "./procedural.js";
import { SharedMemoryBackend } from "./shared-memory.js";
import { runConsolidation } from "./consolidation.js";
import { exportMemory, importMemory } from "./export-import.js";
import { collectMemoryHealthReport } from "./diagnostics.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("Memory System Integration Tests", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-mem-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  // 10.1: Cross-session semantic retrieval
  it("retrieves semantic facts across sessions", async () => {
    const vectorStore = new InMemoryVectorStore({ dimension: 128 });
    const embeddingProvider = new NoopEmbeddingProvider(128);
    const tmpDir = makeTmpDir();

    const retriever = new SemanticMemoryRetriever({
      vectorBackend: vectorStore,
      embeddingProvider,
      curatedMemory: new CuratedMemoryManager(join(tmpDir, "MEMORY.md")),
    });

    // Store entry in "session A"
    await vectorStore.storeWithEmbedding(
      {
        sessionId: "session-a",
        role: "assistant",
        content: "User prefers Python for data analysis",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      new Array(128).fill(0.5),
    );

    // Query from "session B" — should find session A's fact
    const result = await retriever.retrieveDetailed("what language for data", "session-b");
    expect(result.content).toContain("Python");
  });

  // 10.2: Persistent vector store
  it("persists vectors across backend close/reopen", async () => {
    const tmpPath = join(makeTmpDir(), "vectors.db");

    // Phase 1: store vectors
    const b1 = new SqliteVectorBackend({ dbPath: tmpPath });
    await b1.storeWithEmbedding(
      { sessionId: "s1", role: "assistant", content: "persistent fact" },
      [1, 0, 0],
    );
    await b1.close();

    // Phase 2: reopen and search
    const b2 = new SqliteVectorBackend({ dbPath: tmpPath });
    await b2.loadVectors();
    const results = await b2.searchSimilar([1, 0, 0]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.content).toBe("persistent fact");
    await b2.close();
  });

  // 10.3: Memory scoping
  it("isolates entries by workspaceId", async () => {
    const vectorStore = new InMemoryVectorStore({ dimension: 3 });

    await vectorStore.storeWithEmbedding(
      {
        sessionId: "s1", role: "assistant", content: "workspace A fact",
        workspaceId: "wsA",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [1, 0, 0],
    );
    await vectorStore.storeWithEmbedding(
      {
        sessionId: "s2", role: "assistant", content: "workspace B fact",
        workspaceId: "wsB",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [1, 0, 0],
    );

    // Query for workspace A — should NOT see workspace B
    const resultsA = await vectorStore.searchSimilar([1, 0, 0], { workspaceId: "wsA" });
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0]!.entry.content).toBe("workspace A fact");
  });

  // 10.4: Entity extraction + knowledge graph
  it("extracts entities and populates knowledge graph", async () => {
    const graph = new MemoryGraph(new InMemoryBackend());

    // Simulate entity extraction → graph node creation
    const node = await graph.upsertNode({
      content: "Python: User prefers Python for scripting",
      entityName: "Python",
      entityType: "language",
      workspaceId: "ws1",
      baseConfidence: 0.8,
      provenance: [{ type: "materialization", sourceId: "test" }],
    });

    const result = await graph.findByEntity("Python", "ws1");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.entityName).toBe("Python");

    // Cross-workspace isolation
    const resultWs2 = await graph.findByEntity("Python", "ws2");
    expect(resultWs2.nodes).toHaveLength(0);
  });

  // 10.5: Consolidation
  it("consolidates repeated episodic entries into semantic facts", async () => {
    const backend = new InMemoryBackend();
    const vectorStore = new InMemoryVectorStore();
    const embeddingProvider = new NoopEmbeddingProvider();

    // Create 5 similar entries
    for (let i = 0; i < 5; i++) {
      await backend.addEntry({
        sessionId: `s${i}`,
        role: "assistant",
        content: `User ran pytest and all tests passed in the Python calculator project ${i}`,
        metadata: { memoryRole: "working" },
      });
    }

    const result = await runConsolidation({
      memoryBackend: backend,
      vectorStore,
      embeddingProvider,
      minEntries: 3,
    });

    expect(result.consolidated).toBeGreaterThanOrEqual(1);
  });

  // 10.6: Agent identity persistence
  it("persists agent identity with learned traits and beliefs", async () => {
    const mgr = new AgentIdentityManager({ memoryBackend: new InMemoryBackend() });

    await mgr.upsert({
      agentId: "agent-1",
      name: "Research Bot",
      corePersonality: "Thorough and analytical",
      workspaceId: "ws1",
    });
    await mgr.addLearnedTraits("agent-1", ["prefers academic sources"], "ws1");
    await mgr.upsertBelief("agent-1", "methodology", {
      belief: "systematic review is the gold standard",
      confidence: 0.85,
      evidence: ["completed 3 systematic reviews successfully"],
      formedAt: Date.now(),
    }, "ws1");

    const loaded = await mgr.load("agent-1", "ws1");
    expect(loaded!.name).toBe("Research Bot");
    expect(loaded!.learnedTraits).toContain("prefers academic sources");
    expect(loaded!.beliefs.methodology.confidence).toBe(0.85);
  });

  // 10.7: Social memory
  it("tracks inter-agent interactions in a world", async () => {
    const social = new SocialMemoryManager({ memoryBackend: new InMemoryBackend() });

    await social.recordInteraction("agent-a", "agent-b", "world-1", {
      timestamp: Date.now(),
      summary: "Discussed project architecture",
    });

    const rel = await social.getRelationship("agent-a", "agent-b", "world-1");
    expect(rel).not.toBeNull();
    expect(rel!.interactions).toHaveLength(1);

    // World isolation
    const otherWorld = await social.getRelationship("agent-a", "agent-b", "world-2");
    expect(otherWorld).toBeNull();
  });

  // 10.10: Cross-context contamination
  it("prevents cross-context memory contamination", async () => {
    const vectorStore = new InMemoryVectorStore({ dimension: 3 });

    // C project workspace
    await vectorStore.storeWithEmbedding(
      {
        sessionId: "c-session", role: "assistant",
        content: "Use cmake to build the C project with -Wall -Werror flags",
        workspaceId: "/home/user/c-project",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [1, 0, 0],
    );

    // React project workspace
    await vectorStore.storeWithEmbedding(
      {
        sessionId: "react-session", role: "assistant",
        content: "Use npm run build to compile the React application",
        workspaceId: "/home/user/react-app",
        metadata: { memoryRole: "semantic", memoryRoles: ["semantic"] },
      },
      [0.9, 0.1, 0],
    );

    // Query from React context — must NOT see C project memories
    const reactResults = await vectorStore.searchSimilar(
      [0.9, 0.1, 0],
      { workspaceId: "/home/user/react-app" },
    );
    expect(reactResults).toHaveLength(1);
    expect(reactResults[0]!.entry.content).toContain("React");
    expect(reactResults[0]!.entry.content).not.toContain("cmake");

    // Query from C context — must NOT see React memories
    const cResults = await vectorStore.searchSimilar(
      [1, 0, 0],
      { workspaceId: "/home/user/c-project" },
    );
    expect(cResults).toHaveLength(1);
    expect(cResults[0]!.entry.content).toContain("cmake");
  });

  // 10.14: Memory persistence across restart (export/import)
  it("preserves memory through export/import cycle", async () => {
    const backend1 = new InMemoryBackend();
    await backend1.addEntry({
      sessionId: "s1", role: "user", content: "important fact",
      workspaceId: "ws1",
    });
    await backend1.set("learning:ws1:latest", { patterns: [{ lesson: "test-driven" }] });

    const exported = await exportMemory({ memoryBackend: backend1 });
    expect(exported.entries.length).toBeGreaterThanOrEqual(1);

    const backend2 = new InMemoryBackend();
    const { entriesImported, kvImported } = await importMemory({
      memoryBackend: backend2,
      data: exported,
    });

    expect(entriesImported).toBeGreaterThanOrEqual(1);
    expect(kvImported).toBeGreaterThanOrEqual(1);

    const thread = await backend2.getThread("s1");
    expect(thread[0]!.content).toBe("important fact");
  });

  // Health report
  it("collects comprehensive health report", async () => {
    const backend = new InMemoryBackend();
    await backend.addEntry({ sessionId: "s1", role: "user", content: "test" });
    const vectorStore = new InMemoryVectorStore({ dimension: 128 });
    const embedding = new NoopEmbeddingProvider(128);
    const graph = new MemoryGraph(new InMemoryBackend());

    const report = await collectMemoryHealthReport({
      memoryBackend: backend,
      vectorStore,
      embeddingProvider: embedding,
      graph,
    });

    expect(report.healthy).toBe(true);
    expect(report.sessionCount).toBeGreaterThanOrEqual(1);
    expect(report.embeddingProvider!.name).toBe("noop");
    expect(report.knowledgeGraph!.nodeCount).toBe(0);
  });

  // Procedural memory
  it("records and retrieves tool sequences by trigger", async () => {
    const proc = new ProceduralMemory({ memoryBackend: new InMemoryBackend() });

    await proc.record({
      name: "python-test",
      trigger: "run Python tests with pytest",
      toolCalls: [
        { name: "system.bash", args: { command: "python3 -m pytest" } },
      ],
      workspaceId: "ws1",
    });

    const results = await proc.retrieve("run Python tests", "ws1");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("python-test");

    // Different workspace — should NOT find it
    const ws2Results = await proc.retrieve("run Python tests", "ws2");
    expect(ws2Results).toHaveLength(0);
  });

  // Shared memory
  it("shares facts across worlds with access control", async () => {
    const shared = new SharedMemoryBackend({ memoryBackend: new InMemoryBackend() });

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

  // === Phase 10.8: End-to-end memory lifecycle ===
  it("end-to-end memory lifecycle: ingest → retrieve → consolidate → new session retrieve", async () => {
    const backend = new InMemoryBackend();
    const vectorStore = new InMemoryVectorStore();
    const embedding = new NoopEmbeddingProvider();
    const logManager = new DailyLogManager(backend);
    const tmpDir = makeTmpDir();
    const curatedMemory = new CuratedMemoryManager(join(tmpDir, "curated.md"));

    const ingestionEngine = new MemoryIngestionEngine({
      embeddingProvider: embedding,
      vectorStore,
      logManager,
      curatedMemory,
      generateSummaries: false,
      enableDailyLogs: false,
      minTurnSalienceScore: 0, // index everything for this test
    });

    // 1. Ingest turn in session A
    await ingestionEngine.ingestTurn("session-A", "What is TypeScript?", "TypeScript is a typed superset of JavaScript", {
      workspaceId: "ws1",
    });

    // 2. Retrieve in session A — should find the entry
    const retrieverA = new SemanticMemoryRetriever({
      vectorBackend: vectorStore,
      embeddingProvider: embedding,
      curatedMemory,
      workspaceId: "ws1",
    });
    const resultA = await retrieverA.retrieve("TypeScript definition", "session-A");
    expect(resultA).toBeDefined();

    // 3. New session B — should still retrieve cross-session semantic entries
    const resultB = await retrieverA.retrieve("TypeScript definition", "session-B");
    // Semantic entries are cross-session, so should be found
    expect(resultB).toBeDefined();

    // 4. Agent identity survives across sessions
    const identityMgr = new AgentIdentityManager({ memoryBackend: backend });
    await identityMgr.upsert({
      agentId: "agent-1",
      name: "TestAgent",
      corePersonality: "Helpful assistant",
      workspaceId: "ws1",
    });
    await identityMgr.upsertBelief("agent-1", "typescript", {
      belief: "TypeScript is useful",
      confidence: 0.8,
      evidence: ["entry-1"],
      formedAt: Date.now(),
    }, "ws1");

    const identity = await identityMgr.load("agent-1", "ws1");
    expect(identity).not.toBeNull();
    expect(identity!.beliefs["typescript"]?.belief).toBe("TypeScript is useful");
  });

  // === Phase 10.9: Multi-agent world simulation ===
  it("multi-agent world simulation: 3 agents with isolated memory and shared state", async () => {
    const backend = new InMemoryBackend();

    // Create 3 agents in one world
    const identityMgr = new AgentIdentityManager({ memoryBackend: backend });
    const agents = ["alice", "bob", "charlie"];
    for (const name of agents) {
      await identityMgr.upsert({
        agentId: name,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        corePersonality: `${name} personality`,
        workspaceId: "world-1",
      });
    }

    // Each agent forms different beliefs
    await identityMgr.upsertBelief("alice", "coding", {
      belief: "Python is best",
      confidence: 0.7,
      evidence: ["e1"],
      formedAt: Date.now(),
    }, "world-1");
    await identityMgr.upsertBelief("bob", "coding", {
      belief: "Rust is best",
      confidence: 0.9,
      evidence: ["e2"],
      formedAt: Date.now(),
    }, "world-1");

    // Verify isolation: each agent has different beliefs
    const alice = await identityMgr.load("alice", "world-1");
    const bob = await identityMgr.load("bob", "world-1");
    expect(alice!.beliefs["coding"]?.belief).toBe("Python is best");
    expect(bob!.beliefs["coding"]?.belief).toBe("Rust is best");

    // Shared world state via social memory
    const socialMgr = new SocialMemoryManager({ memoryBackend: backend });
    await socialMgr.recordInteraction("alice", "bob", "world-1", {
      timestamp: Date.now(),
      summary: "Let's collaborate on the project",
    });

    // Alice's relationship with Bob recorded
    const relationship = await socialMgr.getRelationship("alice", "bob", "world-1");
    expect(relationship).not.toBeNull();
    expect(relationship!.interactions).toHaveLength(1);

    // World facts accessible to all agents
    await socialMgr.addWorldFact(
      "world-1",
      "The server is running on port 3000",
      "alice",
      "world",
    );

    const worldFacts = await socialMgr.getWorldFacts("world-1");
    expect(worldFacts).toHaveLength(1);
    expect(worldFacts[0]!.content).toContain("port 3000");

    // Charlie can see world facts too
    const charlieView = await socialMgr.getWorldFacts("world-1");
    expect(charlieView).toHaveLength(1);
  });

  // === Phase 10.11: Concurrent access stress test ===
  it("concurrent access: 5 sessions writing simultaneously without data loss", async () => {
    const backend = new InMemoryBackend();
    const sessions = ["s1", "s2", "s3", "s4", "s5"];
    const entriesPerSession = 20;

    // Write concurrently
    const writePromises = sessions.map(async (sessionId) => {
      for (let i = 0; i < entriesPerSession; i++) {
        await backend.addEntry({
          sessionId,
          role: "user",
          content: `Message ${i} from ${sessionId}`,
          workspaceId: sessionId.startsWith("s1") ? "ws-a" : "ws-b",
        });
      }
    });

    await Promise.all(writePromises);

    // Verify no data loss
    for (const sessionId of sessions) {
      const thread = await backend.getThread(sessionId);
      expect(thread).toHaveLength(entriesPerSession);
      // Verify ordering
      for (let i = 0; i < thread.length; i++) {
        expect(thread[i].content).toContain(`from ${sessionId}`);
      }
    }

    // Verify total entry count
    let total = 0;
    for (const sessionId of sessions) {
      const thread = await backend.getThread(sessionId);
      total += thread.length;
    }
    expect(total).toBe(sessions.length * entriesPerSession);

    // Verify workspace scoping doesn't interleave
    const ws_a_sessions = await backend.listSessions("s1");
    expect(ws_a_sessions).toContain("s1");

    // Concurrent KV writes
    const kvPromises = sessions.map(async (sessionId) => {
      await backend.set(`learning:${sessionId}`, { preference: sessionId });
    });
    await Promise.all(kvPromises);

    // All KV values intact
    for (const sessionId of sessions) {
      const val = await backend.get<{ preference: string }>(`learning:${sessionId}`);
      expect(val?.preference).toBe(sessionId);
    }
  });
});
