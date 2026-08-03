import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE,
  MAX_MEMORY_AUDIT_MS_PER_SLICE,
  MAX_MEMORY_BUILD_OPEN_DIRECTORIES,
  MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS,
  MAX_MEMORY_FILES_PER_ROOT,
  MAX_MEMORY_FTS_CANDIDATES,
  MAX_MEMORY_HEADER_UTF8_BYTES,
  MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE,
  MAX_MEMORY_INDEX_BUILD_SLICE_MS,
  MAX_MEMORY_INDEX_BYTES,
  MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS,
  MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE,
  MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH,
  MAX_MEMORY_INDEX_CONCURRENT_BUILDS,
  MAX_MEMORY_INDEX_ROOTS,
  MAX_MEMORY_INDEX_TOTAL_BUILD_MS,
  MAX_MEMORY_INDEX_WATCHERS,
  MAX_MEMORY_PATH_UTF8_BYTES,
  MAX_MEMORY_QUERY_MS,
  MAX_MEMORY_QUERY_PROCESSES,
  MAX_MEMORY_QUERY_QUEUE,
  MAX_MEMORY_QUERY_RESULT_BYTES,
  MAX_MEMORY_QUERY_TERMS,
  MAX_MEMORY_RECENT_UNION,
  MAX_MEMORY_SELECTOR_CANDIDATES,
  MEMORY_BM25_DESCRIPTION_WEIGHT,
  MEMORY_BM25_TITLE_WEIGHT,
  MEMORY_AUDIT_BACKOFF_MULTIPLIER,
  MEMORY_AUDIT_MAX_INTERVAL_MS,
  MEMORY_AUDIT_MIN_INTERVAL_MS,
  MEMORY_FTS_TERM_OPERATOR,
  MEMORY_FTS_TOKENIZER,
  MEMORY_INDEX_ROOT_IDLE_TTL_MS,
  MEMORY_INDEX_BUILD_LEASE_MS,
  MEMORY_RRF_GLOBAL_WEIGHT,
  MEMORY_RRF_K,
  MEMORY_RRF_PROJECT_WEIGHT,
  MEMORY_RRF_RECENT_WEIGHT,
  MEMORY_WATCH_DEBOUNCE_MS,
  buildMemoryFtsMatch,
  computeMemoryHeaderFingerprint,
  fuseMemoryRanks,
  type MemoryRankCandidate,
} from "../../src/memory/full-corpus-contract.js";

describe("C3b full-corpus memory contract", () => {
  it("freezes every resource, tokenizer, BM25, and RRF constant", () => {
    expect({
      MAX_MEMORY_INDEX_ROOTS,
      MAX_MEMORY_FILES_PER_ROOT,
      MAX_MEMORY_HEADER_UTF8_BYTES,
      MAX_MEMORY_PATH_UTF8_BYTES,
      MAX_MEMORY_RECENT_UNION,
      MAX_MEMORY_FTS_CANDIDATES,
      MAX_MEMORY_SELECTOR_CANDIDATES,
      MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE,
      MAX_MEMORY_INDEX_BUILD_SLICE_MS,
      MAX_MEMORY_INDEX_TOTAL_BUILD_MS,
      MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS,
      MAX_MEMORY_QUERY_TERMS,
      MAX_MEMORY_QUERY_MS,
      MAX_MEMORY_QUERY_RESULT_BYTES,
      MAX_MEMORY_QUERY_PROCESSES,
      MAX_MEMORY_QUERY_QUEUE,
      MAX_MEMORY_INDEX_BYTES,
      MAX_MEMORY_INDEX_WATCHERS,
      MAX_MEMORY_INDEX_CONCURRENT_BUILDS,
      MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS,
      MEMORY_INDEX_ROOT_IDLE_TTL_MS,
      MEMORY_INDEX_BUILD_LEASE_MS,
      MEMORY_AUDIT_MIN_INTERVAL_MS,
      MEMORY_AUDIT_MAX_INTERVAL_MS,
      MEMORY_AUDIT_BACKOFF_MULTIPLIER,
      MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH,
      MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE,
      MEMORY_WATCH_DEBOUNCE_MS,
      MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE,
      MAX_MEMORY_AUDIT_MS_PER_SLICE,
      MAX_MEMORY_BUILD_OPEN_DIRECTORIES,
      MEMORY_FTS_TOKENIZER,
      MEMORY_FTS_TERM_OPERATOR,
      MEMORY_BM25_TITLE_WEIGHT,
      MEMORY_BM25_DESCRIPTION_WEIGHT,
      MEMORY_RRF_K,
      MEMORY_RRF_PROJECT_WEIGHT,
      MEMORY_RRF_GLOBAL_WEIGHT,
      MEMORY_RRF_RECENT_WEIGHT,
    }).toEqual({
      MAX_MEMORY_INDEX_ROOTS: 64,
      MAX_MEMORY_FILES_PER_ROOT: 1_000_000,
      MAX_MEMORY_HEADER_UTF8_BYTES: 65_536,
      MAX_MEMORY_PATH_UTF8_BYTES: 16_384,
      MAX_MEMORY_RECENT_UNION: 32,
      MAX_MEMORY_FTS_CANDIDATES: 200,
      MAX_MEMORY_SELECTOR_CANDIDATES: 50,
      MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE: 10_000,
      MAX_MEMORY_INDEX_BUILD_SLICE_MS: 30_000,
      MAX_MEMORY_INDEX_TOTAL_BUILD_MS: 3_600_000,
      MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS: 300_000,
      MAX_MEMORY_QUERY_TERMS: 128,
      MAX_MEMORY_QUERY_MS: 500,
      MAX_MEMORY_QUERY_RESULT_BYTES: 1_048_576,
      MAX_MEMORY_QUERY_PROCESSES: 4,
      MAX_MEMORY_QUERY_QUEUE: 64,
      MAX_MEMORY_INDEX_BYTES: 536_870_912,
      MAX_MEMORY_INDEX_WATCHERS: 64,
      MAX_MEMORY_INDEX_CONCURRENT_BUILDS: 2,
      MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS: 100_000,
      MEMORY_INDEX_ROOT_IDLE_TTL_MS: 2_592_000_000,
      MEMORY_INDEX_BUILD_LEASE_MS: 60_000,
      MEMORY_AUDIT_MIN_INTERVAL_MS: 60_000,
      MEMORY_AUDIT_MAX_INTERVAL_MS: 86_400_000,
      MEMORY_AUDIT_BACKOFF_MULTIPLIER: 100,
      MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH: 64,
      MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE: 1_000,
      MEMORY_WATCH_DEBOUNCE_MS: 100,
      MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE: 10_000,
      MAX_MEMORY_AUDIT_MS_PER_SLICE: 50,
      MAX_MEMORY_BUILD_OPEN_DIRECTORIES: 32,
      MEMORY_FTS_TOKENIZER: "unicode61 remove_diacritics 2",
      MEMORY_FTS_TERM_OPERATOR: "OR",
      MEMORY_BM25_TITLE_WEIGHT: 5,
      MEMORY_BM25_DESCRIPTION_WEIGHT: 2,
      MEMORY_RRF_K: 60,
      MEMORY_RRF_PROJECT_WEIGHT: 1.25,
      MEMORY_RRF_GLOBAL_WEIGHT: 1,
      MEMORY_RRF_RECENT_WEIGHT: 0.25,
    });
  });

  it("quotes every already-bounded term as an FTS literal", () => {
    expect(
      buildMemoryFtsMatch([
        'quote"inside',
        "*",
        "NEAR",
        "title:escape",
        "e\u0301",
        "東京",
      ]),
    ).toBe(
      '"quote""inside" OR "*" OR "near" OR "title:escape" OR "é" OR "東京"',
    );
    expect(buildMemoryFtsMatch([])).toBe("");
    expect(() =>
      buildMemoryFtsMatch(
        Array.from({ length: 129 }, (_, index) => String(index)),
      ),
    ).toThrow(/term count/u);
  });

  it("changes the bounded content identity for equal-length substitutions", () => {
    const metadata = {
      title: "Database recovery",
      description: "Known issue",
      type: "project",
    };
    const first = computeMemoryHeaderFingerprint(
      Buffer.from("same-size-body-a", "utf8"),
      metadata,
    );
    const second = computeMemoryHeaderFingerprint(
      Buffer.from("same-size-body-b", "utf8"),
      metadata,
    );
    expect(Buffer.byteLength("same-size-body-a")).toBe(
      Buffer.byteLength("same-size-body-b"),
    );
    expect(first).not.toBe(second);
  });

  it("sums one-based weighted RRF contributions and freezes every tie-breaker", () => {
    const sharedProject = candidate("shared", "/project/shared.md", "project");
    const sharedGlobal = candidate(
      "shared-global",
      "/project/shared.md",
      "global",
    );
    const projectOnly = candidate("project", "/project/only.md", "project");
    const globalOnly = candidate("global", "/global/only.md", "global");
    const fused = fuseMemoryRanks({
      project: [sharedProject, projectOnly],
      global: [globalOnly, sharedGlobal],
      recent: [sharedGlobal],
    });

    expect(fused.map((entry) => entry.memoryId)).toEqual([
      "shared",
      "project",
      "global",
    ]);
    expect(fused[0]?.fusedScore).toBeCloseTo(
      1.25 / 61 + 1 / 62 + 0.25 / 61,
      12,
    );
    expect(fused[0]).toMatchObject({
      projectPresent: true,
      bestRank: 1,
      rootRole: "project",
    });
  });
});

function candidate(
  memoryId: string,
  canonicalPath: string,
  rootRole: "global" | "project",
): MemoryRankCandidate {
  return {
    memoryId,
    canonicalPath,
    title: memoryId,
    description: "",
    type: null,
    mtimeMs: 1,
    size: 1,
    fingerprint: memoryId.padEnd(64, "0"),
    rootId: `${rootRole}-root`,
    rootRole,
  };
}
