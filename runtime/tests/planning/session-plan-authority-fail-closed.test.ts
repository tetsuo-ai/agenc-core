import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  getPlansDirectory,
  setPlanSlug,
} from "../../src/planning/plan-files.js";
import {
  isSessionPlanMutation,
  matchesSessionPlanFile,
  planFileAuthorityFromContext,
  sessionFilesystemContext,
} from "../../src/planning/session-plan-authority.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-plan-fail-closed-"));
  clearAllPlanSlugs();
});

afterEach(() => {
  clearAllPlanSlugs();
  rmSync(root, { recursive: true, force: true });
});

function ownContext(agencHome = root) {
  const context = { agencHome, sessionId: "own-session" };
  setPlanSlug(context, "own-plan");
  getPlansDirectory(context);
  return context;
}

function filesystemTool(name: string) {
  return { name, metadata: { source: "builtin", family: "filesystem" } };
}

function sessionFor(agencHome: string, sessionId = "own-session") {
  return {
    conversationId: sessionId,
    services: { configStore: { homeContext: { path: agencHome } } },
  };
}

describe("planFileAuthorityFromContext fail-closed homes", () => {
  it("refuses a blank session or home before looking up a plan", () => {
    expect(planFileAuthorityFromContext({ agencHome: root, sessionId: "" })).toBeNull();
    expect(planFileAuthorityFromContext({ agencHome: root, sessionId: "   " })).toBeNull();
    expect(planFileAuthorityFromContext({ agencHome: "", sessionId: "own-session" })).toBeNull();
  });

  it.each([".git", ".agents", ".GIT", ".Agents"] as const)(
    "refuses a home whose path contains %s",
    (segment) => {
      const agencHome = join(root, segment, "home");
      mkdirSync(agencHome, { recursive: true });
      const context = ownContext(agencHome);
      expect(getPlanFilePath(context).includes(`${segment}/`)).toBe(true);
      expect(planFileAuthorityFromContext(context)).toBeNull();
    },
  );
});

describe("matchesSessionPlanFile fail-closed targets", () => {
  it("rejects missing authority, empty targets, and traversal or glob spellings", () => {
    const context = ownContext();
    const authority = planFileAuthorityFromContext(context);
    const planPath = getPlanFilePath(context);
    expect(authority).not.toBeNull();
    expect(matchesSessionPlanFile(planPath, authority)).toBe(true);
    expect(matchesSessionPlanFile(planPath, null)).toBe(false);
    expect(matchesSessionPlanFile("", authority)).toBe(false);
    expect(matchesSessionPlanFile("x".repeat(4097), authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}\0extra`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${dirname(planPath)}/../plans/own-plan.md`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}*`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}?`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}[0]`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}{a}`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}$`, authority)).toBe(false);
    expect(matchesSessionPlanFile(`${planPath}%`, authority)).toBe(false);
  });

  it("resolves a relative name only when cwd is the plans directory", () => {
    const context = ownContext();
    const authority = planFileAuthorityFromContext(context)!;
    const planPath = getPlanFilePath(context);
    expect(matchesSessionPlanFile("own-plan.md", authority)).toBe(false);
    expect(matchesSessionPlanFile("own-plan.md", authority, dirname(planPath))).toBe(true);
    expect(matchesSessionPlanFile("other-plan.md", authority, dirname(planPath))).toBe(false);
  });

  it("keeps a missing plan file admissible and rejects a directory or symlink there", () => {
    const context = ownContext();
    const authority = planFileAuthorityFromContext(context)!;
    const planPath = getPlanFilePath(context);
    expect(matchesSessionPlanFile(planPath, authority)).toBe(true);

    mkdirSync(planPath);
    expect(matchesSessionPlanFile(planPath, authority)).toBe(false);
    rmSync(planPath, { recursive: true, force: true });

    const elsewhere = join(root, "escape.md");
    writeFileSync(elsewhere, "not the plan\n");
    symlinkSync(elsewhere, planPath);
    expect(matchesSessionPlanFile(planPath, authority)).toBe(false);
  });
});

describe("isSessionPlanMutation", () => {
  it("allows only builtin Write/Edit/MultiEdit of the owning session plan file", () => {
    const context = ownContext();
    const planPath = getPlanFilePath(context);
    const session = sessionFor(root);
    const input = { file_path: planPath };

    expect(isSessionPlanMutation(filesystemTool("Write"), input, session)).toBe(true);
    expect(isSessionPlanMutation(filesystemTool("Edit"), input, session)).toBe(true);
    expect(isSessionPlanMutation(filesystemTool("MultiEdit"), input, session)).toBe(true);
    expect(isSessionPlanMutation(filesystemTool("FileRead"), input, session)).toBe(false);
    expect(isSessionPlanMutation(filesystemTool("apply_patch"), input, session)).toBe(false);
    expect(isSessionPlanMutation(filesystemTool("Write"), { file_path: join(root, "other.md") }, session)).toBe(false);
    expect(isSessionPlanMutation({ name: "Write" }, input, session)).toBe(false);
    expect(isSessionPlanMutation(
      { name: "Write", metadata: { source: "plugin", family: "filesystem" } },
      input,
      session,
    )).toBe(false);
  });
});

describe("sessionFilesystemContext", () => {
  it("returns the conversation id and canonical home, otherwise null", () => {
    const expected = resolveHomeContext({ AGENC_HOME: root });
    expect(sessionFilesystemContext(sessionFor(root, "live-session"))).toEqual({
      sessionId: "live-session",
      agencHome: expected.path,
    });
    expect(sessionFilesystemContext(null)).toBeNull();
    expect(sessionFilesystemContext([])).toBeNull();
    expect(sessionFilesystemContext({ conversationId: "   ", services: { configStore: { homeContext: { path: root } } } })).toBeNull();
    expect(sessionFilesystemContext({ conversationId: "live-session" })).toBeNull();
    expect(sessionFilesystemContext({
      conversationId: "live-session",
      services: { configStore: { homeContext: { path: "   " } } },
    })).toBeNull();
  });
});
