/**
 * Tests for GuardianRejectionCircuitBreaker.
 *
 * Mirrors upstream codex runtime tests from
 * `codex-rs/core/src/guardian/tests.rs`:
 *   - `guardian_rejection_circuit_breaker_interrupts_after_three_consecutive_denials`
 *   - `guardian_rejection_circuit_breaker_resets_consecutive_denials_on_non_denial`
 *   - `guardian_rejection_circuit_breaker_interrupts_after_ten_total_denials`
 * plus AgenC-specific additions for per-turn isolation, concurrency,
 * and clearTurn semantics.
 */

import { describe, expect, test } from "vitest";
import {
  GuardianRejectionCircuitBreaker,
  MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
  MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN,
  createGuardianRejectionCircuitBreaker,
} from "./guardian-rejection-circuit-breaker.js";

describe("GuardianRejectionCircuitBreaker (upstream AgenC behavior)", () => {
  test("stays closed below the consecutive threshold", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.isOpen("turn-1")).toBe(false);
  });

  test("interrupts after three consecutive denials (upstream parity)", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 3,
      totalDenials: 3,
    });
    // Fourth denial in same turn returns Continue (interrupt is one-shot).
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.isOpen("turn-1")).toBe(true);
  });

  test("recordNonDenial resets consecutive but not total (upstream parity)", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    breaker.recordNonDenial("turn-1");
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 3,
      totalDenials: 4,
    });
  });

  test("interrupts after ten total denials even with non-denials between (upstream parity)", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    for (let i = 0; i < 9; i++) {
      expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
      breaker.recordNonDenial("turn-1");
    }
    expect(breaker.recordDenial("turn-1")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 1,
      totalDenials: 10,
    });
  });

  test("clearTurn resets the per-turn row and re-arms the interrupt", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    breaker.recordDenial("turn-1");
    breaker.recordDenial("turn-1");
    breaker.recordDenial("turn-1");
    expect(breaker.isOpen("turn-1")).toBe(true);

    breaker.clearTurn("turn-1");
    expect(breaker.isOpen("turn-1")).toBe(false);
    expect(breaker.peek("turn-1")).toBeUndefined();

    // After clear, the turn can fire again on three fresh consecutive denials.
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 3,
      totalDenials: 3,
    });
  });

  test("per-turn rows are isolated", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    breaker.recordDenial("turn-a");
    breaker.recordDenial("turn-a");
    breaker.recordDenial("turn-a"); // fires on turn-a
    expect(breaker.isOpen("turn-a")).toBe(true);

    // turn-b is untouched.
    expect(breaker.isOpen("turn-b")).toBe(false);
    expect(breaker.recordDenial("turn-b")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-b")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-b")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 3,
      totalDenials: 3,
    });
  });

  test("reset() wipes every turn", () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    breaker.recordDenial("turn-a");
    breaker.recordDenial("turn-b");
    expect(breaker.peek("turn-a")).toBeDefined();
    expect(breaker.peek("turn-b")).toBeDefined();

    breaker.reset();
    expect(breaker.peek("turn-a")).toBeUndefined();
    expect(breaker.peek("turn-b")).toBeUndefined();
  });

  test("custom thresholds are honored by the factory", () => {
    const breaker = createGuardianRejectionCircuitBreaker({
      maxConsecutiveDenialsPerTurn: 2,
      maxTotalDenialsPerTurn: 100,
    });
    expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    expect(breaker.recordDenial("turn-1")).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: 2,
      totalDenials: 2,
    });
  });

  test("factory defaults match runtime constants", () => {
    expect(MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN).toBe(3);
    expect(MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN).toBe(10);
    const breaker = createGuardianRejectionCircuitBreaker();
    // Defaults must match.
    for (let i = 0; i < MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN - 1; i++) {
      expect(breaker.recordDenial("turn-1")).toEqual({ kind: "continue" });
    }
    const action = breaker.recordDenial("turn-1");
    expect(action.kind).toBe("interrupt_turn");
  });

  test("concurrent recordDenial calls on one turn serialize deterministically", async () => {
    const breaker = new GuardianRejectionCircuitBreaker();
    // Node's single-threaded event loop: synchronous `recordDenial` bodies
    // cannot interleave. Fire N awaited microtasks against the same turn
    // and assert the interrupt fires on exactly one of them.
    const calls = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => breaker.recordDenial("turn-1")),
    );
    const results = await Promise.all(calls);
    const interrupts = results.filter((r) => r.kind === "interrupt_turn");
    expect(interrupts).toHaveLength(1);
    // First interrupt must be at consecutive == threshold and total == threshold.
    const firstInterrupt = interrupts[0];
    expect(firstInterrupt).toEqual({
      kind: "interrupt_turn",
      consecutiveDenials: MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
      totalDenials: MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN,
    });
    // Subsequent denials in the same turn must all be Continue.
    const continues = results.filter((r) => r.kind === "continue");
    expect(continues).toHaveLength(9);
  });
});
