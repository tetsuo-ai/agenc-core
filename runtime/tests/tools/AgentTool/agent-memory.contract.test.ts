import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");

describe("agent memory contract", () => {
  it("has the agent memory runtime files in live tool paths", () => {
    expect(
      existsSync(resolve(root, "runtime/src/tools/AgentTool/agentMemory.ts")),
    ).toBe(true);
    expect(
      existsSync(
        resolve(root, "runtime/src/tools/AgentTool/agentMemorySnapshot.ts"),
      ),
    ).toBe(true);
  });
});
