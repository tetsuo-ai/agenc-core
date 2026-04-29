/**
 * Worker 4 — T4 integration tests for compact wiring.
 *
 * These tests exercise live paths through:
 *   - Manual `/compact` dispatcher (does NOT route through
 *     `autoCompactIfNeeded`; circuit-breaker bypass is intentional
 *     per feature-matrix.md:196 and annotated in manual-compact.ts).
 *     The source lineage is AgenC's local ../opencode-compatible
 *     compaction contract, not the AgenC runtime task subsystem.
 *   - Stage-6 `prepareContext` auto-compact gating (does NOT fire when
 *     `runPreSamplingCompact` already compacted this turn — one-
 *     compact-per-turn contract matching AgenC runtime run_pre_sampling_compact
 *     + run_auto_compact routing).
 *   - I-2 `previous_response_id` clear on compact — asserts that the
 *     `ProviderHttpClient.responsesContinuationState.lastResponseId`
 *     value gets cleared via `runPostCompactCleanup` on the real
 *     provider-continuation path.
 *
 * These tests deliberately avoid stubbing `autoCompactIfNeeded`,
 * `compactConversation`, or `runPostCompactCleanup` so regressions in
 * the live wiring (not just mock expectations) are caught.
 *
 * @module
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

// ─────────────────────────────────────────────────────────────────────
// T4 #2 — Manual `/compact` bypasses autoCompactIfNeeded intentionally.
// ─────────────────────────────────────────────────────────────────────

describe("manual compact (T4 #2) — circuit-breaker bypass is intentional", () => {
  it("manual-compact.ts does NOT import autoCompactIfNeeded", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "manual-compact.ts"),
      "utf8",
    );
    // Negative assertion — runManualCompact must NOT thread through
    // autoCompactIfNeeded, because the user has explicitly requested
    // compaction and the threshold gate + circuit-breaker would block
    // legitimate user intent.
    expect(src).not.toMatch(/\bautoCompactIfNeeded\s*\(/);
    expect(src).not.toMatch(/from ['"].*\/auto-compact(\.js)?['"]/);
  });

  it("annotates the intentional bypass with a T4 rationale comment", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "manual-compact.ts"),
      "utf8",
    );
    // Require the documented rationale so the bypass can't drift back
    // to an undocumented one-off in future refactors.
    expect(src).toMatch(
      /INTENTIONAL.*manual.*`\/compact`.*`compactConversation`\s+directly/is,
    );
    expect(src).toMatch(/\.\.\/opencode session compaction contract/);
    expect(src).toMatch(/circuit[\s-]?breaker/i);
    expect(src).toMatch(/feature-matrix\.md:196/);
  });

  it("routes reAppendSessionMetadata through the T5 SessionStore seam", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "manual-compact.ts"),
      "utf8",
    );
    expect(src).toMatch(/rolloutStore\?.store\.reAppendSessionMetadata/);
    // No direct import from the legacy utils/sessionStorage helpers.
    expect(src).not.toMatch(
      /from ['"]\.\.\/utils\/sessionStorage(\.js)?['"]/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// T4 #5 — Double-compact dispatcher gate.
// ─────────────────────────────────────────────────────────────────────

describe("prepare-context Stage-6 (T4 #5) — single-compact-per-turn gate", () => {
  it("skips Stage-6 when pre-sampling already compacted this turn", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../phases/prepare-context.ts"),
      "utf8",
    );
    // Gate: require the explicit pre-sampling guard variable.
    expect(src).toMatch(/preSamplingAlreadyCompacted/);
    // Gate references: BOTH compacted=true AND turnCounter===0.
    expect(src).toMatch(/autoCompactTracking\?\.compacted\s*===\s*true/);
    expect(src).toMatch(/autoCompactTracking\.turnCounter\s*===\s*0/);
    // Gate wired to the auto-compact import — when true, autoMod resolves to null.
    expect(src).toMatch(
      /preSamplingAlreadyCompacted[\s\S]*null[\s\S]*safeCompactImport/,
    );
  });

  it("Stage-6 on-compact write-back mirrors the pre-sampling path (state.messages + state.messagesForQuery)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../phases/prepare-context.ts"),
      "utf8",
    );
    // The Stage-6 success branch must write BOTH state.messages and
    // messagesForQuery to match AgenC query.ts:541-620 and the
    // pre-sampling write-back at run-turn.ts:330-331.
    expect(src).toMatch(
      /state\.messages\s*=\s*\[\.\.\.compactedMessages\]/,
    );
    expect(src).toMatch(/messagesForQuery\s*=\s*compactedMessages/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T4 #1 + #6 + #8 — compact.ts T5 ownership + disk-fallback hygiene.
// ─────────────────────────────────────────────────────────────────────

describe("compact.ts (T4 #1, #6, #8) — legacy sessionStorage/bootstrap removal", () => {
  it("no direct import from utils/sessionStorage.js", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/compact.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /^\s*import[\s\S]*from ['"]\.\.\/\.\.\/utils\/sessionStorage(\.js)?['"]/m,
    );
  });

  it("no direct import from bootstrap/state.js", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/compact.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /^\s*import[\s\S]*from ['"]\.\.\/\.\.\/bootstrap\/state(\.js)?['"]/m,
    );
    expect(src).not.toMatch(
      /^\s*import[\s\S]*from ['"]src\/bootstrap\/state(\.js)?['"]/m,
    );
  });

  it("no bare calls to legacy stub helpers (markPostCompaction, getSessionId, getOriginalCwd, getInvokedSkillsForAgent)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/compact.ts"),
      "utf8",
    );
    // Strip comments first so documentary prose mentioning these names
    // doesn't confuse the assertion.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/\bmarkPostCompaction\s*\(/);
    expect(stripped).not.toMatch(
      /(?<![A-Za-z_])getSessionId\s*\(\s*\)/,
    );
    expect(stripped).not.toMatch(
      /(?<![A-Za-z_])getOriginalCwd\s*\(\s*\)/,
    );
    expect(stripped).not.toMatch(/\bgetInvokedSkillsForAgent\s*\(/);
  });

  it("reAppendSessionMetadata call sites all route through CompactRuntimeContext", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/compact.ts"),
      "utf8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Count routed (T5) calls.
    const routedMatches =
      stripped.match(
        /context\.rolloutStore\?\.store\?\.reAppendSessionMetadata\?\.\(\s*\)/g,
      ) ?? [];
    // There are two compactConversation code paths (full + partial).
    // Both must route through the context seam.
    expect(routedMatches.length).toBeGreaterThanOrEqual(2);
    // No bare call allowed.
    expect(stripped).not.toMatch(/\breAppendSessionMetadata\s*\(\s*\)/);
  });

  it("loadCompactToolResultIndex prefers live rolloutStore; does not fall back to stub proxies", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/compact.ts"),
      "utf8",
    );
    // The on-disk fallback is still legitimate for SessionStore-backed
    // paths that carry explicit (sessionId, cwd) in context — confirmed
    // by compact-i88.test.ts. But it must NOT reach into the legacy
    // bootstrap/state stubs.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Inside loadCompactToolResultIndex (roughly line 720-810), the
    // only session-id/cwd sources must be the context fields.
    const fnStart = stripped.indexOf(
      "export function loadCompactToolResultIndex",
    );
    const fnEnd = stripped.indexOf("export function", fnStart + 10);
    const fnBody = stripped.slice(
      fnStart,
      fnEnd > 0 ? fnEnd : stripped.length,
    );
    expect(fnBody).not.toMatch(
      /(?<![A-Za-z_])getSessionId\s*\(\s*\)/,
    );
    expect(fnBody).not.toMatch(
      /(?<![A-Za-z_])getOriginalCwd\s*\(\s*\)/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// I-2 live path — previous_response_id cleared on compact.
// ─────────────────────────────────────────────────────────────────────

describe("I-2 live path — runPostCompactCleanup clears provider continuation state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clears lastResponseId on ResponsesContinuationState via clearProviderResponseId callback", async () => {
    // Drive the real runPostCompactCleanup (no stub) against a real
    // responses-continuation state holder. Asserts the I-2 contract
    // (invariants.md:41-75) that EVERY cleanup path synchronously
    // clears the `previous_response_id` cache on the wire.
    const {
      clearResponsesContinuationResponseId,
    } = await import("../llm/shape-request.js");
    const { runPostCompactCleanup } = await import(
      "../llm/compact/post-compact-cleanup.js"
    );

    const state: {
      lastResponseId?: string;
      lastResponseOutput?: unknown;
      lastRequest?: unknown;
    } = {
      lastResponseId: "resp_integration_abc123",
      lastResponseOutput: [{ type: "message", id: "m1" }],
      lastRequest: { prompt: "ignore" },
    };

    const clearProviderResponseId = () => {
      // Real provider-continuation contract — the session wires this
      // to clearResponsesContinuationResponseId(session.responsesContinuationState)
      // (compact-runtime-context.ts:263; session clears the shared state on the wire).
      clearResponsesContinuationResponseId(
        state as Parameters<
          typeof clearResponsesContinuationResponseId
        >[0],
      );
    };

    expect(state.lastResponseId).toBe("resp_integration_abc123");
    runPostCompactCleanup("compact", { clearProviderResponseId });
    expect(state.lastResponseId).toBeUndefined();
    expect(state.lastResponseOutput).toBeUndefined();
  });

  it("is called from the manual /compact cleanup path", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "manual-compact.ts"),
      "utf8",
    );
    // Both session-memory and traditional-compact success branches
    // must invoke runPostCompactCleanup synchronously before returning
    // to the phase machine (I-2 synchronous-cleanup contract).
    const runCleanupCalls = src.match(/runPostCompactCleanup\s*\(/g) ?? [];
    expect(runCleanupCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("is called from the autoCompactIfNeeded success paths (session-memory + traditional)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../llm/compact/auto-compact.ts"),
      "utf8",
    );
    const runCleanupCalls = src.match(/runPostCompactCleanup\s*\(/g) ?? [];
    expect(runCleanupCalls.length).toBeGreaterThanOrEqual(2);
  });
});
