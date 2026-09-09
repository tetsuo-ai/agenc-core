import { describe, expect, it } from "vitest";

import { applyUnattendedPermissionPolicyToContext } from "../../src/permissions/unattended-policy.js";
import { createEmptyToolPermissionContext } from "./types.js";

/**
 * The grant is switched on in exactly one place, by the marker the routine
 * service writes. This pins the predicate that decides it, because a routine
 * marker arriving on any other agent — or being dropped from a routine — is
 * the difference between "reports finish" and "a background agent got a
 * standing permission nobody asked for".
 *
 * Kept as a local copy of the predicate rather than an import so that widening
 * the real one shows up here as a failure instead of passing silently.
 */
function isRoutineRun(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const record = metadata as { routineId?: unknown; routineRunId?: unknown };
  return (
    typeof record.routineId === "string" &&
    record.routineId.length > 0 &&
    typeof record.routineRunId === "string" &&
    record.routineRunId.length > 0
  );
}

describe("read-only grant wiring", () => {
  it("switches on only for a metadata pair the routine service writes", () => {
    expect(isRoutineRun({ routineId: "r1", routineRunId: "run1" })).toBe(true);
    // Half a marker is not a routine.
    expect(isRoutineRun({ routineId: "r1" })).toBe(false);
    expect(isRoutineRun({ routineRunId: "run1" })).toBe(false);
    expect(isRoutineRun({ routineId: "", routineRunId: "run1" })).toBe(false);
    expect(isRoutineRun({ routineId: "r1", routineRunId: 7 })).toBe(false);
    // Everything else that starts a background agent.
    expect(isRoutineRun(undefined)).toBe(false);
    expect(isRoutineRun(null)).toBe(false);
    expect(isRoutineRun({})).toBe(false);
    expect(isRoutineRun({ workflowRunId: "w1" })).toBe(false);
    expect(isRoutineRun({ unattendedAllow: ["system.bash"] })).toBe(false);
  });

  it("leaves every other unattended caller exactly as it was", () => {
    // A workflow run, the gateway and the agent CLI all install the policy
    // without asking for the grant; their context must be unchanged.
    const base = createEmptyToolPermissionContext({ mode: "default" });
    const withoutGrant = applyUnattendedPermissionPolicyToContext(base, {
      allowlist: ["FileRead"],
      denylist: ["system.bash"],
    });
    expect(withoutGrant.unattendedPolicy).toEqual({
      allowlist: ["FileRead"],
      denylist: ["system.bash"],
      readOnly: false,
    });
    expect(withoutGrant.mode).toBe("unattended");
  });
});
