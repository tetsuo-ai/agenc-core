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

// A file the session's own shell command created holds only what that command
// wrote, so a Write, Edit or apply_patch may treat it as read (yacht32: an
// apply_patch of scripts/shots.mjs, made with `cat > scripts/shots.mjs <<'EOF'`,
// was refused as "not read yet"). Only files the command created count, never
// files it changed: no content the session did not make can be overwritten.

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

test("apply_patch of a file the session's own command created needs no read", async () => {
  const file = join(root, "scripts/shots.mjs");
  expect((await exec(CREATE_SHOTS)).isError).not.toBe(true);
  expect(hasSessionRead(session, file)).toBe(false);
  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  expect(patch.preflight?.(patchArgs(SHOTS_PATCH))).toBeNull();
  const applied = await patch.execute(patchArgs(SHOTS_PATCH));
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(`${SHOTS}process.exit(0);\n`);
});

test("Edit and Write of files the session's own command created need no read", async () => {
  expect((await exec("printf 'const a = 1;\\n' > a.js && printf 'draft\\n' > notes.md && touch empty.txt")).isError)
    .not.toBe(true);
  const edited = await edit(join(root, "a.js"), "a = 1", "a = 2");
  expect(edited.isError, String(edited.content)).not.toBe(true);
  expect(await readFile(join(root, "a.js"), "utf8")).toBe("const a = 2;\n");
  for (const [name, content] of [["notes.md", "final\n"], ["empty.txt", "now filled\n"]] as const) {
    const written = await write(join(root, name), content);
    expect(written.isError, String(written.content)).not.toBe(true);
    expect(await readFile(join(root, name), "utf8")).toBe(content);
  }
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

test("a created file someone else changed afterwards still needs a read", async () => {
  const file = join(root, "notes.md");
  expect((await exec("printf 'draft\\n' > notes.md")).isError).not.toBe(true);
  await delay(20);
  await writeFile(file, "draft\nadded by the user\n");
  expect(refusedAsUnread(await write(file, "final\n"))).toBe(true);
  expect(await readFile(file, "utf8")).toBe("draft\nadded by the user\n");
});

test("a file the command did not name, a hard link and a renamed older file are not creations", async () => {
  const old = join(root, "old.txt");
  await writeFile(old, "the user's text\n");
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(old, anHourAgo, anHourAgo);
  await writeFile(join(root, "linked-source.txt"), "shared bytes\n");
  expect((await exec([
    "OUT=generated.txt; printf 'made\\n' > \"$OUT\"",
    "ln linked-source.txt link.txt",
    "mv old.txt renamed.txt",
  ].join("\n"))).isError).not.toBe(true);
  for (const name of ["generated.txt", "link.txt", "renamed.txt"]) {
    expect(refusedAsUnread(await write(join(root, name), "overwritten\n")), name).toBe(true);
  }
  expect(await readFile(join(root, "renamed.txt"), "utf8")).toBe("the user's text\n");
  expect(await readFile(join(root, "linked-source.txt"), "utf8")).toBe("shared bytes\n");
});

test("the preflight lets a created file through and keeps refusing an unread one", async () => {
  await writeFile(join(root, "existing.js"), "const x = 1;\n");
  expect((await exec("printf 'const y = 1;\\n' > created.js")).isError).not.toBe(true);
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
