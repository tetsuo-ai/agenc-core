import { describe, it, expect } from "vitest";
import { exportMemory, importMemory } from "./export-import.js";
import { InMemoryBackend } from "./in-memory/backend.js";

describe("memory export/import", () => {
  it("exports and imports entries round-trip", async () => {
    const backend = new InMemoryBackend();
    await backend.addEntry({ sessionId: "s1", role: "user", content: "hello" });
    await backend.addEntry({ sessionId: "s1", role: "assistant", content: "hi back" });
    await backend.set("test-key", { foo: "bar" });

    const exported = await exportMemory({ memoryBackend: backend });
    expect(exported.schemaVersion).toBe(1);
    expect(exported.entries).toHaveLength(2);
    expect(exported.kvEntries).toHaveLength(1);

    // Import into fresh backend
    const backend2 = new InMemoryBackend();
    const result = await importMemory({ memoryBackend: backend2, data: exported });
    expect(result.entriesImported).toBe(2);
    expect(result.kvImported).toBe(1);

    const thread = await backend2.getThread("s1");
    expect(thread).toHaveLength(2);
    const value = await backend2.get<{ foo: string }>("test-key");
    expect(value).toEqual({ foo: "bar" });
  });

  it("rejects import from newer schema version", async () => {
    const backend = new InMemoryBackend();
    await expect(
      importMemory({
        memoryBackend: backend,
        data: {
          schemaVersion: 999,
          exportedAt: Date.now(),
          entries: [],
          kvEntries: [],
        },
      }),
    ).rejects.toThrow(/newer than supported/);
  });

  it("records workspace filter in export metadata", async () => {
    const backend = new InMemoryBackend();
    await backend.addEntry({ sessionId: "s1", role: "user", content: "entry 1" });
    await backend.addEntry({ sessionId: "s2", role: "user", content: "entry 2" });

    const exported = await exportMemory({
      memoryBackend: backend,
      workspaceId: "ws1",
    });
    // InMemoryBackend doesn't support workspace filtering on getThread,
    // so all entries are exported. The workspaceId is recorded in metadata
    // for filtering during import or by SQLite-backed exports.
    expect(exported.workspaceId).toBe("ws1");
    expect(exported.entries.length).toBeGreaterThanOrEqual(1);
  });
});
