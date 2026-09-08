import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { toAgenCRuntimeMessages } from "../../../src/session/runtime-message-conversion.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const read = (path: string): Promise<string> =>
  readFile(resolve(repositoryRoot, path), "utf8");

/**
 * Microcompaction once exempted a tool result from clearing while it was inside
 * a time window. It could never fire: the only producer of these messages
 * stamps a constant timestamp, deliberately, because one history has to project
 * to the same bytes on every call. A guard that cannot run reads as protection
 * that is not there, so it was removed with its environment variable.
 */
describe("retired microcompact time window", () => {
  test("no time-based victim exemption survives in microcompaction", async () => {
    const source = await read("runtime/src/services/compact/microCompact.ts");
    expect(source).not.toContain("isWithinTimeWindow");
    expect(source).not.toContain("clearAfterMs");
    expect(source).not.toContain("timeBasedMCConfig");
  });

  test("the environment variable is gone from code and from the reference", async () => {
    const [environment, knip] = await Promise.all([
      read("docs/reference/env.md"),
      read("runtime/knip.config.mjs"),
    ]);
    expect(environment).not.toContain("AGENC_MICROCOMPACT_CLEAR_AFTER_MS");
    expect(knip).not.toContain("timeBasedMCConfig");
  });

  test("message conversion still stamps a constant, and says why", async () => {
    const source = await read("runtime/src/session/runtime-message-conversion.ts");
    expect(source).toContain("new Date(0).toISOString()");
    expect(source).toContain("Constant on purpose");
  });

  test("the only producer carries no wall-clock reading, which is why the window was dead", () => {
    const converted = toAgenCRuntimeMessages([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as never);
    expect(converted.length).toBe(3);
    for (const message of converted) {
      // Every stamp parses to the epoch, so "now - timestamp" was always the
      // age of Unix time and never inside any window an operator could set.
      expect(Date.parse(message.timestamp!)).toBe(0);
    }
  });
});
