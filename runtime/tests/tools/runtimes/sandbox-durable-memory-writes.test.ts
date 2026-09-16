import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../../src/bootstrap/state.js";
import { ConfigStore } from "../../../src/config/store.js";
import { getAutoMemPath, getGlobalMemoryPath } from "../../../src/memory/paths.js";
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
  session = mkSession({ cwd, services: { configStore } }).session;
});

afterEach(async () => {
  await session.shutdown();
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

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
  it("lets the Write tool create files under both durable memory roots", () => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    for (const target of [
      join(getGlobalMemoryPath(), "indentation.md"),
      join(getGlobalMemoryPath(), "MEMORY.md"),
      join(getAutoMemPath(), "project-note.md"),
    ]) {
      expect(
        attempt(tool, { file_path: target, content: "note" }, { allowWrite: [cwd], denyWrite: [] }),
        target,
      ).not.toThrow();
    }
  });

  it("still blocks the rest of the AgenC home and honors an explicit deny", () => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    expect(
      attempt(tool, { file_path: join(home, "config.toml"), content: "x" }, { allowWrite: [cwd], denyWrite: [] }),
    ).toThrow(/blocked write outside workspace/);
    const memoryFile = join(getGlobalMemoryPath(), "indentation.md");
    expect(
      attempt(tool, { file_path: memoryFile, content: "x" }, { allowWrite: [cwd], denyWrite: [getGlobalMemoryPath()] }),
    ).toThrow(/blocked/);
  });

  it("does not extend the carve-out to a shell redirect into the memory root", () => {
    const shell = { ...createFileWriteTool({ allowedPaths: [cwd] }), name: "system.bash" } as unknown as Tool;
    const memoryFile = join(getGlobalMemoryPath(), "indentation.md");
    expect(
      attempt(shell, { command: `printf note > ${memoryFile}` }, { allowWrite: [cwd], denyWrite: [] }),
    ).toThrow(/blocked/);
  });
});
