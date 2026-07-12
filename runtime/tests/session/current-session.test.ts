/**
 * Regression tests for audit finding 11 (bug-audit-2026-07-11): the
 * module-level `currentRuntimeSession` fallback is overwritten by every
 * bootstrap, so in a multi-session daemon any consumer outside the
 * AsyncLocalStorage turn scope silently bound to the LAST bootstrapped
 * session. The fallback now throws a descriptive error when more than one
 * session is live in the process; single-session processes (CLI one-shots,
 * tests) keep the fallback behavior, and ALS-scoped access is unaffected.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  clearCurrentRuntimeSession,
  getCurrentRuntimeSession,
  peekAmbientRuntimeSession,
  requireCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "./current-session.js";
import type { Session } from "./session.js";

function fakeSession(id: string): Session {
  return { conversationId: id } as unknown as Session;
}

afterEach(() => {
  clearCurrentRuntimeSession();
});

describe("current runtime session fallback", () => {
  it("returns the fallback session when exactly one has been bootstrapped", () => {
    const a = fakeSession("conv-a");
    setCurrentRuntimeSession(a);
    expect(getCurrentRuntimeSession()).toBe(a);
    expect(peekAmbientRuntimeSession()).toBe(a);
    expect(requireCurrentRuntimeSession("test")).toBe(a);
  });

  it("throws outside ALS when two sessions are bootstrapped", () => {
    setCurrentRuntimeSession(fakeSession("conv-a"));
    setCurrentRuntimeSession(fakeSession("conv-b"));
    expect(() => getCurrentRuntimeSession()).toThrow(
      /Ambiguous runtime session/,
    );
    expect(() => requireCurrentRuntimeSession("test")).toThrow(
      /Ambiguous runtime session/,
    );
    // The non-throwing peek refuses to guess instead.
    expect(peekAmbientRuntimeSession()).toBeNull();
  });

  it("ALS-scoped access still works with two sessions bootstrapped", () => {
    const a = fakeSession("conv-a");
    const b = fakeSession("conv-b");
    setCurrentRuntimeSession(a);
    setCurrentRuntimeSession(b);
    expect(runWithCurrentRuntimeSession(a, () => getCurrentRuntimeSession())).toBe(a);
    expect(runWithCurrentRuntimeSession(b, () => getCurrentRuntimeSession())).toBe(b);
    expect(
      runWithCurrentRuntimeSession(a, () => peekAmbientRuntimeSession()),
    ).toBe(a);
    expect(
      runWithCurrentRuntimeSession(a, () => requireCurrentRuntimeSession("test")),
    ).toBe(a);
  });

  it("clearing one of two sessions restores the unambiguous fallback", () => {
    const a = fakeSession("conv-a");
    const b = fakeSession("conv-b");
    setCurrentRuntimeSession(a);
    setCurrentRuntimeSession(b);
    clearCurrentRuntimeSession(a);
    expect(getCurrentRuntimeSession()).toBe(b);
  });

  it("sequential bootstrap-shutdown-bootstrap keeps the fallback working", () => {
    const a = fakeSession("conv-a");
    setCurrentRuntimeSession(a);
    clearCurrentRuntimeSession(a);
    expect(getCurrentRuntimeSession()).toBeNull();
    const b = fakeSession("conv-b");
    setCurrentRuntimeSession(b);
    expect(getCurrentRuntimeSession()).toBe(b);
  });

  it("no-arg clear fully resets the ambiguity tracking", () => {
    setCurrentRuntimeSession(fakeSession("conv-a"));
    setCurrentRuntimeSession(fakeSession("conv-b"));
    clearCurrentRuntimeSession();
    expect(getCurrentRuntimeSession()).toBeNull();
    const c = fakeSession("conv-c");
    setCurrentRuntimeSession(c);
    expect(getCurrentRuntimeSession()).toBe(c);
  });

  it("re-setting the same session does not create ambiguity", () => {
    const a = fakeSession("conv-a");
    setCurrentRuntimeSession(a);
    setCurrentRuntimeSession(a);
    expect(getCurrentRuntimeSession()).toBe(a);
  });
});
