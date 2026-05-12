import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("./Settings.tsx", import.meta.url), "utf8");

describe("Settings tabs", () => {
  test("does not retain disabled Gates tab branches", () => {
    expect(source).not.toContain("Gates");
    expect(source).not.toContain("gatesOwnsEsc");
    expect(source).not.toContain("false ?");
  });
});
