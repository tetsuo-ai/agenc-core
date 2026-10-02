import { describe, expect, test } from "vitest";

import { mutatePermissionRuleSource } from "../../src/permissions/permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type PermissionBehavior,
  type PermissionRuleValue,
  type PermissionUpdateDestination,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";

const FILE_READ: PermissionRuleValue = { toolName: "FileRead" };
const DANGEROUS_BASH: PermissionRuleValue = { toolName: "system.bash" };

function sessionAllow(
  context: ToolPermissionContext,
): readonly string[] {
  return context.alwaysAllowRules.session ?? [];
}

function sessionStash(
  context: ToolPermissionContext,
): readonly string[] {
  return context.strippedDangerousRules?.session ?? [];
}

function addSessionRule(
  context: ToolPermissionContext,
  rule: PermissionRuleValue,
  behavior: PermissionBehavior = "allow",
) {
  return mutatePermissionRuleSource(
    context,
    "session",
    "add",
    behavior,
    rule,
  );
}

describe("mutatePermissionRuleSource", () => {
  test("adds a session allow rule once and reports the canonical buckets", () => {
    const empty = createEmptyToolPermissionContext();
    const first = addSessionRule(empty, FILE_READ);

    expect(first.applied).toBe(true);
    expect(first.next).not.toBe(empty);
    expect(sessionAllow(first.next)).toEqual(["FileRead"]);
    expect(first.buckets).toEqual({
      allow: ["FileRead"],
      deny: [],
      ask: [],
    });

    const second = addSessionRule(first.next, FILE_READ);
    expect(second.applied).toBe(false);
    expect(second.next).toBe(first.next);
    expect(second.buckets.allow).toEqual(["FileRead"]);
  });

  test("removes an existing session rule and is a no-op when the rule is absent", () => {
    const seeded = addSessionRule(
      createEmptyToolPermissionContext(),
      FILE_READ,
    ).next;
    const removed = mutatePermissionRuleSource(
      seeded,
      "session",
      "remove",
      "allow",
      FILE_READ,
    );

    expect(removed.applied).toBe(true);
    expect(sessionAllow(removed.next)).toEqual([]);
    expect(removed.buckets.allow).toEqual([]);

    const missing = mutatePermissionRuleSource(
      removed.next,
      "session",
      "remove",
      "allow",
      FILE_READ,
    );
    expect(missing.applied).toBe(false);
    expect(missing.next).toBe(removed.next);
  });

  test("keeps destination buckets isolated", () => {
    const empty = createEmptyToolPermissionContext();
    const destinations: readonly PermissionUpdateDestination[] = [
      "session",
      "userSettings",
    ];
    const session = mutatePermissionRuleSource(
      empty,
      destinations[0],
      "add",
      "deny",
      FILE_READ,
    );

    expect(session.applied).toBe(true);
    expect(session.next.alwaysDenyRules.session).toEqual(["FileRead"]);
    expect(session.next.alwaysDenyRules.userSettings).toBeUndefined();
    expect(session.buckets.deny).toEqual(["FileRead"]);
  });

  test("auto mode stashes a dangerous allow without leaking it into the live projection", () => {
    const auto = createEmptyToolPermissionContext({
      mode: "auto",
      autoModeActive: true,
    });
    const first = addSessionRule(auto, DANGEROUS_BASH);

    expect(first.applied).toBe(true);
    expect(first.buckets.allow).toEqual(["system.bash"]);
    expect(sessionAllow(first.next)).toEqual([]);
    expect(sessionStash(first.next)).toEqual(["system.bash"]);
    expect(first.next.autoModeActive).toBe(true);
    expect(first.next.mode).toBe("auto");

    const second = addSessionRule(first.next, DANGEROUS_BASH);
    expect(second.applied).toBe(false);
    expect(second.next).toBe(first.next);
    expect(second.buckets.allow).toEqual(["system.bash"]);
  });

  test("plan mode with live auto semantics also hides a dangerous allow", () => {
    const planAuto = createEmptyToolPermissionContext({
      mode: "plan",
      autoModeActive: true,
    });
    const mutated = addSessionRule(planAuto, DANGEROUS_BASH);

    expect(mutated.applied).toBe(true);
    expect(mutated.buckets.allow).toEqual(["system.bash"]);
    expect(sessionAllow(mutated.next)).toEqual([]);
    expect(sessionStash(mutated.next)).toEqual(["system.bash"]);
    expect(mutated.next.mode).toBe("plan");
    expect(mutated.next.autoModeActive).toBe(true);
  });

  test("removing a stripped dangerous allow updates the logical session snapshot", () => {
    const auto = addSessionRule(
      createEmptyToolPermissionContext({
        mode: "auto",
        autoModeActive: true,
      }),
      DANGEROUS_BASH,
    ).next;
    const removed = mutatePermissionRuleSource(
      auto,
      "session",
      "remove",
      "allow",
      DANGEROUS_BASH,
    );

    expect(removed.applied).toBe(true);
    expect(removed.buckets.allow).toEqual([]);
    expect(sessionAllow(removed.next)).toEqual([]);
    expect(sessionStash(removed.next)).toEqual([]);
  });
});
