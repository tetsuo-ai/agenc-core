import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const startupHelper = ["repl", "Startup", "Gates"].join("");
const inputHelper = ["repl", "Input", "Suppression"].join("");
const workerPendingHelper = ["Worker", "Pending", "Permission"].join("");
const backgroundTaskHelper = ["Background", "Task"].join("");
const shellProgressHelper = ["Shell", "Progress"].join("");
const dreamDetailHelper = ["Dream", "Detail", "Dialog"].join("");
const monitorMcpDetailHelper = ["Monitor", "Mcp", "Detail", "Dialog"].join("");
const deletedImportPatterns = [
  new RegExp(`from ['"]\\./${backgroundTaskHelper}(?:\\.js)?['"]`),
  new RegExp(`from ['"]\\./${shellProgressHelper}(?:\\.js)?['"]`),
  new RegExp(`from ['"]\\./${dreamDetailHelper}(?:\\.js)?['"]`),
  new RegExp(`from ['"]\\./${monitorMcpDetailHelper}(?:\\.js)?['"]`),
];
const removed = [
  `runtime/src/tui/screens/${startupHelper}.ts`,
  `runtime/src/tui/screens/${startupHelper}.test.ts`,
  `runtime/src/tui/screens/${inputHelper}.ts`,
  `runtime/src/tui/screens/${inputHelper}.test.ts`,
  `runtime/src/tui/components/permissions/${workerPendingHelper}.tsx`,
  `runtime/src/tui/components/tasks/${backgroundTaskHelper}.tsx`,
  `runtime/src/tui/components/tasks/${shellProgressHelper}.tsx`,
  `runtime/src/tui/components/tasks/${dreamDetailHelper}.tsx`,
  `runtime/src/tui/components/tasks/${monitorMcpDetailHelper}.tsx`,
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
      return (
        src.includes(startupHelper)
        || src.includes(inputHelper)
        || src.includes(workerPendingHelper)
        || deletedImportPatterns.some(pattern => pattern.test(src))
      );
    });

    expect(hits).toEqual([]);
  });
});
