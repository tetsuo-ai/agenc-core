import { describe, it, expect } from "vitest";
import { ProceduralMemory } from "./procedural.js";
import { InMemoryBackend } from "./in-memory/backend.js";

function createProcMem(config?: { keyPrefix?: string }) {
  return new ProceduralMemory({
    memoryBackend: new InMemoryBackend(),
    ...config,
  });
}

describe("ProceduralMemory", () => {
  it("records a successful tool sequence", async () => {
    const mem = createProcMem();
    const result = await mem.record({
      name: "create-python-calc",
      trigger: "create a Python calculator",
      toolCalls: [
        { name: "system.writeFile", args: { path: "/tmp/calc.py", content: "..." } },
        { name: "system.bash", args: { command: "python3 /tmp/calc.py" } },
      ],
      workspaceId: "ws1",
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("create-python-calc");
    expect(result!.steps).toHaveLength(2);
    expect(result!.successCount).toBe(1);
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it("increments success count on duplicate procedure", async () => {
    const mem = createProcMem();
    const input = {
      name: "build-project",
      trigger: "build the project",
      toolCalls: [
        { name: "system.bash", args: { command: "make" } },
      ],
      workspaceId: "ws1",
    };

    await mem.record(input);
    const second = await mem.record(input);

    expect(second!.successCount).toBe(2);
    expect(second!.confidence).toBeGreaterThan(0.5);
  });

  it("retrieves relevant procedures by trigger similarity", async () => {
    const mem = createProcMem();
    await mem.record({
      name: "python-calc",
      trigger: "create a Python calculator with argparse",
      toolCalls: [
        { name: "system.writeFile", args: { path: "/tmp/calc.py" } },
      ],
      workspaceId: "ws1",
    });
    await mem.record({
      name: "rust-linked-list",
      trigger: "implement a Rust linked list with tests",
      toolCalls: [
        { name: "system.writeFile", args: { path: "/tmp/main.rs" } },
      ],
      workspaceId: "ws1",
    });

    const results = await mem.retrieve("build a Python calculator", "ws1");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("python-calc");
  });

  it("normalizes workspace paths in args", async () => {
    const mem = createProcMem();
    const result = await mem.record({
      name: "write-file",
      trigger: "create a file",
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/home/user/project/src/main.py", content: "..." },
        },
      ],
      workspacePath: "/home/user/project",
      workspaceId: "ws1",
    });

    expect(result!.steps[0]!.argsPattern).toContain("{workspace}");
    expect(result!.steps[0]!.argsPattern).not.toContain("/home/user/project");
  });

  it("filters out failed tool calls", async () => {
    const mem = createProcMem();
    const result = await mem.record({
      name: "mixed-results",
      trigger: "build with errors",
      toolCalls: [
        { name: "system.writeFile", args: { path: "/tmp/f.py" } },
        { name: "system.bash", args: { command: "make" }, isError: true },
        { name: "system.bash", args: { command: "make clean && make" } },
      ],
      workspaceId: "ws1",
    });

    expect(result!.steps).toHaveLength(2); // Only successful calls
  });

  it("returns null for empty tool calls", async () => {
    const mem = createProcMem();
    const result = await mem.record({
      name: "empty",
      trigger: "nothing",
      toolCalls: [],
      workspaceId: "ws1",
    });

    expect(result).toBeNull();
  });

  it("isolates procedures by workspace", async () => {
    const mem = createProcMem();
    await mem.record({
      name: "ws1-proc",
      trigger: "do something specific",
      toolCalls: [{ name: "system.bash", args: { command: "echo ws1" } }],
      workspaceId: "ws1",
    });
    await mem.record({
      name: "ws2-proc",
      trigger: "do something different",
      toolCalls: [{ name: "system.bash", args: { command: "echo ws2" } }],
      workspaceId: "ws2",
    });

    const ws1Results = await mem.retrieve("do something", "ws1");
    const ws2Results = await mem.retrieve("do something", "ws2");

    expect(ws1Results).toHaveLength(1);
    expect(ws1Results[0]!.name).toBe("ws1-proc");
    expect(ws2Results).toHaveLength(1);
    expect(ws2Results[0]!.name).toBe("ws2-proc");
  });

  it("formats procedures for prompt injection", async () => {
    const mem = createProcMem();
    const entry = await mem.record({
      name: "test-proc",
      trigger: "run tests",
      toolCalls: [
        { name: "system.bash", args: { command: "python3 -m pytest" } },
      ],
      workspaceId: "ws1",
    });

    const formatted = mem.formatForPrompt([entry!]);
    expect(formatted).toContain("## Previously Successful Approaches");
    expect(formatted).toContain("test-proc");
    expect(formatted).toContain("system.bash");
  });

  it("tracks failure count and reduces confidence", async () => {
    const mem = createProcMem();
    const entry = await mem.record({
      name: "fragile-proc",
      trigger: "fragile operation",
      toolCalls: [{ name: "system.bash", args: { command: "risky" } }],
      workspaceId: "ws1",
    });

    await mem.recordFailure(entry!.id, "ws1");
    await mem.recordFailure(entry!.id, "ws1");

    // Retrieve should still find it but with reduced confidence
    const results = await mem.retrieve("fragile operation", "ws1");
    expect(results).toHaveLength(1);
    expect(results[0]!.failureCount).toBe(2);
    expect(results[0]!.confidence).toBeLessThan(0.5);
  });
});
