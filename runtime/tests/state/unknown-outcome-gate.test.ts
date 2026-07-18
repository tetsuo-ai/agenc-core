// M4 unknown-outcome mutation gate: while a session holds an unresolved
// poisoned (unknown-outcome) effect, recording a NEW side-effecting tool
// call is refused with a typed error until a reviewer explicitly resolves
// the effect. Idempotent/interactive calls and other sessions stay
// unaffected; the daemon's post-dispatch snapshot observer uses "flag"
// mode, which records reality but surfaces the violation.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordInFlightToolCallCompletion,
  recordInFlightToolCallProgress,
  recordInFlightToolCallStart,
} from "../../src/state/tool-output-rotation.js";
import {
  checkUnknownOutcomeMutationGate,
  listUnresolvedUnknownOutcomeEffects,
  resolveUnknownOutcomeEffect,
  UnknownOutcomeMutationBlockedError,
} from "../../src/state/unknown-outcome-gate.js";
import { recoverDaemonStateOnStartup } from "../../src/state/recovery.js";
import {
  parseAgenCStateCliArgs,
  runAgenCStateCli,
} from "../../src/bin/state-cli.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

let home: string;
let cwd: string;
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-unknown-outcome-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-unknown-outcome-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function startCall(options: {
  sessionId?: string;
  toolCallId: string;
  recoveryCategory?: "idempotent" | "side-effecting" | "interactive";
  unknownOutcomeGate?: "enforce" | "flag";
}) {
  return recordInFlightToolCallStart(driver, {
    sessionId: options.sessionId ?? "session_gate",
    agentId: "agent_gate",
    toolCallId: options.toolCallId,
    toolName: "Bash",
    args: { command: "echo probe" },
    startedAt: new Date(0).toISOString(),
    recoveryCategory: options.recoveryCategory ?? "side-effecting",
    agencHome: home,
    ...(options.unknownOutcomeGate !== undefined
      ? { unknownOutcomeGate: options.unknownOutcomeGate }
      : {}),
  });
}

/** Crash the in-flight side-effecting call into poisoned via real recovery. */
function poisonCall(toolCallId: string, sessionId = "session_gate"): void {
  startCall({ sessionId, toolCallId });
  const report = recoverDaemonStateOnStartup(driver);
  const recovered = report.recoveredToolCalls.find(
    (call) => call.toolCallId === toolCallId,
  );
  expect(recovered?.statusAfter).toBe("poisoned");
}

describe("unknown-outcome mutation gate", () => {
  it("blocks a new side-effecting call while a poisoned effect is unresolved", () => {
    poisonCall("call_poisoned");
    expect(() => startCall({ toolCallId: "call_dependent" })).toThrow(
      UnknownOutcomeMutationBlockedError,
    );
    try {
      startCall({ toolCallId: "call_dependent" });
      expect.unreachable("gate must throw");
    } catch (error) {
      const blocked = error as UnknownOutcomeMutationBlockedError;
      expect(blocked.code).toBe("UNKNOWN_OUTCOME_MUTATION_BLOCKED");
      expect(blocked.sessionId).toBe("session_gate");
      expect(blocked.blocking.map((effect) => effect.toolCallId)).toEqual([
        "call_poisoned",
      ]);
      expect(blocked.message).toContain("agenc state resolve-tool-call");
    }
    // The refused call was never recorded.
    const rows = driver
      .prepareState<[string], { tool_call_id?: string }>(
        "SELECT tool_call_id FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .all("call_dependent");
    expect(rows).toHaveLength(0);
  });

  it("does not gate idempotent or interactive calls, or other sessions", () => {
    poisonCall("call_poisoned");
    expect(() =>
      startCall({ toolCallId: "call_read", recoveryCategory: "idempotent" }),
    ).not.toThrow();
    expect(() =>
      startCall({ toolCallId: "call_ask", recoveryCategory: "interactive" }),
    ).not.toThrow();
    expect(() =>
      startCall({ sessionId: "session_other", toolCallId: "call_elsewhere" }),
    ).not.toThrow();
  });

  it("explicit review resolution lifts the gate and stops recovery re-surfacing", () => {
    poisonCall("call_poisoned");
    expect(
      resolveUnknownOutcomeEffect(driver, {
        sessionId: "session_gate",
        toolCallId: "call_poisoned",
      }),
    ).toBe(true);
    expect(listUnresolvedUnknownOutcomeEffects(driver, "session_gate")).toEqual(
      [],
    );
    expect(() => startCall({ toolCallId: "call_after_review" })).not.toThrow();
    // unknown_resolved is terminal and NOT re-surfaced, and it must not be
    // re-poisoned by a later recovery pass. (call_after_review is running
    // and will itself be poisoned by this pass — expected.)
    const report = recoverDaemonStateOnStartup(driver);
    expect(
      report.recoveredToolCalls.some(
        (call) => call.toolCallId === "call_poisoned",
      ),
    ).toBe(false);
    // Resolving twice (or resolving a non-poisoned call) is a no-op.
    expect(
      resolveUnknownOutcomeEffect(driver, {
        sessionId: "session_gate",
        toolCallId: "call_poisoned",
      }),
    ).toBe(false);
    expect(
      resolveUnknownOutcomeEffect(driver, {
        sessionId: "session_gate",
        toolCallId: "call_never_existed",
      }),
    ).toBe(false);
  });

  it("flag mode records the already-dispatched call and returns the violation", () => {
    poisonCall("call_poisoned");
    const outcome = startCall({
      toolCallId: "call_observed",
      unknownOutcomeGate: "flag",
    });
    expect(outcome.gateViolation).toBeDefined();
    expect(
      outcome.gateViolation!.blocking.map((effect) => effect.toolCallId),
    ).toEqual(["call_poisoned"]);
    // Reality was recorded — the observer never loses bookkeeping.
    const rows = driver
      .prepareState<[string], { status?: string }>(
        "SELECT status FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .all("call_observed");
    expect(rows).toEqual([{ status: "running" }]);
    // A clean session in flag mode reports no violation.
    const clean = startCall({
      sessionId: "session_clean",
      toolCallId: "call_clean",
      unknownOutcomeGate: "flag",
    });
    expect(clean.gateViolation).toBeUndefined();
  });

  it("agenc state resolve-tool-call resolves via the CLI surface", async () => {
    poisonCall("call_poisoned");
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (text: string) => (out.push(text), true) },
      stderr: { write: (text: string) => (err.push(text), true) },
    };
    const command = parseAgenCStateCliArgs([
      "state",
      "resolve-tool-call",
      "session_gate",
      "call_poisoned",
    ]);
    expect(command).toEqual({
      kind: "resolve-tool-call",
      sessionId: "session_gate",
      toolCallId: "call_poisoned",
    });
    expect(await runAgenCStateCli(command!, { driver, io })).toBe(0);
    expect(out.join("")).toContain("Resolved unknown-outcome tool call");
    expect(() => startCall({ toolCallId: "call_after_cli" })).not.toThrow();
    // Unknown/already-resolved ids fail with the unresolved listing.
    expect(await runAgenCStateCli(command!, { driver, io })).toBe(1);
    expect(err.join("")).toContain("no unresolved unknown-outcome tool call");
    // Missing args are a parse error.
    expect(
      parseAgenCStateCliArgs(["state", "resolve-tool-call", "session_gate"]),
    ).toMatchObject({ kind: "error" });
  });

  it("a poisoned row is review-locked: same-id re-records cannot launder it", () => {
    poisonCall("call_poisoned");
    // Attack 1 (flag mode): a duplicate/replayed tool_request carrying the
    // poisoned row's own id reaches the observer. The upsert must NOT flip
    // the row back to running (which would lift the gate with no review).
    startCall({ toolCallId: "call_poisoned", unknownOutcomeGate: "flag" });
    expect(
      listUnresolvedUnknownOutcomeEffects(driver, "session_gate").map(
        (effect) => effect.toolCallId,
      ),
    ).toEqual(["call_poisoned"]);
    // Attack 2 (idempotent relabel): a same-id re-record claiming
    // "idempotent" passes the category gate but must not rewrite the
    // poisoned row's status/category — otherwise the next recovery would
    // AUTO-REPLAY a possibly-executed side effect.
    startCall({
      toolCallId: "call_poisoned",
      recoveryCategory: "idempotent",
      unknownOutcomeGate: "flag",
    });
    const row = driver
      .prepareState<[string], { status?: string; recovery_category?: string }>(
        "SELECT status, recovery_category FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("call_poisoned");
    expect(row).toEqual({
      status: "poisoned",
      recovery_category: "side-effecting",
    });
    const report = recoverDaemonStateOnStartup(driver);
    const surfaced = report.recoveredToolCalls.find(
      (call) => call.toolCallId === "call_poisoned",
    );
    expect(surfaced?.recoveryAction).not.toBe("replay");
  });

  it("a stale completion or progress event cannot lift the review lock", () => {
    poisonCall("call_poisoned");
    // Post-recovery "completion" for a call whose execution the crash
    // killed is a stale/replayed event — it must not resolve the effect.
    recordInFlightToolCallCompletion(driver, {
      sessionId: "session_gate",
      agentId: "agent_gate",
      toolCallId: "call_poisoned",
      result: "late ack",
      isError: false,
      completedAt: new Date(1).toISOString(),
      agencHome: home,
    });
    expect(
      listUnresolvedUnknownOutcomeEffects(driver, "session_gate").map(
        (effect) => effect.toolCallId,
      ),
    ).toEqual(["call_poisoned"]);
    // A progress event must neither rewrite the locked row's category nor
    // throw out of the observer backfill path in a poisoned session.
    expect(() =>
      recordInFlightToolCallProgress(driver, {
        sessionId: "session_gate",
        agentId: "agent_gate",
        toolCallId: "call_poisoned",
        chunk: "late chunk",
        observedAt: new Date(2).toISOString(),
        recoveryCategory: "idempotent",
        agencHome: home,
      }),
    ).not.toThrow();
    const row = driver
      .prepareState<[string], { status?: string; recovery_category?: string }>(
        "SELECT status, recovery_category FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("call_poisoned");
    expect(row).toEqual({
      status: "poisoned",
      recovery_category: "side-effecting",
    });
  });

  it("the progress backfill for an orphan call flags instead of throwing in a poisoned session", () => {
    poisonCall("call_poisoned");
    // An orphan side-effecting call (progress before any recorded start)
    // must still become crash-durable — the observer-context backfill flags
    // the violation rather than refusing bookkeeping.
    expect(() =>
      recordInFlightToolCallProgress(driver, {
        sessionId: "session_gate",
        agentId: "agent_gate",
        toolCallId: "call_orphan",
        chunk: "output",
        observedAt: new Date(3).toISOString(),
        agencHome: home,
      }),
    ).not.toThrow();
    const rows = driver
      .prepareState<[string], { status?: string }>(
        "SELECT status FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .all("call_orphan");
    expect(rows).toEqual([{ status: "running" }]);
  });

  it("the gate decision function is consultable pre-dispatch (M3 admission seam)", () => {
    poisonCall("call_poisoned");
    expect(
      checkUnknownOutcomeMutationGate(driver, {
        sessionId: "session_gate",
        recoveryCategory: "side-effecting",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      checkUnknownOutcomeMutationGate(driver, {
        sessionId: "session_gate",
        recoveryCategory: "idempotent",
      }),
    ).toEqual({ allowed: true });
  });
});
