import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * A fresh process must be able to enter the sandbox module graph through
 * either end. `linux-launcher/config.ts` reads engine constants while it
 * initialises, and the engine index re-exports the manager, which reached
 * that file through `bound-readonly-profile.ts` (#2455). With the constants
 * coming from `engine/index.js`, importing the index first evaluated
 * `config.ts` before the index body ran:
 * "Cannot access 'AGENC_LINUX_SANDBOX_ARG0' before initialization". That is
 * what killed the m5 crash-child fixture, which starts a new Node process.
 */
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));
const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

function importFirst(relativePath: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      TSX_IMPORT,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(SRC + relativePath)});`,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("sandbox engine import order", () => {
  test.each([
    "sandbox/engine/index.ts",
    "sandbox/linux-launcher/config.ts",
    "sandbox/engine/bound-readonly-profile.ts",
  ])("a fresh process can import %s first", (entry) => {
    const { status, stderr } = importFirst(entry);
    expect(stderr, entry).not.toMatch(/before initialization/u);
    expect(status, `${entry}\n${stderr}`).toBe(0);
  });
});
