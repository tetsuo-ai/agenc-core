import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("system prompt authority architecture", () => {
  test("keeps startup and provider switches on one base-instructions adapter", () => {
    const authority = source("../../src/prompts/system-prompt.ts");
    const consumers = [
      source("../../src/bin/bootstrap.ts"),
      source("../../src/session/session.ts"),
    ];

    expect(authority).toMatch(
      /export async function assembleBaseInstructionsForModel\b/u,
    );
    for (const consumer of consumers) {
      expect(consumer).toContain("assembleBaseInstructionsForModel({");
      expect(consumer).not.toMatch(
        /function\s+buildBaseInstructionsForModel\b/u,
      );
    }
  });
});
