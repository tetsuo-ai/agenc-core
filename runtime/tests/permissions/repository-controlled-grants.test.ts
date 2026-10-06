import { describe, expect, test } from "vitest";

import { filterRepositoryControlledPermissionGrants } from "../../src/permissions/settings.js";
import type { PermissionRule } from "../../src/permissions/types.js";

function rule(
  source: PermissionRule["source"],
  ruleBehavior: PermissionRule["ruleBehavior"],
  toolName: string,
): PermissionRule {
  return {
    source,
    ruleBehavior,
    ruleValue: { toolName },
  };
}

describe("filterRepositoryControlledPermissionGrants", () => {
  test("drops allow rules from project and local settings only", () => {
    const projectAllow = rule("projectSettings", "allow", "Write");
    const localAllow = rule("localSettings", "allow", "system.bash");
    const userAllow = rule("userSettings", "allow", "FileRead");
    const sessionAllow = rule("session", "allow", "Edit");
    const policyAllow = rule("policySettings", "allow", "Grep");

    expect(
      filterRepositoryControlledPermissionGrants([
        projectAllow,
        localAllow,
        userAllow,
        sessionAllow,
        policyAllow,
      ]),
    ).toEqual([userAllow, sessionAllow, policyAllow]);
  });

  test("keeps repository deny and ask rules so a repo cannot hide a prompt", () => {
    const projectDeny = rule("projectSettings", "deny", "Write");
    const localAsk = rule("localSettings", "ask", "system.bash");
    const projectAsk = rule("projectSettings", "ask", "Edit");

    expect(
      filterRepositoryControlledPermissionGrants([
        projectDeny,
        localAsk,
        projectAsk,
      ]),
    ).toEqual([projectDeny, localAsk, projectAsk]);
  });

  test("leaves an empty list unchanged", () => {
    expect(filterRepositoryControlledPermissionGrants([])).toEqual([]);
  });
});
