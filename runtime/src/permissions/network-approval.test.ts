/**
 * Tests for T11 Wave 1 Agent D — network approval decision layer.
 *
 * Ports the codex runtime `network_approval_tests.rs` behavioural surface:
 *   - Short-circuit guards (sandbox, approval policy, signal).
 *   - Session allow/deny cache semantics (incl. cross-toggle eviction).
 *   - Host-key canonicalization (case + port + protocol).
 *   - Concurrent dedup via the pending map.
 *   - Resolver return mapping for every `ReviewDecision` variant.
 *   - Amendment persistence callback contract.
 *   - Hook precedence (allow short-circuits, deny short-circuits).
 *   - `clearSessionHosts` lifecycle.
 */

import { describe, expect, test } from "vitest";
import {
  DeniedByPolicy,
  hostApprovalKeyToString,
  NetworkApprovalService,
  normalizeHost,
  PendingHostApproval,
  type HostApprovalKey,
  type NetworkApprovalHook,
  type NetworkApprovalResolver,
  type NetworkPolicyAmendment,
  type RequestNetworkApprovalOptions,
  type ReviewDecision,
  type SandboxPolicy,
} from "./network-approval.js";

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

const WORKSPACE_WRITE: SandboxPolicy = { kind: "workspace_write" };
const READ_ONLY: SandboxPolicy = { kind: "read_only" };
const DANGER_FULL: SandboxPolicy = { kind: "danger_full_access" };
const EXTERNAL: SandboxPolicy = { kind: "external_sandbox" };

function key(
  overrides?: Partial<HostApprovalKey>,
): HostApprovalKey {
  return {
    host: "example.com",
    protocol: "https",
    port: 443,
    ...overrides,
  };
}

function baseOpts(
  overrides?: Partial<RequestNetworkApprovalOptions>,
): RequestNetworkApprovalOptions {
  return {
    key: key(),
    sandboxPolicy: WORKSPACE_WRITE,
    approvalPolicy: "on_request",
    ...overrides,
  };
}

function staticResolver(decision: ReviewDecision): NetworkApprovalResolver {
  return {
    requestNetworkApproval: async () => decision,
  };
}

function countingResolver(
  decision: ReviewDecision,
): { resolver: NetworkApprovalResolver; callCount(): number } {
  let calls = 0;
  const resolver: NetworkApprovalResolver = {
    requestNetworkApproval: async () => {
      calls += 1;
      return decision;
    },
  };
  return { resolver, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────
// Helper type-level tests
// ─────────────────────────────────────────────────────────────────────

describe("normalizeHost", () => {
  test("lowercases, trims, and strips trailing dot", () => {
    expect(normalizeHost("  Example.COM.  ")).toBe("example.com");
    expect(normalizeHost("HOST")).toBe("host");
  });
});

describe("hostApprovalKeyToString", () => {
  test("produces canonical string insensitive to host case / trailing dot", () => {
    const a = hostApprovalKeyToString({
      host: "HTTPS.Example.COM.",
      protocol: "https",
      port: 443,
    });
    const b = hostApprovalKeyToString({
      host: "https.example.com",
      protocol: "https",
      port: 443,
    });
    expect(a).toBe(b);
    expect(a).toBe("https://https.example.com:443");
  });

  test("different protocols or ports produce different keys", () => {
    const base = { host: "x.test", port: 443 } as const;
    const https = hostApprovalKeyToString({ ...base, protocol: "https" });
    const http = hostApprovalKeyToString({ ...base, protocol: "http" });
    const other = hostApprovalKeyToString({
      host: "x.test",
      protocol: "https",
      port: 8443,
    });
    expect(https).not.toBe(http);
    expect(https).not.toBe(other);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PendingHostApproval primitive
// ─────────────────────────────────────────────────────────────────────

describe("PendingHostApproval", () => {
  test("release multiple waiters with the same decision", async () => {
    const pending = new PendingHostApproval();
    const a = pending.wait();
    const b = pending.wait();
    pending.set("allow_once");
    expect(await a).toBe("allow_once");
    expect(await b).toBe("allow_once");
  });

  test("second set() is ignored", async () => {
    const pending = new PendingHostApproval();
    pending.set("allow_once");
    pending.set("deny");
    expect(await pending.wait()).toBe("allow_once");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Short-circuit guards
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — short-circuit guards", () => {
  test("danger_full_access sandbox short-circuits to deny", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        sandboxPolicy: DANGER_FULL,
        resolver: staticResolver({ kind: "approved" }),
      }),
    );
    expect(decision).toEqual({
      kind: "deny",
      reason: "not_allowed_in_sandbox_mode",
    });
  });

  test("external_sandbox short-circuits to deny", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        sandboxPolicy: EXTERNAL,
        resolver: staticResolver({ kind: "approved" }),
      }),
    );
    expect(decision).toEqual({
      kind: "deny",
      reason: "not_allowed_in_sandbox_mode",
    });
  });

  test("approval policy `never` short-circuits to deny", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({ kind: "approved" });
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        approvalPolicy: "never",
        resolver,
      }),
    );
    expect(decision).toEqual({
      kind: "deny",
      reason: "approval_policy_never",
    });
    expect(callCount()).toBe(0);
  });

  test("resolver absent + no hook returns default-deny", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(baseOpts());
    expect(decision.kind).toBe("deny");
    // Default-deny is NOT a session-deny: next call still consults caches.
    expect(svc.sessionDeniedSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Resolver decision mapping
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — resolver decision mapping", () => {
  test("approved → allow, NOT persisted in session", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({ kind: "approved" });
    const first = await svc.requestNetworkApproval(
      baseOpts({ resolver }),
    );
    expect(first).toEqual({ kind: "allow" });
    expect(svc.sessionAllowedSize).toBe(0);

    // Second call MUST hit the resolver again because allow-once is not cached.
    const second = await svc.requestNetworkApproval(
      baseOpts({ resolver }),
    );
    expect(second).toEqual({ kind: "allow" });
    expect(callCount()).toBe(2);
  });

  test("approved_for_session → allow + persisted; subsequent calls skip resolver", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({
      kind: "approved_for_session",
    });
    const first = await svc.requestNetworkApproval(
      baseOpts({ resolver }),
    );
    expect(first).toEqual({ kind: "allow" });
    expect(svc.sessionAllowedSize).toBe(1);

    const second = await svc.requestNetworkApproval(
      baseOpts({ resolver }),
    );
    expect(second).toEqual({ kind: "allow" });
    // Resolver was called once; session-allow short-circuited the second.
    expect(callCount()).toBe(1);
  });

  test("denied → deny; NOT persisted as session-deny (can allow next time)", async () => {
    const svc = new NetworkApprovalService();
    const first = await svc.requestNetworkApproval(
      baseOpts({ resolver: staticResolver({ kind: "denied" }) }),
    );
    expect(first.kind).toBe("deny");
    expect(svc.sessionDeniedSize).toBe(0);

    // Next call with an approve resolver should now succeed.
    const second = await svc.requestNetworkApproval(
      baseOpts({ resolver: staticResolver({ kind: "approved" }) }),
    );
    expect(second).toEqual({ kind: "allow" });
  });

  test("abort → deny (not persisted)", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({ resolver: staticResolver({ kind: "abort" }) }),
    );
    expect(decision.kind).toBe("deny");
    expect(svc.sessionDeniedSize).toBe(0);
  });

  test("timed_out → deny (not persisted)", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({ resolver: staticResolver({ kind: "timed_out" }) }),
    );
    expect(decision.kind).toBe("deny");
    expect(svc.sessionDeniedSize).toBe(0);
  });

  test("approved_execpolicy_amendment → allow (allow-once semantics)", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "approved_execpolicy_amendment",
        }),
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(svc.sessionAllowedSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Amendment persistence
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — amendment persistence", () => {
  test("amendment allow → persist + cache session-allow", async () => {
    const svc = new NetworkApprovalService();
    const persisted: Array<NetworkPolicyAmendment> = [];
    const amendment: NetworkPolicyAmendment = { action: "allow" };
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment,
        }),
        persistAmendment: async (a) => {
          persisted.push(a);
        },
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(amendment);
    expect(svc.sessionAllowedSize).toBe(1);
    expect(svc.sessionDeniedSize).toBe(0);
  });

  test("amendment deny → persist + cache session-deny", async () => {
    const svc = new NetworkApprovalService();
    const persisted: Array<NetworkPolicyAmendment> = [];
    const amendment: NetworkPolicyAmendment = { action: "deny" };
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment,
        }),
        persistAmendment: async (a) => {
          persisted.push(a);
        },
      }),
    );
    expect(decision.kind).toBe("deny");
    expect(persisted).toHaveLength(1);
    expect(svc.sessionDeniedSize).toBe(1);
    expect(svc.sessionAllowedSize).toBe(0);
  });

  test("amendment persist error is surfaced via callback but does not block the decision", async () => {
    const svc = new NetworkApprovalService();
    const errors: unknown[] = [];
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment: { action: "allow" },
        }),
        persistAmendment: async () => {
          throw new Error("disk full");
        },
        onAmendmentPersistError: (err) => errors.push(err),
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("disk full");
    // Session-allow still applied.
    expect(svc.sessionAllowedSize).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Host key canonicalization in the cache
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — canonicalization", () => {
  test("host case and trailing dot collapse to the same cache entry", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({
      kind: "approved_for_session",
    });

    const first = await svc.requestNetworkApproval(
      baseOpts({
        key: { host: "Example.COM", protocol: "https", port: 443 },
        resolver,
      }),
    );
    expect(first).toEqual({ kind: "allow" });

    const second = await svc.requestNetworkApproval(
      baseOpts({
        key: { host: "EXAMPLE.com.", protocol: "https", port: 443 },
        resolver,
      }),
    );
    expect(second).toEqual({ kind: "allow" });
    // Both calls mapped to the same session-allow entry.
    expect(callCount()).toBe(1);
    expect(svc.sessionAllowedSize).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Concurrent-request dedup
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — concurrent dedup", () => {
  test("two concurrent callers for the same host → resolver runs once", async () => {
    const svc = new NetworkApprovalService();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const resolver: NetworkApprovalResolver = {
      requestNetworkApproval: async () => {
        calls += 1;
        await gate;
        return { kind: "approved_for_session" };
      },
    };

    const a = svc.requestNetworkApproval(baseOpts({ resolver }));
    const b = svc.requestNetworkApproval(baseOpts({ resolver }));
    // Give the event loop a tick so both callers enter the pending map
    // in the expected interleaved order.
    await Promise.resolve();
    release();

    const [decisionA, decisionB] = await Promise.all([a, b]);
    expect(decisionA).toEqual({ kind: "allow" });
    expect(decisionB).toEqual({ kind: "allow" });
    expect(calls).toBe(1);
    expect(svc.pendingSize()).toBe(0);
  });

  test("concurrent callers for DIFFERENT hosts → resolver runs per host", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({ kind: "approved" });

    const a = svc.requestNetworkApproval(
      baseOpts({ key: key({ host: "a.test" }), resolver }),
    );
    const b = svc.requestNetworkApproval(
      baseOpts({ key: key({ host: "b.test" }), resolver }),
    );

    await Promise.all([a, b]);
    expect(callCount()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cross-cache toggling + reset
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — cache toggling", () => {
  test("session-allow evicts session-deny when toggling via amendments", async () => {
    const svc = new NetworkApprovalService();
    // 1) Amendment-deny sets session-deny.
    await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment: { action: "deny" },
        }),
      }),
    );
    expect(svc.sessionDeniedSize).toBe(1);
    expect(svc.sessionAllowedSize).toBe(0);

    // 2) Directly clear the deny (simulate operator override) so the next
    //    call actually reaches the resolver. This mirrors codex runtime's
    //    `clear_session_denied_hosts` helper path.
    svc.clearSessionHosts();

    // 3) Amendment-allow sets session-allow and (re-)clears any deny.
    await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment: { action: "allow" },
        }),
      }),
    );
    expect(svc.sessionAllowedSize).toBe(1);
    expect(svc.sessionDeniedSize).toBe(0);
  });

  test("clearSessionHosts resets both caches", async () => {
    const svc = new NetworkApprovalService();
    await svc.requestNetworkApproval(
      baseOpts({
        resolver: staticResolver({ kind: "approved_for_session" }),
      }),
    );
    await svc.requestNetworkApproval(
      baseOpts({
        key: key({ host: "deny.test" }),
        resolver: staticResolver({
          kind: "network_policy_amendment",
          amendment: { action: "deny" },
        }),
      }),
    );
    expect(svc.sessionAllowedSize).toBe(1);
    expect(svc.sessionDeniedSize).toBe(1);

    svc.clearSessionHosts();
    expect(svc.sessionAllowedSize).toBe(0);
    expect(svc.sessionDeniedSize).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hook precedence
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — hooks", () => {
  test("hook returning allow short-circuits before resolver runs", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({ kind: "denied" });
    const hook: NetworkApprovalHook = async () => ({ allow: true });

    const decision = await svc.requestNetworkApproval(
      baseOpts({ resolver, hooks: [hook] }),
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(callCount()).toBe(0);
    // Allow-once semantics: not persisted.
    expect(svc.sessionAllowedSize).toBe(0);
  });

  test("hook returning deny → DeniedByPolicy error", async () => {
    const svc = new NetworkApprovalService();
    const hook: NetworkApprovalHook = async () => ({
      deny: "domain blocked by policy hook",
    });

    await expect(
      svc.requestNetworkApproval(
        baseOpts({
          resolver: staticResolver({ kind: "approved" }),
          hooks: [hook],
        }),
      ),
    ).rejects.toBeInstanceOf(DeniedByPolicy);
  });

  test("hook returning null falls through to the resolver", async () => {
    const svc = new NetworkApprovalService();
    const { resolver, callCount } = countingResolver({ kind: "approved" });
    const noop: NetworkApprovalHook = async () => null;

    const decision = await svc.requestNetworkApproval(
      baseOpts({ resolver, hooks: [noop] }),
    );
    expect(decision).toEqual({ kind: "allow" });
    expect(callCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Read-only sandbox is fine (only full/external are blocked)
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — read_only sandbox", () => {
  test("read_only sandbox permits the approval flow", async () => {
    const svc = new NetworkApprovalService();
    const decision = await svc.requestNetworkApproval(
      baseOpts({
        sandboxPolicy: READ_ONLY,
        resolver: staticResolver({ kind: "approved" }),
      }),
    );
    expect(decision).toEqual({ kind: "allow" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Abort signal
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — abort signal", () => {
  test("already-aborted signal throws before any work", async () => {
    const svc = new NetworkApprovalService();
    const ac = new AbortController();
    ac.abort();
    await expect(
      svc.requestNetworkApproval(
        baseOpts({
          resolver: staticResolver({ kind: "approved" }),
          signal: ac.signal,
        }),
      ),
    ).rejects.toThrow();
  });

  test("aborting a waiter while the owner resolves rejects the waiter", async () => {
    const svc = new NetworkApprovalService();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolver: NetworkApprovalResolver = {
      requestNetworkApproval: async () => {
        await gate;
        return { kind: "approved_for_session" };
      },
    };

    const ac = new AbortController();
    const owner = svc.requestNetworkApproval(baseOpts({ resolver }));
    await Promise.resolve();
    const waiter = svc.requestNetworkApproval(
      baseOpts({ resolver, signal: ac.signal }),
    );
    await Promise.resolve();
    ac.abort();

    await expect(waiter).rejects.toThrow();
    release();
    await expect(owner).resolves.toEqual({ kind: "allow" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Deferred-mode registrations
// ─────────────────────────────────────────────────────────────────────

describe("NetworkApprovalService — deferred registrations", () => {
  test("requestDeferredApproval returns a deferred handle for allowed requests", async () => {
    const svc = new NetworkApprovalService();
    const result = await svc.requestDeferredApproval(
      baseOpts({ resolver: staticResolver({ kind: "approved" }) }),
    );
    expect(result.kind).toBe("allow");
    expect(result.deferredApproval).toBeDefined();
    expect(svc.activeApprovalSize()).toBe(1);
    await result.deferredApproval!.finish();
    expect(svc.activeApprovalSize()).toBe(0);
  });

  test("denied deferred requests do not leave active registrations", async () => {
    const svc = new NetworkApprovalService();
    const result = await svc.requestDeferredApproval(
      baseOpts({ resolver: staticResolver({ kind: "denied" }) }),
    );
    expect(result.kind).toBe("deny");
    expect(result.deferredApproval).toBeUndefined();
    expect(svc.activeApprovalSize()).toBe(0);
  });

  test("manual active registrations can be converted to deferred and finished", async () => {
    const svc = new NetworkApprovalService();
    const active = svc.beginNetworkApproval(baseOpts({ mode: "immediate" }));
    expect(svc.activeApprovalSize()).toBe(1);
    const deferred = active.intoDeferred();
    expect(deferred.id).toBe(active.id);
    await deferred.finish();
    expect(svc.activeApprovalSize()).toBe(0);
  });
});
