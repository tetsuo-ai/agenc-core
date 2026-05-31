import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearSessionReadCache,
  getSessionReadSnapshot,
  hasSessionRead,
  recordSessionRead,
} from "./filesystem.js";

/**
 * Regression coverage for the cross-agent read-before-write bug.
 *
 * Two dispatch paths inject DIFFERENT `__agencSessionId` values for the
 * same logical conversation (canonical surface = main-process session id;
 * spawned subagents = agent/conversation id). A FULL `FileRead` recorded
 * under one id must satisfy the `Edit`/`Write` read-before-write gate when
 * that gate is later evaluated under the OTHER id, for the SAME canonical
 * path within the SAME workspace root. A path nobody read must still fail.
 */
describe("cross-agent session-read workspace fallback", () => {
  const SESSION_A = "agent-A-session-id";
  const SESSION_B = "agent-B-conversation-id";

  let workspaceRoot: string;
  let previousWorkspace: string | undefined;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-xagent-"));
    previousWorkspace = process.env.AGENC_WORKSPACE;
    process.env.AGENC_WORKSPACE = workspaceRoot;
    // Drop any in-memory state from prior tests so the fallback is the
    // only thing that can satisfy a lookup under SESSION_B.
    clearSessionReadCache(SESSION_A);
    clearSessionReadCache(SESSION_B);
  });

  afterEach(() => {
    clearSessionReadCache(SESSION_A);
    clearSessionReadCache(SESSION_B);
    if (previousWorkspace === undefined) {
      delete process.env.AGENC_WORKSPACE;
    } else {
      process.env.AGENC_WORKSPACE = previousWorkspace;
    }
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("a FULL read under session A satisfies the gate when queried under session B", () => {
    const canonicalPath = join(workspaceRoot, "src", "main.ts");

    // Agent A (e.g. the canonical tool surface) performs a full read.
    recordSessionRead(SESSION_A, canonicalPath, {
      content: "export const x = 1;\n",
      timestamp: Date.now(),
      viewKind: "full",
    });

    // Agent B (a spawned subagent, different __agencSessionId) never read
    // it directly, yet the read-before-write gate must accept it because a
    // full read exists for the same canonical path in the same workspace.
    expect(hasSessionRead(SESSION_B, canonicalPath)).toBe(true);

    const snapshot = getSessionReadSnapshot(SESSION_B, canonicalPath);
    expect(snapshot).toBeDefined();
    expect(snapshot?.viewKind).toBe("full");
    expect(snapshot?.isPartialView).not.toBe(true);
  });

  it("fails for a path that was never read by anyone", () => {
    const unreadPath = join(workspaceRoot, "src", "never-read.ts");

    expect(hasSessionRead(SESSION_B, unreadPath)).toBe(false);
    expect(getSessionReadSnapshot(SESSION_B, unreadPath)).toBeUndefined();
  });

  it("does NOT let a PARTIAL read by another agent authorize the gate", () => {
    const canonicalPath = join(workspaceRoot, "src", "partial.ts");

    // Agent A only did a partial (offset/limit) read.
    recordSessionRead(SESSION_A, canonicalPath, {
      content: "line 1\nline 2\n",
      timestamp: Date.now(),
      viewKind: "partial",
      readOffset: 0,
      readLimit: 2,
    });

    // Cross-agent fallback must not be satisfied by a partial read.
    expect(hasSessionRead(SESSION_B, canonicalPath)).toBe(false);
    expect(getSessionReadSnapshot(SESSION_B, canonicalPath)).toBeUndefined();
  });

  it("does NOT leak across workspace roots", () => {
    const canonicalPath = join(workspaceRoot, "src", "scoped.ts");

    recordSessionRead(SESSION_A, canonicalPath, {
      content: "export const y = 2;\n",
      timestamp: Date.now(),
      viewKind: "full",
    });

    // Same canonical path, but a DIFFERENT active workspace root: the
    // fallback is keyed by workspace, so it must not match.
    const otherWorkspace = mkdtempSync(join(tmpdir(), "agenc-xagent-other-"));
    try {
      process.env.AGENC_WORKSPACE = otherWorkspace;
      expect(hasSessionRead(SESSION_B, canonicalPath)).toBe(false);
    } finally {
      process.env.AGENC_WORKSPACE = workspaceRoot;
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});
