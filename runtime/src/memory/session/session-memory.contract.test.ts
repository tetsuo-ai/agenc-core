import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");

describe("session memory runtime contract", () => {
  it("keeps runtime, utility, prompt, and executable test files live", () => {
    for (const rel of [
      "runtime/src/memory/session/sessionMemory.ts",
      "runtime/src/memory/session/sessionMemoryUtils.ts",
      "runtime/src/memory/session/prompts.ts",
      "runtime/src/memory/session/sessionMemory.test.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), rel).toBe(true);
    }
    expect(existsSync(resolve(root, "runtime/src/services/SessionMemory"))).toBe(false);
  });

  it("wires the post-sampling hook into the live turn loop", () => {
    const runTurnSource = readFileSync(resolve(root, "runtime/src/session/run-turn.ts"), "utf8");
    expect(runTurnSource).toContain("runSessionMemoryPostSamplingHook");
    expect(runTurnSource).toContain("launchSessionMemoryPostSampling(state, session, ctx, signal)");
    expect(runTurnSource).toContain("state.messagesForQuery.length > 0");
    expect(runTurnSource).toContain("baseInstructions");
    expect(runTurnSource).toContain("session_memory_update_failed");
  });
});
