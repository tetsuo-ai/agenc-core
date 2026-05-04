import { describe, expect, test, vi } from "vitest";
import {
  ApprovalStore,
  buildShellApprovalKey,
  canonicalizeCommandForApproval,
  canonicalJsonKey,
  createSessionApprovalCacheFromContext,
  hasSessionApproval,
  mergeSessionApprovalsIntoContext,
  SessionApprovalCache,
  type ShellApprovalKey,
} from "./approval-cache.js";
import type { ReviewDecision } from "./review-decision.js";
import { createEmptyToolPermissionContext } from "./types.js";

describe("canonicalJsonKey — stable serialization", () => {
  test("object key order does not matter", () => {
    const a = canonicalJsonKey({ b: 2, a: 1 });
    const b = canonicalJsonKey({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test("array order is preserved (argv is positional)", () => {
    const a = canonicalJsonKey(["ls", "-la"]);
    const b = canonicalJsonKey(["-la", "ls"]);
    expect(a).not.toBe(b);
  });
});

describe("ApprovalStore<K>", () => {
  const approvedForSession: ReviewDecision = { kind: "approved_for_session" };
  const approved: ReviewDecision = { kind: "approved" };
  const denied: ReviewDecision = { kind: "denied" };

  test("get/set round-trip with JSON-stringified keys", () => {
    const store = new ApprovalStore<{ cmd: string }>();
    store.set({ cmd: "ls" }, approvedForSession);
    expect(store.get({ cmd: "ls" })).toEqual(approvedForSession);
    expect(store.get({ cmd: "pwd" })).toBeUndefined();
  });

  test("setMany writes each key independently (multi-file approval style)", () => {
    const store = new ApprovalStore<string>();
    store.setMany(["a.txt", "b.txt", "c.txt"], approvedForSession);
    for (const k of ["a.txt", "b.txt", "c.txt"]) {
      expect(store.get(k)).toEqual(approvedForSession);
    }
  });

  test("withCachedApproval — empty keys short-circuits to fetchDecision", async () => {
    const store = new ApprovalStore<string>();
    const fetch = vi.fn(async () => approved);
    const res = await store.withCachedApproval({
      keys: [],
      fetchDecision: fetch,
    });
    expect(res).toEqual(approved);
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.size()).toBe(0);
  });

  test("withCachedApproval — all keys approved_for_session skips fetch", async () => {
    const store = new ApprovalStore<string>();
    store.set("a", approvedForSession);
    store.set("b", approvedForSession);
    const fetch = vi.fn(async () => denied);
    const res = await store.withCachedApproval({
      keys: ["a", "b"],
      fetchDecision: fetch,
    });
    expect(res).toEqual(approvedForSession);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("withCachedApproval — partial hit still fetches (every() rule)", async () => {
    const store = new ApprovalStore<string>();
    store.set("a", approvedForSession);
    // "b" is NOT cached — the rule requires ALL keys to be approved.
    const fetch = vi.fn(async () => denied);
    const res = await store.withCachedApproval({
      keys: ["a", "b"],
      fetchDecision: fetch,
    });
    expect(res).toEqual(denied);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("withCachedApproval — fresh approved_for_session persists under every key", async () => {
    const store = new ApprovalStore<string>();
    const fetch = vi.fn(async () => approvedForSession);
    const res = await store.withCachedApproval({
      keys: ["x", "y", "z"],
      fetchDecision: fetch,
    });
    expect(res).toEqual(approvedForSession);
    expect(store.get("x")).toEqual(approvedForSession);
    expect(store.get("y")).toEqual(approvedForSession);
    expect(store.get("z")).toEqual(approvedForSession);
  });

  test("withCachedApproval — non-session approvals do NOT populate cache", async () => {
    const store = new ApprovalStore<string>();
    const fetch = vi.fn(async () => approved);
    await store.withCachedApproval({
      keys: ["one"],
      fetchDecision: fetch,
    });
    expect(store.get("one")).toBeUndefined();
  });

  test("clear() wipes session-cached approvals", () => {
    const store = new ApprovalStore<string>();
    store.set("a", approvedForSession);
    store.set("b", approvedForSession);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.get("a")).toBeUndefined();
  });
});

describe("SessionApprovalCache", () => {
  test("records whole-tool approvals as session allow-rule updates", () => {
    const cache = new SessionApprovalCache();

    const update = cache.approveTool("Read");

    expect(update).toEqual({
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "Read" }],
    });
    expect(cache.hasTool("Read")).toBe(true);
    expect(cache.snapshot().ruleStrings).toEqual(["Read"]);
  });

  test("records content-qualified patterns and dedupes equivalent strings", () => {
    const cache = new SessionApprovalCache();

    const first = cache.approvePattern("Bash", "git status");
    const duplicate = cache.approveRule("Bash(git status)");

    expect(first?.rules).toEqual([
      { toolName: "Bash", ruleContent: "git status" },
    ]);
    expect(duplicate).toBeNull();
    expect(cache.hasPattern("Bash", "git status")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  test("hydrates from context session rules", () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Read", "Bash(git status)"] },
    });

    const cache = createSessionApprovalCacheFromContext(ctx);

    expect(cache.hasTool("Read")).toBe(true);
    expect(cache.hasPattern("Bash", "git status")).toBe(true);
    expect(cache.snapshot().ruleStrings).toEqual([
      "Bash(git status)",
      "Read",
    ]);
  });

  test("normalizes equivalent whole-tool encodings from context", () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Bash()", "Read(*)"] },
    });

    const cache = createSessionApprovalCacheFromContext(ctx);

    expect(cache.snapshot().ruleStrings).toEqual(["Bash", "Read"]);
    expect(hasSessionApproval(ctx, "Bash")).toBe(true);
    expect(hasSessionApproval(ctx, { toolName: "Read" })).toBe(true);
  });

  test("normalizes escaped pattern content from context", () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Bash(echo \\(hi\\))"] },
    });

    const cache = createSessionApprovalCacheFromContext(ctx);

    expect(cache.hasPattern("Bash", "echo (hi)")).toBe(true);
    expect(
      hasSessionApproval(ctx, {
        toolName: "Bash",
        ruleContent: "echo (hi)",
      }),
    ).toBe(true);
  });

  test("keeps malformed rule strings stable instead of over-normalizing", () => {
    const malformed = "Bash(git status";
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: [malformed] },
    });

    const cache = createSessionApprovalCacheFromContext(ctx);

    expect(cache.hasRule(malformed)).toBe(true);
    expect(hasSessionApproval(ctx, malformed)).toBe(true);
    expect(
      hasSessionApproval(ctx, {
        toolName: "Bash",
        ruleContent: "git status",
      }),
    ).toBe(false);
  });

  test("merges cache entries into alwaysAllowRules.session without duplicates", () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Read"] },
    });
    const cache = new SessionApprovalCache([
      "Read",
      { toolName: "Bash", ruleContent: "git status" },
    ]);

    const next = cache.mergeIntoContext(ctx);

    expect(next.alwaysAllowRules.session).toEqual([
      "Bash(git status)",
      "Read",
    ]);
    expect(hasSessionApproval(next, "Read")).toBe(true);
    expect(
      hasSessionApproval(next, {
        toolName: "Bash",
        ruleContent: "git status",
      }),
    ).toBe(true);
  });

  test("standalone merge helper preserves unrelated session rules", () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Write"] },
    });

    const next = mergeSessionApprovalsIntoContext(ctx, ["Read"]);

    expect(next.alwaysAllowRules.session).toEqual(["Read", "Write"]);
  });
});

describe("canonicalizeCommandForApproval", () => {
  test("collapses bash -lc 'cmd' and bash -c 'cmd' on simple commands", () => {
    const a = canonicalizeCommandForApproval([
      "/bin/bash",
      "-lc",
      "cargo test -p core",
    ]);
    const b = canonicalizeCommandForApproval([
      "bash",
      "-lc",
      "cargo   test   -p core",
    ]);
    expect(a).toEqual(["cargo", "test", "-p", "core"]);
    expect(b).toEqual(a);
  });

  test("-c and -lc collapse when script is simple", () => {
    const lc = canonicalizeCommandForApproval(["bash", "-lc", "ls -la"]);
    const c = canonicalizeCommandForApproval(["bash", "-c", "ls -la"]);
    expect(lc).toEqual(["ls", "-la"]);
    expect(c).toEqual(["ls", "-la"]);
  });

  test("trims surrounding whitespace around script text", () => {
    const a = canonicalizeCommandForApproval(["bash", "-lc", "   ls -la   "]);
    expect(a).toEqual(["ls", "-la"]);
  });

  test("complex scripts fall back to canonical script key", () => {
    const script = "echo hi | grep hi";
    const out = canonicalizeCommandForApproval(["bash", "-lc", script]);
    expect(out[0]).toBe("__agenc_shell_script__");
    expect(out[1]).toBe("-lc");
    expect(out[2]).toBe(script);
  });

  test("non-shell argv is returned unchanged", () => {
    const cmd = ["cargo", "fmt"];
    expect(canonicalizeCommandForApproval(cmd)).toEqual(cmd);
  });

  test("case is preserved (Unix matters)", () => {
    const cmd = canonicalizeCommandForApproval(["bash", "-lc", "Foo"]);
    expect(cmd).toEqual(["Foo"]);
  });
});

describe("buildShellApprovalKey", () => {
  test("produces stable keys across equivalent command wrappers", () => {
    const a = buildShellApprovalKey({
      command: ["/bin/bash", "-lc", "cargo test"],
      cwd: "/repo",
    });
    const b = buildShellApprovalKey({
      command: ["bash", "-c", "cargo test"],
      cwd: "/repo",
    });
    expect(canonicalJsonKey(a)).toBe(canonicalJsonKey(b));
  });

  test("sorts sandbox/additional permissions so ordering does not matter", () => {
    const a = buildShellApprovalKey({
      command: ["bash", "-lc", "ls"],
      cwd: "/repo",
      sandbox_permissions: ["net", "fs"],
      additional_permissions: ["foo", "bar"],
    });
    const b = buildShellApprovalKey({
      command: ["bash", "-lc", "ls"],
      cwd: "/repo",
      sandbox_permissions: ["fs", "net"],
      additional_permissions: ["bar", "foo"],
    });
    expect(canonicalJsonKey(a)).toBe(canonicalJsonKey(b));
  });

  test("different cwd ⇒ different key (cache isolation)", () => {
    const a = buildShellApprovalKey({
      command: ["bash", "-lc", "ls"],
      cwd: "/repo/a",
    });
    const b = buildShellApprovalKey({
      command: ["bash", "-lc", "ls"],
      cwd: "/repo/b",
    });
    expect(canonicalJsonKey(a)).not.toBe(canonicalJsonKey(b));
  });

  test("ApprovalStore using ShellApprovalKey caches across wrapper variants", () => {
    const store = new ApprovalStore<ShellApprovalKey>();
    const k1 = buildShellApprovalKey({
      command: ["/bin/bash", "-lc", "cargo check"],
      cwd: "/w",
    });
    store.set(k1, { kind: "approved_for_session" });

    // Different shell wrapper invocation with same underlying command.
    const k2 = buildShellApprovalKey({
      command: ["bash", "-c", "cargo check"],
      cwd: "/w",
    });
    expect(store.get(k2)).toEqual({ kind: "approved_for_session" });
  });
});
