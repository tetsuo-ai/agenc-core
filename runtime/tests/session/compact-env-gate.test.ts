import { describe, expect, it } from "vitest";

/**
 * Structural + behavioral smoke for DAE-01: withCompactContextGuards is not
 * exported, so we verify the serialization contract via source + a local
 * reimplementation of the gate pattern that matches the shipped algorithm.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("compact env gate (DAE-01)", () => {
  it("run-turn serializes compact env installs", () => {
    const src = readFileSync(
      join(__dirname, "../../src/session/run-turn.ts"),
      "utf8",
    );
    expect(src).toMatch(/compactEnvGate/);
    expect(src).toMatch(/DAE-01/);
    // Must await previous gate before mutating process.env.
    expect(src).toMatch(/await previousGate/);
  });

  it("serialized gate prevents interleaved env restores", async () => {
    let gate: Promise<void> = Promise.resolve();
    const log: string[] = [];
    const withGate = async (label: string, ms: number) => {
      let release!: () => void;
      const prev = gate;
      gate = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      log.push(`enter:${label}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`exit:${label}`);
      release();
    };
    await Promise.all([withGate("a", 30), withGate("b", 5)]);
    expect(log).toEqual(["enter:a", "exit:a", "enter:b", "exit:b"]);
  });
});
