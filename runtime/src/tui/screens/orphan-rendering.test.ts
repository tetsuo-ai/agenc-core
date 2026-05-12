import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const startupHelper = ["repl", "Startup", "Gates"].join("");
const inputHelper = ["repl", "Input", "Suppression"].join("");
const removed = [
  `runtime/src/tui/screens/${startupHelper}.ts`,
  `runtime/src/tui/screens/${startupHelper}.test.ts`,
  `runtime/src/tui/screens/${inputHelper}.ts`,
  `runtime/src/tui/screens/${inputHelper}.test.ts`,
];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe("orphan TUI rendering helpers", () => {
  test("deleted screen helpers stay absent", () => {
    for (const rel of removed) {
      expect(existsSync(join(repoRoot, rel))).toBe(false);
    }
  });

  test("runtime TUI and scripts no longer import deleted helpers", () => {
    const scannedFiles = [
      ...filesUnder(join(repoRoot, "runtime/src/tui")),
      ...filesUnder(join(repoRoot, "scripts")),
    ].filter(file => /\.(ts|tsx|mjs|js)$/.test(file));
    const hits = scannedFiles.filter(file => {
      const src = readFileSync(file, "utf8");
      return src.includes(startupHelper) || src.includes(inputHelper);
    });

    expect(hits).toEqual([]);
  });
});
