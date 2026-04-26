/**
 * Drift detector for codex memory-pipeline prompt constants.
 *
 * Each test re-reads the original codex `.md` template at test time and
 * asserts byte-for-byte equality with the exported TS constant. If the
 * codex repo isn't checked out at the expected sibling path, the test
 * is skipped (with a console warning) so CI without that working tree
 * still passes — local devs running this against a fresh codex tree
 * will catch any verbatim drift.
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CONSOLIDATION_PROMPT,
  READ_PATH_PROMPT,
  STAGE_ONE_INPUT_PROMPT,
  STAGE_ONE_SYSTEM_PROMPT,
} from "./codex-pipeline.js";

/**
 * Best-effort lookup for the codex working tree. The user's local layout
 * keeps codex as a sibling of AgenC at `~/git/codex`, but anyone else
 * may have it elsewhere — so we accept an env override and fall back to
 * a couple of common locations before skipping.
 */
function findCodexTemplatesDir(): string | null {
  const fromEnv = process.env.CODEX_REPO_PATH;
  const candidates = [
    fromEnv ? resolve(fromEnv, "codex-rs/core/templates/memories") : null,
    "/home/tetsuo/git/codex/codex-rs/core/templates/memories",
    resolve(process.cwd(), "../../../codex/codex-rs/core/templates/memories"),
    resolve(process.cwd(), "../../../../codex/codex-rs/core/templates/memories"),
  ].filter((p): p is string => typeof p === "string");
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "stage_one_input.md"))) {
      return candidate;
    }
  }
  return null;
}

const codexDir = findCodexTemplatesDir();

describe("codex memory-pipeline prompts (verbatim)", () => {
  if (codexDir === null) {
    // eslint-disable-next-line no-console
    console.warn(
      "[codex-pipeline.test] codex repo not found locally; " +
        "set CODEX_REPO_PATH or clone codex as a sibling to run drift checks. " +
        "Skipping byte-for-byte verification.",
    );
    it.skip("STAGE_ONE_INPUT_PROMPT matches codex source", () => {});
    it.skip("STAGE_ONE_SYSTEM_PROMPT matches codex source", () => {});
    it.skip("CONSOLIDATION_PROMPT matches codex source", () => {});
    it.skip("READ_PATH_PROMPT matches codex source", () => {});
    return;
  }

  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["STAGE_ONE_INPUT_PROMPT", "stage_one_input.md", STAGE_ONE_INPUT_PROMPT],
    ["STAGE_ONE_SYSTEM_PROMPT", "stage_one_system.md", STAGE_ONE_SYSTEM_PROMPT],
    ["CONSOLIDATION_PROMPT", "consolidation.md", CONSOLIDATION_PROMPT],
    ["READ_PATH_PROMPT", "read_path.md", READ_PATH_PROMPT],
  ];

  for (const [name, file, value] of cases) {
    it(`${name} matches codex source (${file})`, () => {
      const upstream = readFileSync(resolve(codexDir, file), "utf8");
      expect(value).toBe(upstream);
    });
  }

  it("all four constants are non-empty strings", () => {
    expect(typeof STAGE_ONE_INPUT_PROMPT).toBe("string");
    expect(typeof STAGE_ONE_SYSTEM_PROMPT).toBe("string");
    expect(typeof CONSOLIDATION_PROMPT).toBe("string");
    expect(typeof READ_PATH_PROMPT).toBe("string");
    expect(STAGE_ONE_INPUT_PROMPT.length).toBeGreaterThan(0);
    expect(STAGE_ONE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(CONSOLIDATION_PROMPT.length).toBeGreaterThan(0);
    expect(READ_PATH_PROMPT.length).toBeGreaterThan(0);
  });
});
