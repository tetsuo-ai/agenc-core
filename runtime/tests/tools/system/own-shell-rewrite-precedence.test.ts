import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";
import { createFileEditTool } from "../../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { clearSessionReadState, SESSION_ID_ARG } from "../../../src/tools/system/filesystem.js";
import { changedFilesProducer } from "../../../src/prompts/attachments/changed-files.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../../src/unified-exec/process-manager.js";

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let n = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "heredoc-reread-")));
  session = `heredoc-reread-${process.pid}-${++n}`;
  manager = new UnifiedExecProcessManager({ cwd: root });
});
afterEach(async () => {
  await manager.closeAll("test_cleanup");
  clearSessionReadState(session, tmpdir());
  await rm(root, { recursive: true, force: true });
});

function exec(cmd: string) {
  const args: Record<string, unknown> = { cmd, [SESSION_ID_ARG]: session };
  attachToolRuntimeContext(args, {
    callId: "call-exec", toolName: "exec_command", runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access", approvalResolved: true,
    rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: "bypassPermissions" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn", cwd: root },
    },
  } as never);
  const tool = createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager });
  return bindExplicitDangerBoundary(tool).execute(args);
}

function attachments() {
  return changedFilesProducer({
    sessionKey: { sessionId: session }, userInput: null, loadedTools: [], messages: [],
    permissionContext: { mode: "default" } as never, cwd: root, subagentDepth: 0,
    signal: new AbortController().signal, agencHome: root,
  } as never, {} as never);
}

test("the documentation and edit guard agree that an earlier read takes precedence", async () => {
  const file = join(root, "a.js");
  await writeFile(file, "const a = 0;\n");
  await delay(20);
  expect((await createFileReadTool({ allowedPaths: [root] }).execute({ file_path: file, [SESSION_ID_ARG]: session })).isError).not.toBe(true);
  expect(await attachments()).toEqual([]);
  expect((await exec("cat > a.js <<'EOF'\nconst a = 1;\nEOF")).isError).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe("const a = 1;\n");
  const sent = await attachments();
  expect(sent.length).toBeGreaterThan(0);
  const edited = await createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string: "a = 1", new_string: "a = 2", cwd: root, [SESSION_ID_ARG]: session,
  });
  expect(edited.isError).toBe(true);
  expect(edited.content).toContain("File has been modified since read");
  expect(await readFile(file, "utf8")).toBe("const a = 1;\n");
  const documentation = await readFile(new URL("../../../src/tools/system/own-shell-changes.ts", import.meta.url), "utf8");
  expect(documentation).toContain("An existing read takes precedence");
});
