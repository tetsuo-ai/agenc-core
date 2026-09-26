/**
 * Path rules name files, not spellings. A deny or ask rule written through a
 * symlinked directory used to be compared only with the target's resolved
 * path, so it never matched: under bypassPermissions the read or write went
 * ahead, and in default mode it asked about the working directory instead of
 * refusing. Deny and ask now meet a path whichever way the rule or the path
 * is spelled. Allow rules still grant only where a path resolves, and all of
 * it, so a link inside an allowed directory cannot carry them further.
 *
 * Each test builds its links in its own mkdtemp root, with the temp base
 * resolved first, so the only link layer is the one the test creates.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readOnlyDelegationToolRefusal } from "../../src/agents/readonly-delegation.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type ToolEvaluatorContext,
} from "../../src/permissions/evaluator.js";
import { checkToolPathPermission } from "../../src/permissions/path-validation.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "../../src/planning/plan-files.js";
import { sessionPlanFileAuthority } from "../../src/planning/session-plan-authority.js";
import type { Session } from "../../src/session/session.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";

type Operation = "read" | "write";
type Spelling = "through the link" | "by its real path";

const RULE_TOOL: Record<Operation, string> = { read: "FileRead", write: "Write" };

let base = "";
let project = "";
let real = "";
let alias = "";

beforeEach(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), "agenc-symlinked-rule-"));
  project = join(base, "project");
  real = join(base, "real");
  alias = join(base, "alias");
  await mkdir(project);
  await mkdir(real);
  await writeFile(join(real, "secret.txt"), "secret", "utf8");
  await symlink(real, alias);
});

afterEach(async () => {
  clearAllPlanSlugs();
  await rm(base, { recursive: true, force: true });
});

function withRule(
  mode: PermissionMode,
  behavior: "allow" | "ask" | "deny",
  operation: Operation,
  ruleContent: string,
): ToolPermissionContext {
  return applyPermissionUpdate(createEmptyToolPermissionContext({ mode }), {
    type: "addRules",
    destination: "session",
    behavior,
    rules: [{ toolName: RULE_TOOL[operation], ruleContent }],
  });
}

function check(path: string, context: ToolPermissionContext, operation: Operation) {
  return checkToolPathPermission({
    toolName: RULE_TOOL[operation],
    input: { file_path: path },
    path,
    cwd: project,
    context,
    operationType: operation,
  });
}

function evaluatorContext(
  toolPermissionContext: ToolPermissionContext,
  session: object = {},
): ToolEvaluatorContext {
  return attachContextDefaults({
    session: session as Session,
    getAppState: () => ({
      toolPermissionContext,
      denialTracking: freshDenialTracking(),
      autoModeActive: false,
    }),
  } as ToolEvaluatorContext);
}

/** The secret file, spelled through the symlinked directory or by its real path. */
function secret(spelling: Spelling): string {
  return join(spelling === "through the link" ? alias : real, "secret.txt");
}

/** Rules written against the symlinked directory: the exact file, or its subtree. */
const RULES = {
  exact: () => join(alias, "secret.txt"),
  subtree: () => `${alias}/**`,
} as const;

const MODES = ["default", "bypassPermissions"] as const;
const OPERATIONS = ["read", "write"] as const;
const RULE_KINDS = ["exact", "subtree"] as const;
const SPELLINGS: readonly Spelling[] = ["through the link", "by its real path"];

const ruleCases = OPERATIONS.flatMap((operation) =>
  RULE_KINDS.flatMap((rule) =>
    SPELLINGS.map((target) => ({ operation, rule, target })),
  ),
);

describe("a rule written through a symlinked directory", () => {
  test.each(MODES.flatMap((mode) => ruleCases.map((row) => ({ mode, ...row }))))(
    "denies a $operation of the file $target ($rule rule, $mode)",
    ({ mode, operation, rule, target }) => {
      const result = check(
        secret(target),
        withRule(mode, "deny", operation, RULES[rule]()),
        operation,
      );

      expect(result.behavior).toBe("deny");
      expect(result.decisionReason).toMatchObject({
        type: "rule",
        rule: { ruleBehavior: "deny" },
      });
    },
  );

  test.each(ruleCases)(
    "asks by the rule for a $operation of the file $target ($rule rule)",
    ({ operation, rule, target }) => {
      const result = check(
        secret(target),
        withRule("default", "ask", operation, RULES[rule]()),
        operation,
      );

      expect(result.behavior).toBe("ask");
      expect(result.decisionReason).toMatchObject({
        type: "rule",
        rule: { ruleBehavior: "ask" },
      });
    },
  );

  test("denies a file reached through a relative rule whose folder links out of the workspace", async () => {
    await symlink(real, join(project, "vendor"));

    for (const mode of MODES) {
      const context = withRule(mode, "deny", "read", "./vendor/**");
      for (const target of [join(project, "vendor", "secret.txt"), secret("by its real path")]) {
        expect(check(target, context, "read").behavior, `${mode} ${target}`).toBe("deny");
      }
    }
  });
});

describe("hasPermissionsToUseTool with a rule written through a symlinked directory", () => {
  const tools = {
    FileRead: {
      operation: "read",
      tool: () => createFileReadTool({ allowedPaths: [project] }),
      input: (filePath: string) => ({ file_path: filePath, cwd: project }),
    },
    Write: {
      operation: "write",
      tool: () => createFileWriteTool({ allowedPaths: [project] }),
      input: (filePath: string) => ({ file_path: filePath, content: "x", cwd: project }),
    },
  } as const;

  const toolCases = (["FileRead", "Write"] as const).flatMap((name) =>
    SPELLINGS.map((target) => ({ name, target })),
  );

  test.each(MODES.flatMap((mode) => toolCases.map((row) => ({ mode, ...row }))))(
    "$name is denied under $mode for the file $target",
    async ({ name, mode, target }) => {
      const { operation, tool, input } = tools[name];
      const context = evaluatorContext(withRule(mode, "deny", operation, RULES.subtree()));

      const result = await hasPermissionsToUseTool(tool(), input(secret(target)), context);

      expect(result.behavior).toBe("deny");
      expect(result.decisionReason).toMatchObject({ type: "rule", rule: { ruleBehavior: "deny" } });
    },
  );

  test.each(toolCases)(
    "$name asks by the rule for the file $target",
    async ({ name, target }) => {
      const { operation, tool, input } = tools[name];
      const context = evaluatorContext(withRule("default", "ask", operation, RULES.subtree()));

      const result = await hasPermissionsToUseTool(tool(), input(secret(target)), context);

      expect(result.behavior).toBe("ask");
      expect(result.decisionReason).toMatchObject({ type: "rule", rule: { ruleBehavior: "ask" } });
    },
  );

  // bypassPermissions keeps a path ask rule on the owning session plan file,
  // so that file shows the ask matching under the mode.
  test("keeps an ask on the session plan file under bypassPermissions when AGENC_HOME is written through a link", async () => {
    const home = join(base, "home");
    const homeAlias = join(base, "home-alias");
    await mkdir(home);
    await symlink(home, homeAlias);
    const session = {
      conversationId: "symlinked-home-session",
      services: { configStore: { homeContext: { path: home } } },
    };
    setPlanSlug({ sessionId: session.conversationId, agencHome: home }, "linked-home-plan");
    const planPath = getPlanFilePath({ sessionId: session.conversationId, agencHome: home });
    const permissions = withRule(
      "bypassPermissions",
      "ask",
      "write",
      join(homeAlias, relative(home, planPath)),
    );

    const direct = checkToolPathPermission({
      toolName: "Write",
      input: { file_path: planPath },
      path: planPath,
      cwd: project,
      context: permissions,
      operationType: "write",
      planFileAuthority: sessionPlanFileAuthority(session),
    });
    const endToEnd = await hasPermissionsToUseTool(
      tools.Write.tool(),
      tools.Write.input(planPath),
      evaluatorContext(permissions, session),
    );

    for (const result of [direct, endToEnd]) {
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason).toMatchObject({ type: "rule", rule: { ruleBehavior: "ask" } });
    }
  });
});

describe("read-only delegation with a symlinked directory", () => {
  function delegatedSession(cwd: string, context: ToolPermissionContext, deniedRules: string[] = []) {
    return {
      conversationId: "delegated-reader",
      sessionConfiguration: { cwd },
      services: { readOnlyDelegation: { kind: "read-only", ownerThreadId: "owner", deniedRules } },
      permissionModeRegistry: { current: () => context },
    } as unknown as Session;
  }

  function reader() {
    return buildToolRegistry({ workspaceRoot: project, requireAdmission: false })
      .tools.find((tool) => tool.name === "FileRead")!;
  }

  test("keeps an inherited deny written through the link when the file is read by its real path", () => {
    const session = delegatedSession(
      real,
      createEmptyToolPermissionContext({ mode: "bypassPermissions" }),
      [`FileRead(${RULES.subtree()})`],
    );

    expect(readOnlyDelegationToolRefusal(session, reader(), { file_path: secret("by its real path") }))
      .toMatch(/cannot read/);
  });

  test("does not let an allow follow a link out of the allowed directory", async () => {
    const allowed = join(base, "allowed");
    await mkdir(allowed);
    await symlink(real, join(allowed, "link"));
    const session = delegatedSession(project, withRule("default", "allow", "read", `${allowed}/**`));

    expect(readOnlyDelegationToolRefusal(session, reader(), { file_path: join(allowed, "link", "secret.txt") }))
      .toMatch(/cannot read/);
    await writeFile(join(allowed, "notes.txt"), "notes", "utf8");
    expect(readOnlyDelegationToolRefusal(session, reader(), { file_path: join(allowed, "notes.txt") }))
      .toBeUndefined();
  });
});

describe("a write through a dangling link lands at its last target", () => {
  let outside = "";

  beforeEach(async () => {
    outside = join(base, "outside");
    await mkdir(outside);
    // project/hop -> project/next -> outside/planted.txt, which does not exist.
    await symlink(join(outside, "planted.txt"), join(project, "next"));
    await symlink(join(project, "next"), join(project, "hop"));
  });

  test.each(["hop", "next"])("an allow for the project does not cover a write through %s", (link) => {
    const result = check(join(project, link), withRule("default", "allow", "write", `${project}/**`), "write");

    expect(result.behavior).toBe("ask");
    expect(result.decisionReason?.type).toBe("workingDir");
  });

  test("acceptEdits does not treat a two-link chain out of the project as a workspace write", () => {
    const result = check(
      join(project, "hop"),
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
      "write",
    );

    expect(result.behavior).toBe("ask");
  });

  test("a deny on the last target holds under bypassPermissions", () => {
    const result = check(
      join(project, "hop"),
      withRule("bypassPermissions", "deny", "write", `${outside}/**`),
      "write",
    );

    expect(result.behavior).toBe("deny");
  });
});
