import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createApplyPatchTool } from "../apply-patch/tool.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileWriteTool } from "./file-write.js";
import { clearSessionReadState, SESSION_ID_ARG } from "./filesystem.js";
import { verbatimWrites } from "./own-shell-changes.js";
import { resetPrintedOutputsForTest } from "./printed-read-proof.js";
import { attachToolRuntimeContext } from "../runtimes/context.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";

// A file whose bytes after the session's own command equal, byte for byte, the
// body of a quoted here-document in that command counts as read, whether the
// command created it or rewrote it whole: the model wrote exactly that text.
// iss3381's long task rewrote existing sources with `cat > src/x.mjs <<'EOF'`
// and its next apply_patch of each was refused as "not read yet". Expansion,
// appends and content that does not match stay unread.

let root: string;
let session: string;
let manager: UnifiedExecProcessManager;
let counter = 0;
const sessions: string[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-own-verbatim-")));
  session = `own-verbatim-${process.pid}-${++counter}`;
  sessions.push(session);
  manager = new UnifiedExecProcessManager({ cwd: root });
  resetPrintedOutputsForTest();
  await mkdir(join(root, "src"));
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
      turn: { subId: "turn-own-verbatim", cwd: root },
    },
  } as never);
  const tool = createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager });
  return bindExplicitDangerBoundary(tool).execute(args);
}

function patch(file: string, before: string, after: string) {
  return createApplyPatchTool({ cwd: root, allowedPaths: [root] }).execute({
    input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`,
    cwd: root, [SESSION_ID_ARG]: session,
  });
}

function edit(file: string, oldString: string, newString: string) {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string: oldString, new_string: newString, cwd: root, [SESSION_ID_ARG]: session,
  });
}

function write(file: string, content: string) {
  return createFileWriteTool({ allowedPaths: [root] }).execute({ file_path: file, content, [SESSION_ID_ARG]: session });
}

const refusedAsUnread = (result: { isError?: boolean; content: unknown }): boolean =>
  result.isError === true && String(result.content).includes("File has not been read yet");

/** A source file of the task that the session never read. */
async function existing(name: string, text = "export const placeholder = true;\n"): Promise<string> {
  const file = join(root, name);
  await writeFile(file, text);
  // The rewrite gets a later mtime even on a coarse clock.
  await delay(20);
  return file;
}

const RESOURCES = "export function emptyUsage() {\n  return { cpu: 0, memory: 0 };\n}\nexport const LIMIT = 4;\n";

// The four iss3381 shapes: the whole file from a quoted here-document, then a
// command that uses it (or another file) on the next line.
test.each([
  ["src/resources.mjs", `node -e "import('./src/resources.mjs').then(m=>console.log(m.emptyUsage()))" || true`],
  ["src/durable-util.mjs", `node -e "console.log('templates checked')" || true`],
  ["src/durable-service.mjs", "node --check src/durable-service.mjs && echo SYNTAX_OK || true"],
  ["src/transitions.mjs", `node -e "import('./src/transitions.mjs').then(async t=>{console.log(Object.keys(t).length)})" || true`],
])("an existing %s rewritten whole by cat > <<'EOF' counts as read", async (name, followUp) => {
  const file = await existing(name);
  const result = await exec(`cat > ${name} <<'EOF'\n${RESOURCES}EOF\n${followUp}`);
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(RESOURCES);
  const applied = await patch(name, "export const LIMIT = 4;", "export const LIMIT = 8;");
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(RESOURCES.replace("LIMIT = 4", "LIMIT = 8"));
});

test("cat <<'EOF' > file, a double-quoted delimiter and tee count as read too", async () => {
  const a = await existing("a.js");
  const b = await existing("b.js");
  const c = await existing("c.md", "# old\n");
  const result = await exec([
    "cat <<'EOF' > a.js", "const a = 1;", "EOF",
    'cat > b.js <<"END"', "const b = 1;", "END",
    "tee c.md <<'EOF' >/dev/null", "# notes", "EOF",
  ].join("\n"));
  expect(result.isError, String(result.content)).not.toBe(true);
  expect((await edit(a, "a = 1", "a = 2")).isError).not.toBe(true);
  expect((await edit(b, "b = 1", "b = 2")).isError).not.toBe(true);
  expect((await write(c, "# new\n")).isError).not.toBe(true);
  expect(await readFile(a, "utf8")).toBe("const a = 2;\n");
  expect(await readFile(c, "utf8")).toBe("# new\n");
});

test("an unquoted here-document stays unread, with or without anything to expand", async () => {
  const expanded = await existing("expanded.js");
  const plain = await existing("plain.js");
  const result = await exec([
    "cat > expanded.js <<EOF", "const home = '$HOME';", "EOF",
    "cat > plain.js <<EOF", "const plain = 1;", "EOF",
  ].join("\n"));
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(await readFile(plain, "utf8")).toBe("const plain = 1;\n");
  expect(refusedAsUnread(await write(expanded, "x\n"))).toBe(true);
  expect(refusedAsUnread(await edit(plain, "plain = 1", "plain = 2"))).toBe(true);
});

test("an append, a later change in the same command and a later outside change stay unread", async () => {
  const appended = await existing("appended.js", "const first = 1;\n");
  const changed = await existing("changed.js");
  const outside = await existing("outside.js");
  const result = await exec([
    "cat >> appended.js <<'EOF'", "const second = 2;", "EOF",
    "cat > changed.js <<'EOF'", "const value = 1;", "EOF",
    "sed -i 's/value = 1/value = 2/' changed.js",
    "cat > outside.js <<'EOF'", "const mine = 1;", "EOF",
  ].join("\n"));
  expect(result.isError, String(result.content)).not.toBe(true);
  await delay(20);
  await writeFile(outside, "const mine = 1;\nconst theirs = 2;\n");
  expect(refusedAsUnread(await edit(appended, "second = 2", "second = 3"))).toBe(true);
  expect(refusedAsUnread(await edit(changed, "value = 2", "value = 3"))).toBe(true);
  expect(refusedAsUnread(await write(outside, "replaced\n"))).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("const mine = 1;\nconst theirs = 2;\n");
});

test("verbatimWrites reads quoted here-documents and the files they write whole", () => {
  expect(verbatimWrites("cat > a.txt <<'EOF'\none\ntwo\nEOF\nwc -l a.txt")).toEqual([{ target: "a.txt", text: "one\ntwo\n" }]);
  // Bodies follow their line in order; an unquoted one is skipped but consumed.
  expect(verbatimWrites("cat > a <<'A'; cat > b <<B\nalpha\nA\nbeta $X\nB\ncat > c <<\\C\ngamma\nC")).toEqual([
    { target: "a", text: "alpha\n" }, { target: "c", text: "gamma\n" },
  ]);
  // <<- strips leading tabs from the body and the closing line.
  expect(verbatimWrites("cat > t <<-'EOF'\n\tindented\n\tEOF")).toEqual([{ target: "t", text: "indented\n" }]);
  expect(verbatimWrites("cat > empty <<'EOF'\nEOF")).toEqual([{ target: "empty", text: "" }]);
  // No closing line, a here-string, an extra input file, an append, a quoted target that may expand.
  expect(verbatimWrites("cat > open <<'EOF'\nnever closed")).toEqual([]);
  expect(verbatimWrites("cat > s <<< 'here string'")).toEqual([]);
  expect(verbatimWrites("cat header.txt - > out <<'EOF'\nbody\nEOF")).toEqual([]);
  expect(verbatimWrites("cat >> log <<'EOF'\nline\nEOF")).toEqual([]);
  expect(verbatimWrites("cat > \"$OUT\" <<'EOF'\nline\nEOF")).toEqual([]);
});
