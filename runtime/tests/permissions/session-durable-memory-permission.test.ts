import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOnlyDelegationPathAllowed } from "../../src/agents/readonly-delegation.js";
import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  buildProjectMemoryDirectory,
  getAutoMemPath,
  getGlobalMemoryPath,
} from "../../src/memory/paths.js";
import type { ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import {
  resolveAutoMemoryDirectory,
  resolveGlobalMemoryDirectory,
} from "../../src/services/extractMemories/memory-paths.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";
import {
  createFileEditTool,
  createFileMultiEditTool,
} from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createNotebookEditTool } from "../../src/tools/system/notebook-edit.js";
import type { Tool } from "../../src/tools/types.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { mkSession } from "../fixtures.js";

/**
 * A daemon serves sessions of many projects from its own working directory,
 * so the process-wide project memory directory is the daemon's, not the
 * session's. The session's memory prompt and the runtime sandbox resolve the
 * memory directories from the session; the file tools' permission checks
 * resolved them from the process. In the release gate (scenario 8) a project
 * memory save in default mode therefore showed an ordinary approval card
 * ("outside allowed working directories") while a global memory save showed
 * none. The checks now take the session's directories, so both are memory
 * files under the same rules: allowed unless an ask rule names them, with
 * deny rules, a cowork override and auto memory off kept.
 */
let root: string;
let cwd: string;
let home: string;
let daemonDir: string;
let previousAgencHome: string | undefined;
let previousProjectRoot: string;
let processAuthority: ConfigStore;
const sessions: Session[] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-session-memory-permission-"));
  cwd = join(root, "project");
  home = join(root, "home");
  daemonDir = join(root, "daemon-home");
  for (const dir of [cwd, home, daemonDir]) mkdirSync(dir);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  previousProjectRoot = getProjectRoot();
  // The daemon process starts in its own directory, not in the session's,
  // with the same AgenC home.
  setProjectRoot(daemonDir);
  processAuthority = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: daemonDir });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.shutdown();
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

async function daemonSession(
  runtimeOptions: Record<string, unknown> = {},
  cliOverrides?: Record<string, unknown>,
): Promise<Session> {
  const configStore = new ConfigStore({
    home,
    env: { AGENC_HOME: home },
    cwd,
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
  if (cliOverrides !== undefined) await configStore.reload();
  const session = mkSession({ cwd, services: { configStore,
    runtimeOptions: { ...resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: root }), ...runtimeOptions },
  } }).session;
  sessions.push(session);
  return session;
}

function evaluatorContext(
  session: unknown,
  permissions: ToolPermissionContext = createEmptyToolPermissionContext(),
): ToolEvaluatorContext {
  return {
    getAppState: () => ({
      toolPermissionContext: permissions,
      denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
      autoModeActive: false,
    }),
    session,
  } as ToolEvaluatorContext;
}

/** The project memory directory this session's memory prompt names. */
function projectMemory(): string {
  return buildProjectMemoryDirectory(home, cwd);
}

/** The directories the memory prompt of `session` names (resolveMemoryPromptInputs). */
async function promptedMemoryDirectories(session: Session) {
  const owner = {
    cwd,
    configStore: session.services.configStore,
    env: {},
    runtimeOptions: { remoteMode: false, ...session.services.runtimeOptions },
  } as Parameters<typeof resolveAutoMemoryDirectory>[0];
  return {
    project: (await resolveAutoMemoryDirectory(owner)).path,
    global: await resolveGlobalMemoryDirectory(owner),
  };
}

async function check(tool: Tool, input: Record<string, unknown>, context: ToolEvaluatorContext) {
  return await tool.checkPermissions!(input, context);
}

const MEMORY_FILES = { type: "other", reason: "durable memory files" };

/** A test whose process-wide settings are the daemon's. */
function inDaemon(name: string, body: () => Promise<void>): void {
  it(name, () => runWithCanonicalSettingsAuthority(processAuthority, body));
}

describe("file tool permissions for the memory files of a daemon session", () => {
  inDaemon("lets a project memory save through without a card, the same as a global one", async () => {
    const session = await daemonSession();
    // The prompt names these; the process-wide project directory is the
    // daemon's own project's, while the global one is the same.
    expect(await promptedMemoryDirectories(session)).toEqual({
      project: projectMemory(),
      global: join(home, "memory") + sep,
    });
    expect(getAutoMemPath()).not.toBe(projectMemory());
    expect(getGlobalMemoryPath()).toBe(join(home, "memory") + sep);
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    for (const target of [
      join(getGlobalMemoryPath(), "indentation.md"),
      join(projectMemory(), "project-codename.md"),
      join(projectMemory(), "MEMORY.md"),
    ]) {
      expect(
        await check(write, { file_path: target, content: "note", cwd }, evaluatorContext(session)),
        target,
      ).toMatchObject({ behavior: "allow", decisionReason: MEMORY_FILES });
    }
  });

  inDaemon("hands the Write tool what it needs to save the file", async () => {
    const session = await daemonSession();
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    const target = join(projectMemory(), "project-codename.md");
    const decision = await check(write, { file_path: target, content: "Codename: Bluefin.\n", cwd }, evaluatorContext(session));
    expect(decision.behavior).toBe("allow");
    const result = await write.execute(
      (decision as { updatedInput: Record<string, unknown> }).updatedInput,
    );
    expect(result.isError ?? false, String(result.content)).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("Codename: Bluefin.\n");
  });

  inDaemon("lets a project memory read through without a card, the same as a global one", async () => {
    const session = await daemonSession();
    const read = createFileReadTool({ allowedPaths: [cwd] });
    for (const target of [
      join(getGlobalMemoryPath(), "MEMORY.md"),
      join(projectMemory(), "MEMORY.md"),
    ]) {
      expect(
        await check(read, { file_path: target, cwd }, evaluatorContext(session)),
        target,
      ).toMatchObject({ behavior: "allow", decisionReason: MEMORY_FILES });
    }
    expect(readOnlyDelegationPathAllowed(session, join(getGlobalMemoryPath(), "MEMORY.md"))).toBe(true);
    expect(readOnlyDelegationPathAllowed(session, join(projectMemory(), "MEMORY.md"))).toBe(true);
  });

  inDaemon("treats project memory the same in every file tool", async () => {
    const session = await daemonSession();
    const context = evaluatorContext(session);
    const dir = projectMemory();
    const cases: Array<[Tool, Record<string, unknown>]> = [
      [createFileEditTool({ allowedPaths: [cwd] }),
        { file_path: join(dir, "a.md"), old_string: "", new_string: "x", cwd }],
      [createFileEditTool({ allowedPaths: [cwd] }),
        { file_path: join(dir, "a.md"), old_string: "x", new_string: "y", cwd }],
      [createFileMultiEditTool({ allowedPaths: [cwd] }),
        { file_path: join(dir, "a.md"), edits: [{ old_string: "x", new_string: "y" }], cwd }],
      [createNotebookEditTool({ workspaceRoot: cwd }),
        { notebook_path: join(dir, "notes.ipynb"), new_source: "x" }],
      [createApplyPatchTool({ cwd, allowedPaths: [cwd] }),
        { input: `*** Begin Patch\n*** Add File: ${join(dir, "b.md")}\n+note\n*** End Patch`, cwd }],
    ];
    for (const [tool, input] of cases) {
      expect(await check(tool, input, context), `${tool.name} ${JSON.stringify(input)}`)
        .toMatchObject({ behavior: "allow" });
    }
  });

  inDaemon("allows memory deletion without approval but keeps explicit deny rules", async () => {
    const session = await daemonSession();
    const patch = createApplyPatchTool({ cwd, allowedPaths: [cwd] });
    const target = join(projectMemory(), "forget-me.md");
    const input = { input: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`, cwd };
    expect((await check(patch, input, evaluatorContext(session))).behavior).toBe("allow");
    const permissions = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules", destination: "session", behavior: "deny",
      rules: [{ toolName: "apply_patch", ruleContent: target }],
    });
    expect((await check(patch, input, evaluatorContext(session, permissions))).behavior).toBe("deny");
  });

  inDaemon("keeps deny and ask rules on memory files", async () => {
    const session = await daemonSession();
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    const read = createFileReadTool({ allowedPaths: [cwd] });
    const target = join(projectMemory(), "project-codename.md");
    for (const behavior of ["deny", "ask"] as const) {
      const permissions = applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules",
        destination: "session",
        behavior,
        rules: [{ toolName: "Write", ruleContent: target }, { toolName: "FileRead", ruleContent: target }],
      });
      expect(
        (await check(write, { file_path: target, content: "x", cwd }, evaluatorContext(session, permissions))).behavior,
      ).toBe(behavior);
      expect(
        (await check(read, { file_path: target, cwd }, evaluatorContext(session, permissions))).behavior,
      ).toBe(behavior);
    }
    // An operator's deny on the whole directory, from managed policy.
    const operator = createEmptyToolPermissionContext({
      alwaysDenyRules: { policySettings: [`Write(${projectMemory()}**)`] },
    });
    expect(
      (await check(write, { file_path: target, content: "x", cwd }, evaluatorContext(session, operator))).behavior,
    ).toBe("deny");
  });

  inDaemon("gives no memory carve-out outside the session's own memory directories", async () => {
    const session = await daemonSession();
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    const other = join(root, "other-project");
    for (const [target, inputCwd] of [
      // The daemon's own project memory: not a directory this session was given.
      [join(getAutoMemPath(), "note.md"), cwd],
      // Another project's memory, also when the call names that project's cwd.
      [join(buildProjectMemoryDirectory(home, other), "note.md"), cwd],
      [join(buildProjectMemoryDirectory(home, other), "note.md"), other],
      // The rest of the AgenC home.
      [join(home, "config.toml"), cwd],
      [join(projectMemory(), "..", "notes.md"), cwd],
    ] as const) {
      const result = await check(write, { file_path: target, content: "x", cwd: inputCwd }, evaluatorContext(session));
      expect(result.behavior, target).not.toBe("allow");
      expect(result.decisionReason, target).not.toEqual(MEMORY_FILES);
    }
  });

  inDaemon("keeps a cowork override readable but not a write carve-out", async () => {
    const override = join(root, "cowork-memory");
    const session = await daemonSession({ coworkMemoryPathOverride: override });
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    const read = createFileReadTool({ allowedPaths: [cwd] });
    expect(
      await check(read, { file_path: join(override, "MEMORY.md"), cwd }, evaluatorContext(session)),
    ).toMatchObject({ behavior: "allow", decisionReason: MEMORY_FILES });
    for (const target of [join(override, "note.md"), join(getGlobalMemoryPath(), "note.md")]) {
      const result = await check(write, { file_path: target, content: "x", cwd }, evaluatorContext(session));
      expect(result.behavior, target).toBe("ask");
      expect(result.decisionReason, target).not.toEqual(MEMORY_FILES);
    }
  });

  inDaemon("treats nothing as memory when the session's auto memory is off", async () => {
    for (const session of [
      await daemonSession({ simpleMode: true }),
      await daemonSession({}, { autoMemoryEnabled: false }),
    ]) {
      const write = createFileWriteTool({ allowedPaths: [cwd] });
      const read = createFileReadTool({ allowedPaths: [cwd] });
      for (const target of [join(projectMemory(), "note.md"), join(getGlobalMemoryPath(), "note.md")]) {
        const written = await check(write, { file_path: target, content: "x", cwd }, evaluatorContext(session));
        expect(written.behavior, target).toBe("ask");
        const readResult = await check(read, { file_path: target, cwd }, evaluatorContext(session));
        expect(readResult.behavior, target).toBe("ask");
        expect(readResult.decisionReason, target).not.toEqual(MEMORY_FILES);
      }
    }
  });

  inDaemon("keeps the process-wide directories for a caller without a session", async () => {
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    expect(
      await check(write, { file_path: join(getAutoMemPath(), "note.md"), content: "x", cwd }, evaluatorContext({})),
    ).toMatchObject({ behavior: "allow", decisionReason: MEMORY_FILES });
  });
});
