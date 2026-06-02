/**
 * gaphunt3 #7 regression test — EnterWorktree slug validation must
 * reject "." / ".." path segments so a worktree name cannot traverse
 * out of the `.agenc/worktrees` confinement root via resolve().
 *
 * The donor `utils/worktree.ts:validateWorktreeSlug` rejects "." and
 * ".." segments explicitly; the port at src/tools/system/worktree.ts
 * dropped that guard, and because the per-segment regex
 * `^[A-Za-z0-9._-]+$` treats ".." as legal (`.` is allowed), a name
 * like "../../../../tmp/evil" passed validation and resolve() landed the
 * worktree outside the root.
 *
 * These are fast unit tests against the exported validator — no git, no
 * child processes. They fail if the segment guard is reverted.
 */
import { describe, it, expect } from "vitest";

import { validateWorktreeSlug } from "src/tools/system/worktree";

describe("gaphunt3 #7: validateWorktreeSlug rejects traversal segments", () => {
  it('rejects a ".." path segment (the primary escape vector)', () => {
    // The canonical attack from the finding.
    expect(() => validateWorktreeSlug("../../etc/x")).toThrow();
    expect(() => validateWorktreeSlug("../../../../tmp/evil")).toThrow();
  });

  it('rejects a leading "../escape" segment', () => {
    expect(() => validateWorktreeSlug("../escape")).toThrow();
  });

  it('rejects a standalone ".." slug', () => {
    expect(() => validateWorktreeSlug("..")).toThrow();
  });

  it('rejects a "." path segment', () => {
    expect(() => validateWorktreeSlug(".")).toThrow();
    expect(() => validateWorktreeSlug("foo/./bar")).toThrow();
  });

  it('rejects an embedded ".." segment between valid segments', () => {
    expect(() => validateWorktreeSlug("feature/../escape")).toThrow();
  });

  it("still accepts legitimate slugs (no false positives)", () => {
    // Dots are still allowed WITHIN a segment — only "." and ".."
    // whole-segment values are rejected.
    expect(() => validateWorktreeSlug("feature.test")).not.toThrow();
    expect(() => validateWorktreeSlug("user/feature")).not.toThrow();
    expect(() => validateWorktreeSlug("my-branch_2.0")).not.toThrow();
    expect(() => validateWorktreeSlug("a.b.c")).not.toThrow();
  });

  it('rejects an empty segment (trailing/leading "/")', () => {
    expect(() => validateWorktreeSlug("foo/")).toThrow();
    expect(() => validateWorktreeSlug("/foo")).toThrow();
  });
});
