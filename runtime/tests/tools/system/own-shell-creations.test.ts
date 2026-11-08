import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, test } from "vitest";

import { changedFilesProducer } from "../../prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../prompts/attachments/orchestrator.js";
import { createApplyPatchTool } from "../apply-patch/tool.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileWriteTool } from "./file-write.js";
import { clearSessionReadState, hasSessionRead, SESSION_ID_ARG } from "./filesystem.js";
import { resetPrintedOutputsForTest } from "./printed-read-proof.js";
import { unreadFilePreflight } from "./read-before-write.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";

// A file the session's own shell command created counts as read only when the
// model wrote its bytes in the command: a quoted here-document whose body equals
// the file (yacht32: an apply_patch of scripts/shots.mjs, made with
// `cat > scripts/shots.mjs <<'EOF'`, was refused as "not read yet"). A file a
// command made any other way (other output, a copy, another writer while the
// command ran) or changed still needs a read: the model has not seen its bytes.

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let counter = 0;
const sessions: string[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-created-")));
  session = `own-created-${process.pid}-${++counter}`;
  sessions.push(session);
  manager = new UnifiedExecProcessManager({ cwd: root });
  resetPrintedOutputsForTest();
});

afterEach(async () => {
  await manager.closeAll("test_cleanup");
  for (const id of sessions.splice(0)) clearSessionReadState(id, tmpdir());
  await rm(root, { recursive: true, force: true });
});

/** exec_command as the Light dispatcher runs it under bypassPermissions (no OS sandbox). */
function exec(cmd: string) {
  const args: Record<string, unknown> = { cmd, [SESSION_ID_ARG]: session };
  attachToolRuntimeContext(args, {
    callId: "call-exec_command", toolName: "exec_command", runtimeKind: "function", classification: "exclusive",
    supportsParallelToolCalls: false, source: { type: "model" }, submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "danger_full_access", sandboxMode: "danger_full_access", approvalResolved: true,
    rawArgs: "{}",
    invocation: {
      session: {
        permissionModeRegistry: { current: () => ({ mode: "bypassPermissions" }) },
        services: { runtimeOptions: { sessionTempRoot: root } },
      },
      payload: { kind: "function", arguments: "{}" },
      turn: { subId: "turn-own-created", cwd: root },
    },
  } as never);
  const tool = createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager });
  return bindExplicitDangerBoundary(tool).execute(args);
}

function edit(file: string, oldString: string, newString: string) {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string: oldString, new_string: newString, cwd: root, [SESSION_ID_ARG]: session,
  });
}

function write(file: string, content: string) {
  return createFileWriteTool({ allowedPaths: [root] }).execute({ file_path: file, content, [SESSION_ID_ARG]: session });
}

function patchArgs(patch: string) {
  return { input: patch, cwd: root, [SESSION_ID_ARG]: session };
}

const SHOTS = "import { chromium } from 'playwright';\nconst browser = await chromium.launch();\nawait browser.close();\n";
const CREATE_SHOTS = `mkdir -p scripts && cat > scripts/shots.mjs <<'EOF'\n${SHOTS}EOF\nwc -l scripts/shots.mjs`;
const SHOTS_PATCH = "*** Begin Patch\n*** Update File: scripts/shots.mjs\n@@\n-await browser.close();\n+await browser.close();\n+process.exit(0);\n*** End Patch";

const refusedAsUnread = (result: { isError?: boolean; content: unknown }): boolean =>
  result.isError === true && String(result.content).includes("File has not been read yet");

test("apply_patch of a file the session's own here-document created needs no read", async () => {
  const file = join(root, "scripts/shots.mjs");
  expect((await exec(CREATE_SHOTS)).isError).not.toBe(true);
  expect(hasSessionRead(session, file)).toBe(false);
  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  expect(patch.preflight?.(patchArgs(SHOTS_PATCH))).toBeNull();
  const applied = await patch.execute(patchArgs(SHOTS_PATCH));
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(`${SHOTS}process.exit(0);\n`);
});

test("a file made by a command's other output still needs a read", async () => {
  expect((await exec("printf 'const a = 1;\\n' > a.js && echo draft > notes.md && touch empty.txt")).isError)
    .not.toBe(true);
  expect(refusedAsUnread(await edit(join(root, "a.js"), "a = 1", "a = 2"))).toBe(true);
  expect(refusedAsUnread(await write(join(root, "notes.md"), "final\n"))).toBe(true);
  expect(refusedAsUnread(await write(join(root, "empty.txt"), "now filled\n"))).toBe(true);
  expect(await readFile(join(root, "a.js"), "utf8")).toBe("const a = 1;\n");
});

test("R1: a file another writer creates while a command of the session waits for it still needs a read", async () => {
  const result = join(root, "result.json");
  const running = exec("while [ ! -e result.json ]; do sleep 0.05; done; echo ready");
  await delay(300);
  await writeFile(result, '{"status":"theirs"}\n');
  expect(String((await running).content)).toContain("ready");
  expect(refusedAsUnread(await write(result, "{}\n"))).toBe(true);
  expect(await readFile(result, "utf8")).toBe('{"status":"theirs"}\n');
});

test("R2: a copy a command of the session made still needs a read", async () => {
  await writeFile(join(root, "src.txt"), "bytes the model never saw\n");
  expect((await exec("cp src.txt copy.txt")).isError).not.toBe(true);
  expect(refusedAsUnread(await write(join(root, "copy.txt"), "replaced\n"))).toBe(true);
  expect(await readFile(join(root, "copy.txt"), "utf8")).toBe("bytes the model never saw\n");
});

test("a file the command only changed still needs a read", async () => {
  const file = join(root, "app.js");
  await writeFile(file, "const user = 'their code';\n");
  expect((await exec("printf 'const added = 1;\\n' >> app.js")).isError).not.toBe(true);
  expect(refusedAsUnread(await edit(file, "added = 1", "added = 2"))).toBe(true);
  expect(refusedAsUnread(await write(file, "replaced\n"))).toBe(true);
  expect(await readFile(file, "utf8")).toBe("const user = 'their code';\nconst added = 1;\n");
});

test("a file created and then changed by a later command, as yacht32's shots.mjs was, still needs a read", async () => {
  const file = join(root, "scripts/shots.mjs");
  expect((await exec(CREATE_SHOTS)).isError).not.toBe(true);
  await delay(20);
  expect((await exec("sed -i 's/chromium.launch()/chromium.launch({ headless: true })/' scripts/shots.mjs")).isError)
    .not.toBe(true);
  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  expect(refusedAsUnread(await patch.execute(patchArgs(SHOTS_PATCH)))).toBe(true);
});

test("a file a here-document created that someone else changed afterwards still needs a read", async () => {
  const file = join(root, "notes.md");
  expect((await exec("cat > notes.md <<'EOF'\ndraft\nEOF")).isError).not.toBe(true);
  await delay(20);
  await writeFile(file, "draft\nadded by the user\n");
  expect(refusedAsUnread(await write(file, "final\n"))).toBe(true);
  expect(await readFile(file, "utf8")).toBe("draft\nadded by the user\n");
});

test("a hard link and a renamed older file a command made still need a read", async () => {
  const old = join(root, "old.txt");
  await writeFile(old, "the user's text\n");
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(old, anHourAgo, anHourAgo);
  await writeFile(join(root, "linked-source.txt"), "shared bytes\n");
  expect((await exec("ln linked-source.txt link.txt\nmv old.txt renamed.txt")).isError).not.toBe(true);
  for (const name of ["link.txt", "renamed.txt"]) {
    expect(refusedAsUnread(await write(join(root, name), "overwritten\n")), name).toBe(true);
  }
  expect(await readFile(join(root, "renamed.txt"), "utf8")).toBe("the user's text\n");
  expect(await readFile(join(root, "linked-source.txt"), "utf8")).toBe("shared bytes\n");
});

test("the preflight lets a here-document's file through and keeps refusing an unread one", async () => {
  await writeFile(join(root, "existing.js"), "const x = 1;\n");
  expect((await exec("cat > created.js <<'EOF'\nconst y = 1;\nEOF")).isError).not.toBe(true);
  const args = { [SESSION_ID_ARG]: session };
  expect(unreadFilePreflight(args, [join(root, "created.js")], root, [root])).toBeNull();
  expect(unreadFilePreflight(args, [join(root, "existing.js")], root, [root]))
    .toEqual(expect.objectContaining({ code: "file_read_required" }));
});

test("a created file is not sent back as a changed file, before or after its first edit", async () => {
  const opts: GetAttachmentsOptions = {
    sessionKey: { sessionId: session }, userInput: null, loadedTools: [], messages: [],
    permissionContext: { mode: "default" } as never, cwd: root, subagentDepth: 0,
    signal: new AbortController().signal, agencHome: root,
  };
  expect((await exec(CREATE_SHOTS)).isError).not.toBe(true);
  expect(await changedFilesProducer(opts, {} as never)).toEqual([]);
  const applied = await createApplyPatchTool({ cwd: root, allowedPaths: [root] }).execute(patchArgs(SHOTS_PATCH));
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await changedFilesProducer(opts, {} as never)).toEqual([]);
});
