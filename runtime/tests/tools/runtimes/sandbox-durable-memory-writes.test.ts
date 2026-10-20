import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../../src/bootstrap/state.js";
import { ConfigStore } from "../../../src/config/store.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import { buildProjectMemoryDirectory, getAutoMemPath } from "../../../src/memory/paths.js";
import {
  resolveAutoMemoryDirectory,
  resolveGlobalMemoryDirectory,
} from "../../../src/services/extractMemories/memory-paths.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import { enforceRuntimeSandboxAttempt } from "../../../src/tools/runtimes/sandboxing.js";
import type { Tool } from "../../../src/tools/types.js";
import { mkCtx, mkSession } from "../../fixtures.js";

/**
 * The memory prompt points the model at `$AGENC_HOME/memory/` and the
 * project memory directory, both outside the workspace, and the permission
 * layer and the file tools admit exactly those roots. The runtime sandbox
 * check did not: under workspace_write every Write there failed with
 * "sandbox workspace_write blocked write outside workspace", so durable
 * memory was unusable in a daemon session and the model fell back to a
 * shell redirect with elevated permissions.
 */
let root: string;
let cwd: string;
let home: string;
let session: ReturnType<typeof mkSession>["session"];
let previousAgencHome: string | undefined;
let previousProjectRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-sandbox-memory-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  previousProjectRoot = getProjectRoot();
  setProjectRoot(cwd);
  const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
  // Exercise an ambient writable temp ancestor that also contains AgenC home.
  // Home protection must survive this grant while the narrow memory exception
  // continues to honor the operator's explicit denies.
  session = mkSession({ cwd, services: { configStore,
    runtimeOptions: resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: root }),
  } }).session;
});

afterEach(async () => {
  await session.shutdown();
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

/**
 * The directories this session's memory prompt names (system-prompt.ts
 * resolveMemoryPromptInputs): resolved from the session, the way the model
 * learns where to write.
 */
async function promptedMemoryDirectories(runtimeOptions: Record<string, unknown> = {}) {
  const owner = {
    cwd,
    configStore: session.services.configStore,
    env: {},
    runtimeOptions: { remoteMode: false, ...session.services.runtimeOptions, ...runtimeOptions },
  } as Parameters<typeof resolveAutoMemoryDirectory>[0];
  const project = await resolveAutoMemoryDirectory(owner);
  const global = await resolveGlobalMemoryDirectory(owner);
  return { project: project.path!, global: global! };
}

function attempt(
  tool: Tool,
  args: Record<string, unknown>,
  fileSystemSandboxPolicy: {
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  },
): () => void {
  const turn = mkCtx({
    cwd,
    fileSystemSandboxPolicy: { ...fileSystemSandboxPolicy, allowRead: [], denyRead: [] },
  } as never);
  return () =>
    enforceRuntimeSandboxAttempt({
      tool,
      args,
      context: {
        callId: "memory-sandbox", toolName: tool.name, runtimeKind: "function",
        classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
        source: "direct", submittedAtMs: 0, approvalPolicy: "never",
        requestedSandboxMode: "workspace_write", sandboxMode: "workspace_write",
        approvalResolved: false, rawArgs: "{}",
        invocation: {
          session, turn,
          tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
          callId: "memory-sandbox", toolName: { name: tool.name },
          payload: { kind: "function", arguments: "{}" }, source: "direct",
        },
      } as never,
    });
}

describe("durable memory writes under the workspace_write sandbox", () => {
  it("lets the Write tool create files under both durable memory roots", async () => {
    const { project, global } = await promptedMemoryDirectories();
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    for (const target of [
      join(global, "indentation.md"),
      join(global, "MEMORY.md"),
      join(project, "project-note.md"),
    ]) {
      expect(
        attempt(tool, { file_path: target, content: "note" }, { allowWrite: [cwd], denyWrite: [] }),
        target,
      ).not.toThrow();
    }
  });

  it("still blocks the rest of the AgenC home and honors an explicit deny", async () => {
    const { global } = await promptedMemoryDirectories();
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    expect(
      attempt(tool, { file_path: join(home, "config.toml"), content: "x" }, { allowWrite: [cwd], denyWrite: [] }),
    ).toThrow(/blocked write outside workspace/);
    const memoryFile = join(global, "indentation.md");
    expect(
      attempt(tool, { file_path: memoryFile, content: "x" }, { allowWrite: [cwd], denyWrite: [global] }),
    ).toThrow(/blocked/);
  });

  it("does not extend the carve-out to a shell redirect into the memory root", async () => {
    const { global } = await promptedMemoryDirectories();
    const shell = { ...createFileWriteTool({ allowedPaths: [cwd] }), name: "system.bash" } as unknown as Tool;
    const memoryFile = join(global, "indentation.md");
    expect(
      attempt(shell, { command: `printf note > ${memoryFile}` }, { allowWrite: [cwd], denyWrite: [] }),
    ).toThrow(/blocked/);
  });
});

/**
 * A daemon serves sessions of many projects from its own working directory,
 * so the process-wide project root names the daemon's project, not the
 * session's. The session's memory prompt resolves the project memory
 * directory from the session (its ConfigStore and cwd), and the model writes
 * there. The runtime sandbox resolved it from the process: in the release
 * gate (scenario 8, "memory-new-session") every memory save was refused with
 * "sandbox workspace_write blocked write outside workspace:
 * <home>/projects/<workspace key>/memory/project-codename.md", which since the
 * separate run-without-sandbox question became a second card for a routine
 * save. The session's own memory directories are admitted now, and nothing
 * else.
 */
describe("durable memory writes of a daemon session whose process works elsewhere", () => {
  let daemonDir: string;

  beforeEach(() => {
    daemonDir = join(root, "daemon-home");
    mkdirSync(daemonDir);
    // The daemon process starts in its own directory, not in the session's.
    setProjectRoot(daemonDir);
  });

  it("admits a Write to the project memory directory the session's memory prompt names", async () => {
    const { project, global } = await promptedMemoryDirectories();
    expect(project).toBe(buildProjectMemoryDirectory(home, cwd));
    // The process-wide directory is the daemon's own project's, not this one.
    expect(getAutoMemPath()).not.toBe(project);
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    for (const target of [
      join(project, "project-codename.md"),
      join(project, "MEMORY.md"),
      join(global, "indentation.md"),
    ]) {
      expect(
        attempt(tool, { file_path: target, content: "note" }, { allowWrite: [cwd], denyWrite: [] }),
        target,
      ).not.toThrow();
    }
  });

  it("keeps every other path refused", async () => {
    const { project } = await promptedMemoryDirectories();
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    for (const target of [
      // The daemon's own project memory: not a directory this session was given.
      join(getAutoMemPath(), "note.md"),
      // Another project's memory, the rest of the home, the session store.
      join(buildProjectMemoryDirectory(home, join(root, "other-project")), "note.md"),
      join(home, "config.toml"),
      join(home, "projects", "v2-x-0", "sessions", "rollout.jsonl"),
      join(project, "..", "notes.md"),
    ]) {
      expect(
        attempt(tool, { file_path: target, content: "x" }, { allowWrite: [cwd], denyWrite: [] }),
        target,
      ).toThrow(/blocked write outside workspace/);
    }
    // An operator deny on the memory directory still wins.
    expect(
      attempt(tool, { file_path: join(project, "note.md"), content: "x" }, { allowWrite: [cwd], denyWrite: [project] }),
    ).toThrow(/blocked/);
    // A shell redirect gets no memory carve-out.
    const shell = { ...createFileWriteTool({ allowedPaths: [cwd] }), name: "system.bash" } as unknown as Tool;
    expect(
      attempt(shell, { command: `printf note > ${join(project, "note.md")}` }, { allowWrite: [cwd], denyWrite: [] }),
    ).toThrow(/blocked/);
  });

  it("admits nothing when the session's auto memory is off or a cowork override moved it", async () => {
    const { project } = await promptedMemoryDirectories();
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    const target = join(project, "note.md");
    for (const runtimeOptions of [
      { simpleMode: true },
      { coworkMemoryPathOverride: join(root, "cowork-memory") },
    ]) {
      const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
      const other = mkSession({ cwd, services: { configStore,
        runtimeOptions: { ...resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: root }), ...runtimeOptions },
      } }).session;
      try {
        const turn = mkCtx({ cwd, fileSystemSandboxPolicy: { allowWrite: [cwd], denyWrite: [], allowRead: [], denyRead: [] } } as never);
        expect(() => enforceRuntimeSandboxAttempt({
          tool,
          args: { file_path: target, content: "x" },
          context: {
            callId: "memory-sandbox", toolName: tool.name, runtimeKind: "function",
            classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
            source: "direct", submittedAtMs: 0, approvalPolicy: "never",
            requestedSandboxMode: "workspace_write", sandboxMode: "workspace_write",
            approvalResolved: false, rawArgs: "{}",
            invocation: {
              session: other, turn,
              tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
              callId: "memory-sandbox", toolName: { name: tool.name },
              payload: { kind: "function", arguments: "{}" }, source: "direct",
            },
          } as never,
        }), JSON.stringify(runtimeOptions)).toThrow(/blocked write outside workspace/);
      } finally {
        await other.shutdown();
      }
    }
  });
});
