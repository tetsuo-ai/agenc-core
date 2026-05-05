import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(resolve(current, "parity/agenc-session-memory-parity.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Unable to find agenc-session-memory parity matrix");
    }
    current = parent;
  }
}

const root = findProjectRoot(process.cwd());
const matrix = JSON.parse(
  readFileSync(resolve(root, "parity/agenc-session-memory-parity.json"), "utf8"),
) as {
  readonly rows: Array<{
    readonly id: string;
    readonly sourceFiles?: readonly string[];
    readonly targetFiles?: readonly string[];
    readonly testFiles?: readonly string[];
  }>;
};

describe("session memory contract", () => {
  it("tracks the runtime, utilities, prompts, and executable tests", () => {
    const row = matrix.rows.find((entry) => entry.id === "session-memory-runtime");
    expect(row).toBeDefined();
    expect(row?.sourceFiles).toEqual([
      "src/services/SessionMemory/sessionMemory.ts",
      "src/services/SessionMemory/sessionMemoryUtils.ts",
      "src/services/SessionMemory/prompts.ts",
    ]);
    expect(row?.targetFiles).toEqual([
      "runtime/src/services/SessionMemory/sessionMemory.ts",
      "runtime/src/services/SessionMemory/sessionMemoryUtils.ts",
      "runtime/src/services/SessionMemory/prompts.ts",
    ]);
    expect(row?.testFiles).toContain(
      "runtime/src/services/SessionMemory/sessionMemory.test.ts",
    );
    for (const target of row?.targetFiles ?? []) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
    for (const testFile of row?.testFiles ?? []) {
      expect(existsSync(resolve(root, testFile))).toBe(true);
    }
  });

  it("wires the post-sampling hook into the live turn loop", () => {
    const row = matrix.rows.find((entry) => entry.id === "session-memory-turn-wiring");
    expect(row?.testFiles).toContain("runtime/src/session/run-turn.test.ts");
    const runTurnSource = readFileSync(
      resolve(root, "runtime/src/session/run-turn.ts"),
      "utf8",
    );
    expect(runTurnSource).toContain("runSessionMemoryPostSamplingHook");
    expect(runTurnSource).toContain("launchSessionMemoryPostSampling(state, session, ctx, signal)");
    expect(runTurnSource).toContain("state.messagesForQuery.length > 0");
    expect(runTurnSource).toContain("baseInstructions");
    expect(runTurnSource).toContain("session_memory_update_failed");
  });
});
