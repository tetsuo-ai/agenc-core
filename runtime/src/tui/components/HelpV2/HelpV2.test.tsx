import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("./HelpV2.tsx", import.meta.url), "utf8");

describe("HelpV2 tab set", () => {
  test("has no inactive internal-only tab branch", () => {
    expect(source).not.toContain("antOnlyCommands");
    expect(source).not.toContain("INTERNAL_ONLY_COMMANDS");
    expect(source).not.toContain("false &&");
    expect(source).not.toContain("false ?");
  });
});
