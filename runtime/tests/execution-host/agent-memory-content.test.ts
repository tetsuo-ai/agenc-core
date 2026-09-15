import { describe, expect, test } from "vitest";
import { dirname } from "node:path";
import { readScopedExecutionText } from "../../src/execution/scoped-content.js";
import { getAgentMemoryDir, readAgentMemoryPrompt } from "../../src/tools/AgentTool/agentMemory.js";
import { TaskFiles } from "./task-files-fixture.js";

describe("protected agent-memory content", () => {
  test("reads isolated /app memory without creating or migrating directories during discovery", async () => {
    const left = new TaskFiles(), right = new TaskFiles();
    const path = getAgentMemoryDir("worker", "local", "/app") + "MEMORY.md";
    left.put(path, "Left α"); right.put(path, "Right β");
    expect(await readAgentMemoryPrompt("worker", "local", "/app", left.environment())).toContain("Left α");
    expect(await readAgentMemoryPrompt("worker", "local", "/app", right.environment("d"))).toContain("Right β");
    left.put("/app/.agenc/agent-memory/legacy/MEMORY.md", "Legacy notes");
    const before = [...left.entries.keys()];
    expect(await readAgentMemoryPrompt("legacy", "project", "/app", left.environment())).toContain("Legacy notes");
    expect(await readAgentMemoryPrompt("missing", "project", "/app", left.environment())).toContain("currently empty");
    expect([...left.entries.keys()]).toEqual(before);
  });

  test("rejects linked files and directories and unsafe special resources", async () => {
    const files = new TaskFiles();
    const path = getAgentMemoryDir("worker", "project", "/app") + "MEMORY.md";
    files.put(path, "Private notes");
    const file = files.entries.get(path)!;
    for (const identity of [
      { ...file.identity, nlink: "2" },
      { ...file.identity, mode: String(0o120777) },
      { ...file.identity, mode: String(0o010600) },
    ]) {
      files.entries.set(path, { ...file, identity });
      expect(await readAgentMemoryPrompt("worker", "project", "/app", files.environment())).toContain("Memory unavailable");
    }
    files.entries.set(path, file);
    const parent = files.entries.get(dirname(path))!;
    files.entries.set(dirname(path), { ...parent, identity: { ...parent.identity, mode: String(0o120777) } });
    expect(await readAgentMemoryPrompt("worker", "project", "/app", files.environment())).not.toContain("Private notes");
    await expect(readScopedExecutionText(files.environment(), "/app", "/outside/MEMORY.md")).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("discards raced parent content, releases held files, and propagates environment loss", async () => {
    const files = new TaskFiles();
    const path = getAgentMemoryDir("worker", "project", "/app") + "MEMORY.md";
    files.put(path, "Private notes");
    const bind = files.filesystem.bindFileSnapshot;
    files.filesystem.bindFileSnapshot = async path => {
      const held = await bind(path);
      return { ...held, readFile: async maximum => {
        const bytes = await held.readFile(maximum);
        files.put(dirname(path), "", true);
        return bytes;
      } };
    };
    expect(await readAgentMemoryPrompt("worker", "project", "/app", files.environment())).not.toContain("Private notes");
    expect(files.released).toBe(1);
    files.unavailable = true;
    await expect(readAgentMemoryPrompt("worker", "project", "/app", files.environment())).rejects.toMatchObject({ code: "environment_dead" });
  });
});
