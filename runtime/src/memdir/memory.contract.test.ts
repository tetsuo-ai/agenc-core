import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const matrix = JSON.parse(
  readFileSync(resolve(root, "parity/openclaude-memory-parity.json"), "utf8"),
) as {
  rows: Array<{ id: string; sources?: string[]; targets?: string[] }>;
};

describe("memdir memory contract", () => {
  it("has every mapped memdir source copied to a live target", () => {
    const row = matrix.rows.find((entry) => entry.id === "memdir-runtime");
    expect(row).toBeDefined();
    expect(row?.sources?.length).toBe(9);
    expect(row?.targets?.length).toBe(9);
    for (const target of row?.targets ?? []) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
  });
});
