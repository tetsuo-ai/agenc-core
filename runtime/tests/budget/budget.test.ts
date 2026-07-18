// Budget enforcement (TODO task 15). The research-grounded invariants
// (docs/design/budget-enforcement.md) are the point: external metering,
// worst-case debit + reconcile, fail-closed on both windows, pause+notify,
// one-shot soft warning, never a silent downgrade.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveBudgetPolicy } from "../../src/budget/config.js";
import { BudgetLedger, windowKeys } from "../../src/budget/ledger.js";
import { BudgetEnforcer } from "../../src/budget/enforcer.js";
import type {
  AdmitRequest,
  BudgetNotification,
  BudgetPolicy,
  ModelPrice,
} from "../../src/budget/types.js";

// A model priced at $1/M input, $3/M output — clean numbers for the math.
const PRICE: ModelPrice = { inputPerMTokens: 1, outputPerMTokens: 3 };
const priceOf = (model: string): ModelPrice | null =>
  model === "unpriced" ? null : PRICE;

describe("resolveBudgetPolicy", () => {
  test("disabled by default, no caps", () => {
    const { policy } = resolveBudgetPolicy(undefined, {});
    expect(policy.enabled).toBe(false);
    expect(policy.caps).toEqual({});
    expect(policy.softThreshold).toBe(0.8);
    expect(policy.enforceInteractive).toBe(false);
  });

  test("config sets caps; env overrides (env > config > default)", () => {
    const { policy, sources } = resolveBudgetPolicy(
      { enabled: true, daily_usd: 5, monthly_usd: 100 },
      { AGENC_BUDGET_DAILY_USD: "2" },
    );
    expect(policy.enabled).toBe(true);
    expect(policy.caps.dailyUsd).toBe(2); // env wins
    expect(policy.caps.monthlyUsd).toBe(100); // config
    expect(sources.dailyUsd).toBe("env");
    expect(sources.monthlyUsd).toBe("config");
  });

  test("AGENC_BUDGET env kill switch disables even when config enables", () => {
    const { policy } = resolveBudgetPolicy(
      { enabled: true, daily_usd: 5 },
      { AGENC_BUDGET: "off" },
    );
    expect(policy.enabled).toBe(false);
  });

  test("soft threshold + enforce_interactive parse", () => {
    const { policy } = resolveBudgetPolicy({
      enabled: true,
      soft_threshold: 0.5,
      enforce_interactive: true,
    });
    expect(policy.softThreshold).toBe(0.5);
    expect(policy.enforceInteractive).toBe(true);
  });
});

describe("BudgetLedger", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-budget-ledger-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("addSpend accumulates into both windows; persists 0600", () => {
    const ledger = new BudgetLedger({
      agencHome: home,
      now: () => new Date("2026-07-09T10:00:00Z"),
    });
    ledger.addSpend("a1", 1.5, 1000);
    ledger.addSpend("a1", 0.5, 200);
    const s = ledger.snapshot("a1");
    expect(s.day.usd).toBeCloseTo(2.0);
    expect(s.day.tokens).toBe(1200);
    expect(s.month.usd).toBeCloseTo(2.0);
    const mode = statSync(join(home, "budget", "ledger.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a new day rolls the day window but keeps the month", () => {
    let now = new Date("2026-07-09T10:00:00Z");
    const ledger = new BudgetLedger({ agencHome: home, now: () => now });
    ledger.addSpend("a1", 3, 1000);
    now = new Date("2026-07-10T10:00:00Z"); // next day, same month
    const s = ledger.snapshot("a1");
    expect(s.day.usd).toBe(0); // day rolled
    expect(s.month.usd).toBeCloseTo(3); // month persists
    expect(s.day.key).toBe("2026-07-10");
    expect(s.month.key).toBe("2026-07");
  });

  test("a new month rolls both windows", () => {
    let now = new Date("2026-07-31T10:00:00Z");
    const ledger = new BudgetLedger({ agencHome: home, now: () => now });
    ledger.addSpend("a1", 3, 1000);
    now = new Date("2026-08-01T10:00:00Z");
    const s = ledger.snapshot("a1");
    expect(s.day.usd).toBe(0);
    expect(s.month.usd).toBe(0);
  });

  test("persists across reconstruction; reset clears", () => {
    const now = () => new Date("2026-07-09T10:00:00Z");
    const l1 = new BudgetLedger({ agencHome: home, now });
    l1.addSpend("a1", 4, 500);
    l1.setPaused("a1", true);
    const l2 = new BudgetLedger({ agencHome: home, now });
    expect(l2.snapshot("a1").day.usd).toBeCloseTo(4);
    expect(l2.snapshot("a1").paused).toBe(true);
    l2.reset("a1");
    expect(l2.snapshot("a1").day.usd).toBe(0);
    expect(l2.snapshot("a1").paused).toBe(false);
  });

  test("windowKeys formats day and month", () => {
    const { dayKey, monthKey } = windowKeys(new Date("2026-01-05T00:00:00Z"));
    expect(dayKey).toBe("2026-01-05");
    expect(monthKey).toBe("2026-01");
  });

  test("corrupt ledger fails toward zero spend (never fabricates)", () => {
    const now = () => new Date("2026-07-09T10:00:00Z");
    const l1 = new BudgetLedger({ agencHome: home, now });
    l1.addSpend("a1", 4, 500);
    require("node:fs").writeFileSync(join(home, "budget", "ledger.json"), "{bad");
    const l2 = new BudgetLedger({ agencHome: home, now });
    expect(l2.snapshot("a1").day.usd).toBe(0);
  });

  test("pre-reservation ledger files (no holds field) load cleanly", () => {
    const now = () => new Date("2026-07-09T10:00:00Z");
    const l1 = new BudgetLedger({ agencHome: home, now });
    l1.addSpend("a1", 4, 500);
    const path = join(home, "budget", "ledger.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete raw.holds;
    require("node:fs").writeFileSync(path, JSON.stringify(raw));
    const l2 = new BudgetLedger({ agencHome: home, now });
    expect(l2.snapshot("a1").day.usd).toBeCloseTo(4);
    expect(l2.listOpenHolds()).toEqual([]);
  });
});

describe("BudgetEnforcer", () => {
  let home: string;
  let notes: BudgetNotification[];
  const now = () => new Date("2026-07-09T10:00:00Z");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-budget-enf-"));
    notes = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  let sharedLedger: BudgetLedger;

  function make(policy: Partial<BudgetPolicy>): BudgetEnforcer {
    // One ledger instance shared with the test so reads see the enforcer's
    // writes (each BudgetLedger holds its own in-memory copy).
    sharedLedger = new BudgetLedger({ agencHome: home, now });
    return new BudgetEnforcer({
      policy: {
        enabled: true,
        softThreshold: 0.8,
        enforceInteractive: false,
        caps: {},
        ...policy,
      },
      ledger: sharedLedger,
      priceOf,
      notify: (e) => notes.push(e),
    });
  }

  const autoReq = (over: Partial<AdmitRequest> = {}): AdmitRequest => ({
    agentId: "a1",
    model: "m",
    autonomous: true,
    estInputTokens: 1000,
    maxOutputTokens: 1000,
    ...over,
  });

  test("disabled: admits everything with a zero hold; reconcile is a no-op", () => {
    const enf = make({ enabled: false, caps: { dailyUsd: 0.0001 } });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hold.estimatedUsd).toBe(0);
      enf.reconcile(r.hold, { inputTokens: 999999, outputTokens: 999999 });
    }
  });

  test("interactive turn is out of scope unless enforceInteractive", () => {
    const enf = make({ caps: { dailyUsd: 0.0001 } });
    const r = enf.admit(autoReq({ autonomous: false }));
    expect(r.ok).toBe(true); // interactive not gated
    if (r.ok) expect(r.hold.estimatedUsd).toBe(0);
  });

  test("reconcile is exactly-once: a duplicate call cannot re-apply the delta", () => {
    const enf = make({ caps: { dailyTokens: 1_000_000 } });
    // Token-only path: unpriced model still holds est tokens.
    const r = enf.admit(
      autoReq({ model: "unpriced", estInputTokens: 100, maxOutputTokens: 100 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sharedLedger.snapshot("a1").day.tokens).toBe(200);
    const first = enf.reconcile(r.hold, { inputTokens: 0, outputTokens: 0 });
    expect(first).toEqual({ applied: true, reason: "reconciled" });
    expect(sharedLedger.snapshot("a1").day.tokens).toBe(0);
    // The holdId is the durable idempotency key: the second call finds no
    // open hold and MUST leave the ledger untouched (was: −200 footgun).
    const second = enf.reconcile(r.hold, { inputTokens: 0, outputTokens: 0 });
    expect(second).toEqual({ applied: false, reason: "duplicate" });
    expect(sharedLedger.snapshot("a1").day.tokens).toBe(0);
  });

  test("admit persists a durable open hold; reconcile consumes it across instances", () => {
    const enf = make({ caps: { dailyUsd: 100 } });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A FRESH ledger instance (new process semantics) sees the open hold.
    const fresh = new BudgetLedger({ agencHome: home, now });
    const open = fresh.listOpenHolds("a1");
    expect(open).toHaveLength(1);
    expect(open[0]!.holdId).toBe(r.hold.holdId);
    expect(open[0]!.estimatedUsd).toBeCloseTo(0.004, 6);
    enf.reconcile(r.hold, { inputTokens: 1000, outputTokens: 200 });
    expect(new BudgetLedger({ agencHome: home, now }).listOpenHolds("a1")).toHaveLength(0);
  });

  test("a crash-stranded hold keeps its full reservation (held_unknown)", () => {
    const enf = make({ caps: { dailyUsd: 100 } });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    // No reconcile (simulated crash): a fresh instance still sees the full
    // worst-case debit AND the open hold — never a silent refund.
    const fresh = new BudgetLedger({ agencHome: home, now });
    expect(fresh.snapshot("a1").day.usd).toBeCloseTo(0.004, 6);
    expect(fresh.listOpenHolds("a1")).toHaveLength(1);
  });

  test("reconcile after the day window rolled discards the hold without refund", () => {
    let clock = new Date("2026-07-09T10:00:00Z");
    sharedLedger = new BudgetLedger({ agencHome: home, now: () => clock });
    const enf = new BudgetEnforcer({
      policy: {
        enabled: true,
        softThreshold: 0.8,
        enforceInteractive: false,
        caps: { dailyUsd: 100 },
      },
      ledger: sharedLedger,
      priceOf,
      notify: (e) => notes.push(e),
    });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    clock = new Date("2026-07-10T10:00:00Z"); // day rolls, same month
    const result = enf.reconcile(r.hold, { inputTokens: 0, outputTokens: 0 });
    expect(result).toEqual({ applied: false, reason: "window_rolled" });
    const s = sharedLedger.snapshot("a1");
    expect(s.day.usd).toBe(0); // no negative refund into the new day
    expect(s.month.usd).toBeCloseTo(0.004, 6); // month keeps the reservation
    expect(sharedLedger.listOpenHolds("a1")).toHaveLength(0); // discarded
  });

  test("concurrent reservers cannot both pass the same headroom (locked check)", () => {
    // Two enforcers over two ledger INSTANCES of the same file, both built
    // before either admits — the second's cap check must see the first's
    // debit via the locked reload, not its own stale in-memory copy.
    const policy: BudgetPolicy = {
      enabled: true,
      softThreshold: 0.8,
      enforceInteractive: false,
      caps: { dailyUsd: 0.006 }, // fits ONE 0.004 worst-case, not two
    };
    const ledgerA = new BudgetLedger({ agencHome: home, now });
    const ledgerB = new BudgetLedger({ agencHome: home, now });
    const enfA = new BudgetEnforcer({ policy, ledger: ledgerA, priceOf });
    const enfB = new BudgetEnforcer({ policy, ledger: ledgerB, priceOf });
    const a = enfA.admit(autoReq());
    expect(a.ok).toBe(true);
    const b = enfB.admit(autoReq());
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("daily_usd");
  });

  test("reset clears the agent's open holds", () => {
    const enf = make({ caps: { dailyUsd: 100 } });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    sharedLedger.reset("a1");
    expect(sharedLedger.listOpenHolds("a1")).toHaveLength(0);
    expect(sharedLedger.snapshot("a1").day.usd).toBe(0);
  });

  test("admit debits worst-case; reconcile refunds the delta to actual", () => {
    const enf = make({ caps: { dailyUsd: 100 } });
    // worst-case for 1000 in + 1000 out at $1/$3 per M = 0.001 + 0.003 = $0.004
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(true);
    expect(sharedLedger.snapshot("a1").day.usd).toBeCloseTo(0.004, 6);
    expect(sharedLedger.snapshot("a1").day.tokens).toBe(2000); // worst-case held
    if (r.ok) {
      // Actual: 1000 in + 200 out = 0.001 + 0.0006 = $0.0016
      enf.reconcile(r.hold, { inputTokens: 1000, outputTokens: 200 });
    }
    expect(sharedLedger.snapshot("a1").day.usd).toBeCloseTo(0.0016, 6);
    expect(sharedLedger.snapshot("a1").day.tokens).toBe(1200); // reconciled to actual
  });

  test("FAIL CLOSED: worst-case over the daily cap refuses, pauses, notifies", () => {
    const enf = make({ caps: { dailyUsd: 0.003 } }); // worst-case 0.004 > 0.003
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BUDGET_EXCEEDED");
      expect(r.reason).toBe("daily_usd");
    }
    // Autonomy paused + a paused notification fired (fail closed, not downgrade).
    expect(new BudgetLedger({ agencHome: home, now }).snapshot("a1").paused).toBe(true);
    expect(notes.some((n) => n.kind === "paused")).toBe(true);
  });

  test("a paused agent is refused with reason 'paused' on the next admit", () => {
    const enf = make({ caps: { dailyUsd: 0.003 } });
    enf.admit(autoReq()); // trips + pauses
    const r2 = enf.admit(autoReq());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("paused");
  });

  test("monthly cap is enforced independently of the daily cap", () => {
    const enf = make({ caps: { dailyUsd: 1000, monthlyUsd: 0.003 } });
    const r = enf.admit(autoReq());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("monthly_usd");
  });

  test("token caps gate even when the model is unpriced", () => {
    const enf = make({ caps: { dailyTokens: 1500 } }); // worst-case 2000 tokens
    const r = enf.admit(autoReq({ model: "unpriced" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("daily_tokens");
  });

  test("unpriced model refuses dollar caps (fail-closed, todo-104)", () => {
    const enf = make({ caps: { dailyUsd: 0.0000001 } });
    const r = enf.admit(autoReq({ model: "unpriced" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unpriced_model");
  });

  test("soft warning fires once when a window crosses the threshold", () => {
    const enf = make({ caps: { dailyUsd: 0.01 }, softThreshold: 0.5 });
    // Each turn worst-case 0.004, actual set to 0.004 (in=1000,out=1000).
    const r1 = enf.admit(autoReq());
    if (r1.ok) enf.reconcile(r1.hold, { inputTokens: 1000, outputTokens: 1000 });
    // 0.004 < 0.5*0.01=0.005 → no warning yet
    expect(notes.filter((n) => n.kind === "soft_warning")).toHaveLength(0);
    const r2 = enf.admit(autoReq());
    if (r2.ok) enf.reconcile(r2.hold, { inputTokens: 1000, outputTokens: 1000 });
    // 0.008 >= 0.005 → one warning
    const warns = notes.filter((n) => n.kind === "soft_warning" && n.window === "day");
    expect(warns).toHaveLength(1);
    // A third crossing does not re-warn.
    const r3 = enf.admit(autoReq());
    if (r3.ok) enf.reconcile(r3.hold, { inputTokens: 100, outputTokens: 100 });
    expect(notes.filter((n) => n.kind === "soft_warning" && n.window === "day")).toHaveLength(1);
  });

  test("enforceInteractive gates interactive turns too", () => {
    const enf = make({ caps: { dailyUsd: 0.003 }, enforceInteractive: true });
    const r = enf.admit(autoReq({ autonomous: false }));
    expect(r.ok).toBe(false);
  });
});
