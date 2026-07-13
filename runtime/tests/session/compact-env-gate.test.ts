import { afterEach, describe, expect, it } from "vitest";
import { withCompactContextGuards } from "../../src/session/compact-env-guard.js";

/**
 * Drives the shipped withCompactContextGuards (DAE-01). Concurrent installs
 * must not interleave process.env mutations.
 */
describe("withCompactContextGuards (DAE-01, shipped)", () => {
  const KEY = "OPENAI_API_KEY" as const;
  const previous = process.env[KEY];

  afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  });

  it("installs env for fn duration then restores", async () => {
    delete process.env[KEY];
    let seen: string | undefined;
    await withCompactContextGuards(async () => {
      seen = process.env[KEY];
    }, { OPENAI_API_KEY: "temp-secret" });
    expect(seen).toBe("temp-secret");
    expect(process.env[KEY]).toBeUndefined();
  });

  it("serializes concurrent callers so env does not interleave", async () => {
    delete process.env[KEY];
    const log: string[] = [];

    const a = withCompactContextGuards(async () => {
      log.push(`a:enter:${process.env[KEY]}`);
      await new Promise((r) => setTimeout(r, 40));
      log.push(`a:exit:${process.env[KEY]}`);
    }, { OPENAI_API_KEY: "key-a" });

    const b = withCompactContextGuards(async () => {
      log.push(`b:enter:${process.env[KEY]}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`b:exit:${process.env[KEY]}`);
    }, { OPENAI_API_KEY: "key-b" });

    await Promise.all([a, b]);

    // Full serialization: A completes before B installs (or vice versa if
    // scheduling flipped order — both orderings are exclusive).
    expect(log).toHaveLength(4);
    const first = log[0]!.startsWith("a:") ? "a" : "b";
    const second = first === "a" ? "b" : "a";
    expect(log[0]).toBe(`${first}:enter:key-${first}`);
    expect(log[1]).toBe(`${first}:exit:key-${first}`);
    expect(log[2]).toBe(`${second}:enter:key-${second}`);
    expect(log[3]).toBe(`${second}:exit:key-${second}`);
    expect(process.env[KEY]).toBeUndefined();
  });

  it("run-turn and session-compact both import the shared helper", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const runTurn = readFileSync(
      join(__dirname, "../../src/session/run-turn.ts"),
      "utf8",
    );
    const sessionCompact = readFileSync(
      join(__dirname, "../../src/commands/session-compact.ts"),
      "utf8",
    );
    expect(runTurn).toMatch(/from ["'].\/compact-env-guard\.js["']/);
    expect(sessionCompact).toMatch(
      /from ["']\.\.\/session\/compact-env-guard\.js["']/,
    );
    // No local gate reimplementation left in either file.
    expect(runTurn).not.toMatch(/let compactEnvGate/);
    expect(sessionCompact).not.toMatch(/let compactEnvGate/);
    expect(sessionCompact).not.toMatch(
      /async function withCompactContextGuards/,
    );
  });
});
