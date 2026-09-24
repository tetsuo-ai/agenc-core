/**
 * A scheduled routine that carries acceptEdits or bypassPermissions runs with
 * that mode and nobody attached to approve anything. What the mode allows
 * proceeds; what would ask a person is refused instead of parking the run;
 * and file writes stay inside the routine's own workspace, which is never the
 * daemon's process folder.
 *
 * Every case uses a real run folder that is NOT `process.cwd()` and a
 * permission context with no directory grants, which is what the routine path
 * builds (see read-only-grant-daemon-cwd.test.ts for why that matters).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type ToolEvaluatorContext,
  type ToolLike,
} from "../../src/permissions/evaluator.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import { applyUnattendedPermissionPolicyToContext } from "../../src/permissions/unattended-policy.js";
import { createEmptyToolPermissionContext, type PermissionMode } from "../../src/permissions/types.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createFileEditTool } from "../../src/tools/system/file-edit.js";
import { createBashTool } from "../../src/tools/system/bash.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import type { Session } from "../../src/session/session.js";

let runFolder: string;
let outside: string;
const daemonFolder = resolve(process.cwd());

beforeAll(() => {
  runFolder = realpathSync(mkdtempSync(join(tmpdir(), "routine-no-approver-run-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "routine-no-approver-outside-")));
  mkdirSync(join(runFolder, "src"));
});
afterAll(() => {
  rmSync(runFolder, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function context(mode: PermissionMode, policy?: { readOnly: true }): ToolEvaluatorContext {
  // What the runner installs for a routine: the read-only grant for default
  // and plan, and for acceptEdits/bypass no approver plus the run's own
  // workspace as the only place its file writes may land.
  const permissions = applyUnattendedPermissionPolicyToContext(
    createEmptyToolPermissionContext({ mode }),
    (policy ?? { noApprover: true, workspaceRoots: [runFolder] }) as never,
  );
  const session = { conversationId: "routine-run", sessionConfiguration: { cwd: runFolder } } as unknown as Session;
  const denialTracking = freshDenialTracking();
  return attachContextDefaults({
    session,
    getAppState: () => ({ toolPermissionContext: permissions, denialTracking, autoModeActive: false }),
  });
}

const write = () => createFileWriteTool({ allowedPaths: [runFolder] }) as unknown as ToolLike;
const edit = () => createFileEditTool({ allowedPaths: [runFolder] } as never) as unknown as ToolLike;
const bash = () => createBashTool({ cwd: runFolder }) as unknown as ToolLike;
const exec = () => createExecCommandTool({ cwd: runFolder, allowedPaths: [runFolder] }) as unknown as ToolLike;
const interactive: ToolLike = {
  name: "AskUserQuestion", isReadOnly: true, requiresApproval: false,
  metadata: { source: "builtin", mutating: false }, requiresUserInteraction: () => true,
};

async function decide(tool: ToolLike, input: Record<string, unknown>, ctx: ToolEvaluatorContext) {
  return hasPermissionsToUseTool(tool, input, ctx);
}

describe("routine run without an approver", () => {
  it("runs in a folder the daemon process is not in", () => {
    expect(runFolder).not.toBe(daemonFolder);
    expect(outside).not.toBe(daemonFolder);
  });

  it.each(["bypassPermissions", "acceptEdits"] as const)("lets %s write inside the routine's workspace", async (mode) => {
    for (const tool of [write()]) {
      const decision = await decide(tool, { file_path: join(runFolder, "ticks.txt"), content: "tick\n" }, context(mode));
      expect(decision.behavior, tool.name).toBe("allow");
    }
    const decision = await decide(edit(), { file_path: join(runFolder, "notes.md"), old_string: "a", new_string: "b" }, context(mode));
    expect(decision.behavior).toBe("allow");
  });

  it.each(["bypassPermissions", "acceptEdits"] as const)("refuses %s writes outside the workspace, the daemon folder included, without asking", async (mode) => {
    for (const target of [join(outside, "escape.txt"), join(daemonFolder, "routine-escape-probe.txt"), "/etc/routine-escape-probe"]) {
      const decision = await decide(write(), { file_path: target, content: "x" }, context(mode));
      expect(decision.behavior, target).toBe("deny");
      expect("message" in decision ? decision.message : "", target).toMatch(/inside its workspace|nobody attached/u);
    }
  });

  it.each(["bypassPermissions", "acceptEdits"] as const)("refuses %s writes through a link that leads out of the workspace, dangling or not", async (mode) => {
    // File tools write in the daemon's own process, outside the OS sandbox, so
    // this check must measure where a write lands: through a link, at the
    // link's target, whether or not that target exists yet. A link can come
    // with the project or from the run's own shell.
    const links = realpathSync(mkdtempSync(join(runFolder, "links-")));
    writeFileSync(join(outside, "existing.txt"), "outside");
    symlinkSync(outside, join(links, "to-outside"), "dir");
    symlinkSync(join(outside, "existing.txt"), join(links, "to-existing"));
    symlinkSync(join(outside, "created-through-link.txt"), join(links, "dangling"));
    // Relative to the link's folder: up to the temp folder, then into `outside`.
    symlinkSync(`../../${basename(outside)}/relative.txt`, join(links, "dangling-relative"));
    symlinkSync(join(outside, "missing-dir", "deeper.txt"), join(links, "dangling-deeper"));
    symlinkSync(join(links, "dangling"), join(links, "chain"));
    for (const target of [
      join(links, "to-outside", "escape.txt"),
      join(links, "to-existing"),
      join(links, "dangling"),
      join(links, "dangling-relative"),
      join(links, "dangling-deeper"),
      join(links, "chain"),
      // `..` after a link is resolved where the link points, as the OS does.
      `${join(links, "to-outside")}/../escape.txt`,
    ]) {
      const decision = await decide(write(), { file_path: target, content: "x" }, context(mode));
      expect(decision.behavior, target).toBe("deny");
      expect("message" in decision ? decision.message : "", target).toMatch(/inside its workspace/u);
    }
  });

  it("still lets bypass write through a link that stays inside the workspace", async () => {
    const links = realpathSync(mkdtempSync(join(runFolder, "inner-links-")));
    mkdirSync(join(links, "real"));
    symlinkSync(join(links, "real"), join(links, "alias"), "dir");
    symlinkSync(join(links, "real", "new.txt"), join(links, "dangling-inside"));
    for (const target of [join(links, "alias", "file.txt"), join(links, "dangling-inside")]) {
      expect((await decide(write(), { file_path: target, content: "x" }, context("bypassPermissions"))).behavior, target).toBe("allow");
    }
  });

  it.each(["bypassPermissions", "acceptEdits"] as const)("refuses a tool that needs a person in %s instead of asking", async (mode) => {
    const decision = await decide(interactive, { questions: [] }, context(mode));
    expect(decision.behavior).toBe("deny");
    expect("message" in decision ? decision.message : "").toContain("nobody attached");
  });

  it("lets bypass run any shell command without asking; the OS sandbox confines its writes", async () => {
    for (const cmd of ["npm install", "date >> ticks.txt", `touch ${join(outside, "x")}`]) {
      expect((await decide(exec(), { cmd }, context("bypassPermissions"))).behavior, cmd).toBe("allow");
    }
  });

  it("keeps acceptEdits to workspace edits: a read-only command in the folder proceeds, anything needing approval is refused", async () => {
    expect((await decide(exec(), { cmd: "git status" }, context("acceptEdits"))).behavior).toBe("allow");
    expect((await decide(exec(), { cmd: "ls src" }, context("acceptEdits"))).behavior).toBe("allow");
    for (const cmd of ["npm install", `cat ${join(outside, "secret")}`, "curl https://example.com"]) {
      const decision = await decide(exec(), { cmd }, context("acceptEdits"));
      expect(decision.behavior, cmd).toBe("deny");
    }
  });

  it("measures acceptEdits shell work against the routine's folder, not the daemon's", async () => {
    // Core asks before any shell command in acceptEdits (only file edits are
    // prompt-free), so with nobody attached a mutating command is refused ...
    for (const command of ["mkdir build", `touch ${join(runFolder, "x")}`, `mkdir ${join(daemonFolder, "routine-escape-probe")}`]) {
      expect((await decide(bash(), { command }, context("acceptEdits"))).behavior, command).toBe("deny");
    }
    // ... while reading this routine's folder proceeds and reading the
    // daemon's own folder does not: it is not this run's working directory.
    expect((await decide(exec(), { cmd: "ls src" }, context("acceptEdits"))).behavior).toBe("allow");
    expect((await decide(bash(), { command: `cat ${join(daemonFolder, "package.json")}` }, context("acceptEdits"))).behavior).toBe("deny");
    expect((await decide(exec(), { cmd: `cat ${join(daemonFolder, "package.json")}` }, context("acceptEdits"))).behavior).toBe("deny");
  });

  it.each(["bypassPermissions", "acceptEdits"] as const)("refuses %s shell calls that ask to leave the OS sandbox", async (mode) => {
    for (const [tool, input] of [
      [exec(), { cmd: "touch escaped", sandbox_permissions: "require_escalated", justification: "needed" }],
      [exec(), { cmd: "touch escaped", sandbox_permissions: "with_additional_permissions", additional_permissions: { file_system: { write: [outside] } } }],
      [bash(), { command: "touch escaped", dangerouslyDisableSandbox: true }],
    ] as const) {
      const decision = await decide(tool, input as Record<string, unknown>, context(mode));
      expect(decision.behavior, JSON.stringify(input)).toBe("deny");
      expect("message" in decision ? decision.message : "").toContain("outside the OS sandbox");
    }
  });

  it("refuses an MCP server's request for more permissions even in bypass", async () => {
    const requestPermissions: ToolLike = { name: "mcp.remote.request_permissions", requiresApproval: false, metadata: { source: "mcp" } };
    for (const mode of ["bypassPermissions", "acceptEdits"] as const) {
      expect((await decide(requestPermissions, { permissions: {} }, context(mode))).behavior).toBe("deny");
    }
  });

  it("never returns ask for any tool while no approver is attached", async () => {
    const calls: Array<[ToolLike, Record<string, unknown>]> = [
      [write(), { file_path: join(outside, "a"), content: "" }],
      [exec(), { cmd: "npm test" }],
      [bash(), { command: "rm -rf /" }],
      [interactive, {}],
      [{ name: "mcp.remote.post", requiresApproval: true, metadata: { source: "mcp", mutating: true } }, { text: "hi" }],
    ];
    for (const mode of ["acceptEdits", "bypassPermissions"] as const) {
      for (const [tool, input] of calls) {
        expect((await decide(tool, input, context(mode))).behavior, `${mode} ${tool.name}`).not.toBe("ask");
      }
    }
  });

  it("leaves default and plan routines on the read-only grant", async () => {
    for (const mode of ["default", "plan"] as const) {
      const ctx = context(mode, { readOnly: true });
      expect((await decide(write(), { file_path: join(runFolder, "ticks.txt"), content: "tick" }, ctx)).behavior).toBe("deny");
      expect((await decide(exec(), { cmd: "git status" }, ctx)).behavior).toBe("allow");
    }
  });
});
