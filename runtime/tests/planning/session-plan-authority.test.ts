import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getExistingPlanFilePath, getPlanFilePath, setPlanSlug, clearAllPlanSlugs } from "../../src/planning/plan-files.js";
import { matchesSessionPlanFile, planFileAuthorityFromContext } from "../../src/planning/session-plan-authority.js";
import { signedSessionPlanFileArgs, verifySessionPlanFileArgs, SESSION_PLAN_FILE_ARG, SESSION_PLAN_FILE_SIG_ARG } from "../../src/agents/_deps/filesystem-args.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agenc-plan-capability-")); });
afterEach(() => { clearAllPlanSlugs(); rmSync(root, { recursive: true, force: true }); });

describe("signed exact plan capability", () => {
  it("does not allocate a slug or create a directory during a permission lookup", () => {
    const context = { agencHome: join(root, "missing"), sessionId: "missing-plan" };
    expect(getExistingPlanFilePath(context)).toBeNull();
    expect(planFileAuthorityFromContext(context)).toBeNull();
    expect(existsSync(context.agencHome)).toBe(false);
  });

  it("binds every authority field across a JSON roundtrip and rejects tampering", () => {
    const context = { agencHome: root, sessionId: "own-session", agentId: "own-agent" };
    setPlanSlug(context, "own-plan");
    const authority = planFileAuthorityFromContext(context)!;
    const args = JSON.parse(JSON.stringify(signedSessionPlanFileArgs(authority)));
    expect(verifySessionPlanFileArgs(args)).toEqual(authority);
    for (const key of ["sessionId", "agentId", "agencHome", "planFilePath"]) {
      expect(verifySessionPlanFileArgs({ ...args, [SESSION_PLAN_FILE_ARG]: { ...args[SESSION_PLAN_FILE_ARG], [key]: "forged" } })).toBeNull();
    }
    expect(verifySessionPlanFileArgs({ ...args, [SESSION_PLAN_FILE_SIG_ARG]: "00".repeat(32) })).toBeNull();
    expect(verifySessionPlanFileArgs(signedSessionPlanFileArgs(null))).toBeNull();
    expect(matchesSessionPlanFile(getPlanFilePath(context), authority)).toBe(true);
    expect(matchesSessionPlanFile(getPlanFilePath({ ...context, agentId: "other-agent" }), authority)).toBe(false);
    expect(matchesSessionPlanFile(getPlanFilePath({ ...context, agentId: undefined }), authority)).toBe(false);
  });
});
