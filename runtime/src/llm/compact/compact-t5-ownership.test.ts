/**
 * T5 ownership-drift regression guard.
 *
 * Ensures that the compaction path (`compact_owner_root` per
 * `docs/plan/runtime-owner-manifest.md:239-244`) does not reach back into
 * the legacy `bootstrap/state` stub proxy or `utils/sessionStorage`
 * helpers. Those sources carry no T5 authority — `bootstrap/state.ts` is
 * a `__stubProxy` no-op module, and `utils/sessionStorage.getTranscriptPath`
 * derives the wrong `<sessionId>.jsonl` path relative to the T5 rollout
 * file.
 *
 * Also verifies the authoritative seams:
 *   - `reAppendSessionMetadata` goes through
 *     `CompactRuntimeContext.rolloutStore.store.reAppendSessionMetadata`
 *     (the SessionStore owner, feature-matrix.md:39).
 *   - The transcript-path stamp for compact summaries comes from
 *     `CompactRuntimeContext.rolloutStore.rolloutPath` (or the
 *     underlying `store.rolloutPath`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPACT_SRC_RAW = readFileSync(join(__dirname, "compact.ts"), "utf8");
const SM_COMPACT_SRC_RAW = readFileSync(
  join(__dirname, "session-memory-compact.ts"),
  "utf8",
);

/**
 * Strip TypeScript comments so that ownership assertions about "has no
 * remaining call X" can't be defeated by explanatory prose that mentions
 * the legacy helper.
 */
function stripComments(src: string): string {
  // Remove /* ... */ block comments (non-greedy), then // line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const COMPACT_SRC = stripComments(COMPACT_SRC_RAW);
const SM_COMPACT_SRC = stripComments(SM_COMPACT_SRC_RAW);

describe("T5 ownership — compact owner root", () => {
  it("compact.ts does not import from bootstrap/state.js", () => {
    expect(COMPACT_SRC).not.toMatch(
      /from ['"]\.\.\/\.\.\/bootstrap\/state(\.js)?['"]/,
    );
    expect(COMPACT_SRC).not.toMatch(
      /from ['"]src\/bootstrap\/state(\.js)?['"]/,
    );
  });

  it("compact.ts does not import from utils/sessionStorage.js", () => {
    expect(COMPACT_SRC).not.toMatch(
      /from ['"]\.\.\/\.\.\/utils\/sessionStorage(\.js)?['"]/,
    );
  });

  it("session-memory-compact.ts does not import from bootstrap/state.js or utils/sessionStorage.js", () => {
    expect(SM_COMPACT_SRC).not.toMatch(
      /from ['"]\.\.\/\.\.\/bootstrap\/state(\.js)?['"]/,
    );
    expect(SM_COMPACT_SRC).not.toMatch(
      /from ['"]\.\.\/\.\.\/utils\/sessionStorage(\.js)?['"]/,
    );
  });

  it("compact.ts routes reAppendSessionMetadata through CompactRuntimeContext.rolloutStore.store", () => {
    // There must be at least one call site routing through the T5 seam.
    expect(COMPACT_SRC).toMatch(
      /context\.rolloutStore\?\.store\?\.reAppendSessionMetadata/,
    );
    // And no direct call to the legacy helper.
    expect(COMPACT_SRC).not.toMatch(/\breAppendSessionMetadata\s*\(\s*\)/);
  });

  it("compact.ts quotes the T5 rollout path (not the legacy getTranscriptPath stub)", () => {
    expect(COMPACT_SRC).toMatch(
      /context\.rolloutStore\?\.rolloutPath/,
    );
    expect(COMPACT_SRC).not.toMatch(/\bgetTranscriptPath\s*\(\s*\)/);
  });

  it("session-memory-compact.ts quotes the T5 rollout path via the optional compact context", () => {
    expect(SM_COMPACT_SRC).toMatch(
      /context\?\.rolloutStore\?\.rolloutPath/,
    );
    expect(SM_COMPACT_SRC).not.toMatch(/\bgetTranscriptPath\s*\(\s*\)/);
  });

  it("compact.ts has no remaining calls to the dead bootstrap/state helpers", () => {
    expect(COMPACT_SRC).not.toMatch(/\bmarkPostCompaction\s*\(\s*\)/);
    // `getInvokedSkillsForAgent` is only referenced in a comment now.
    expect(COMPACT_SRC).not.toMatch(/\bgetInvokedSkillsForAgent\s*\(/);
    // `getSessionId()` / `getOriginalCwd()` live in comments; no bare calls.
    expect(COMPACT_SRC).not.toMatch(/(?<![A-Za-z_])getSessionId\s*\(\s*\)/);
    expect(COMPACT_SRC).not.toMatch(/(?<![A-Za-z_])getOriginalCwd\s*\(\s*\)/);
  });
});
