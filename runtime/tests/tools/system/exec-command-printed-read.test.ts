import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createExecCommandTool } from "./exec-command.js";
import { formatUnifiedExecToolContent } from "./exec-result-format.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileWriteTool } from "./file-write.js";
import { createApplyPatchTool } from "../apply-patch/tool.js";
import {
  mayProvePrintedRead,
  PRINTED_READ_MAX_VISIBLE_BYTES,
  provePrintedRead,
  rememberPrintedOutput,
  resetPrintedOutputsForTest,
} from "./printed-read-proof.js";
import { unreadFilePreflight } from "./read-before-write.js";
import { getSessionReadSnapshot, hasSessionRead, SESSION_ID_ARG } from "./filesystem.js";
import { MIN_TOOL_RESULT_BYTES } from "../execution.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

// Standard sessions count a workspace file as read when a command printed its
// exact current text, whatever shell construct printed it. In the agent race
// DeepSeek read the sources with `for f in src/*.js; do ... cat -n "$f"; done`
// in 4 of 6 standard runs; every first Edit was then refused and the model
// paid a FileRead round trip plus a resent edit. exec_command only keeps the
// text it returned; the proof runs when an Edit or Write asks for a file that
// was not read, so commands pay nothing for it. Light shares the proof and
// also keeps literal-read support for small files (exec-command-cat-read*.test.ts).

let root: string;
let session: string;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-printed-read-")));
  counter += 1;
  session = `session-printed-read-${process.pid}-${counter}`;
  resetPrintedOutputsForTest();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finished(stdout: string, overrides: Partial<ExecCommandToolOutput> = {}): ExecCommandToolOutput {
  return {
    output: stdout, stdout, stderr: "", exitCode: 0, exit_code: 0, durationMs: 1,
    wall_time_seconds: 0.001, timedOut: false, truncated: false, original_token_count: 1, ...overrides,
  };
}

async function record(cmd: string, output: ExecCommandToolOutput, cwd = root): Promise<void> {
  rememberPrintedOutput({ cmd, output, visible: formatUnifiedExecToolContent(output), cwd, args: { [SESSION_ID_ARG]: session } });
}

/** What an Edit or Write of `file` asks before refusing it as unread. */
async function proves(file: string): Promise<boolean> {
  return provePrintedRead(session, file, [root], { [SESSION_ID_ARG]: session });
}

function catN(text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${String(index + 1).padStart(6, " ")}\t${line}\n`).join("");
}

const MONEY = "export function toCents(amount) {\n  return Math.floor(amount * 100);\n}\n";
const SPLIT = "export function splitCents(total, parts) {\n  throw new Error(\"todo\");\n}\n";

test("a for loop over a glob with cat -n records a full read of every printed file", async () => {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "money.js"), MONEY, "utf8");
  await writeFile(join(root, "src", "split.js"), SPLIT, "utf8");
  await record(
    `cd ${root} && for f in src/*.js src/**/*.js; do echo "===== $f ====="; cat -n "$f"; done 2>/dev/null`,
    finished(`===== src/money.js =====\n${catN(MONEY)}===== src/split.js =====\n${catN(SPLIT)}`, { exitCode: 1, exit_code: 1 }),
  );
  // Keeping the text records nothing; the proof runs when an edit asks for the file.
  expect(hasSessionRead(session, join(root, "src", "money.js"))).toBe(false);
  expect(await proves(join(root, "src", "money.js"))).toBe(true);
  expect(await proves(join(root, "src", "split.js"))).toBe(true);
  expect(getSessionReadSnapshot(session, join(root, "src", "money.js"))).toMatchObject({ viewKind: "full", rawContent: MONEY });
  expect(hasSessionRead(session, join(root, "src", "split.js"))).toBe(true);
});

test("a raw cat in a cd chain records the file relative to the cd target", async () => {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "money.js"), MONEY, "utf8");
  await record("cd src && cat money.js", finished(MONEY));
  expect(await proves(join(root, "src", "money.js"))).toBe(true);
  expect(hasSessionRead(session, join(root, "src", "money.js"))).toBe(true);
});

test("output that is not the whole current text, or an incomplete command, records nothing", async () => {
  await writeFile(join(root, "a.js"), MONEY, "utf8");
  const cases: Array<[string, ExecCommandToolOutput]> = [
    ["cat a.js", finished(MONEY.slice(0, 20))],
    ["head -n 1 a.js", finished("export function toCents(amount) {\n")],
    ["cat a.js", finished(MONEY, { truncated: true })],
    ["cat a.js", finished(MONEY, { timedOut: true })],
    ["cat a.js", finished(MONEY, { exitCode: null, exit_code: null })],
    ["cat a.js", finished(MONEY, { exitCode: null, exit_code: null, session_id: 7 })],
    // The text is printed, but the command does not name the file.
    ["cat other.js", finished(MONEY)],
  ];
  for (const [cmd, output] of cases) await record(cmd, output);
  expect(await proves(join(root, "a.js"))).toBe(false);
  expect(getSessionReadSnapshot(session, join(root, "a.js"))).toBeUndefined();
});

test("a quoted mention or a short file proves nothing", async () => {
  await writeFile(join(root, "a.js"), MONEY, "utf8");
  await writeFile(join(root, "short.txt"), "old\n", "utf8");
  // The file name only appears inside a quoted argument, so the command never read it.
  await record(`printf '%s\\n' '; cat a.js;'; printf '%s' '${MONEY}'`, finished(`; cat a.js;\n${MONEY}`));
  // A few bytes can appear in any output by coincidence.
  await record("cat short.txt", finished("old\n"));
  // The text must start a line of the output.
  await record("cat a.js", finished(`prefix ${MONEY}`));
  expect(await proves(join(root, "a.js"))).toBe(false);
  expect(await proves(join(root, "short.txt"))).toBe(false);
  expect(getSessionReadSnapshot(session, join(root, "a.js"))).toBeUndefined();
  expect(getSessionReadSnapshot(session, join(root, "short.txt"))).toBeUndefined();
});

test("a file outside the workspace is never recorded", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agenc-printed-outside-")));
  try {
    await writeFile(join(outside, "secret.txt"), "token\n", "utf8");
    await record(`cat ${join(outside, "secret.txt")}`, finished("token\n"));
    await record(`for f in ${outside}/*.txt; do cat "$f"; done`, finished("token\n"));
    expect(await proves(join(outside, "secret.txt"))).toBe(false);
    expect(getSessionReadSnapshot(session, join(outside, "secret.txt"))).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("an Edit after a printed read passes the read-before-write gate", async () => {
  await mkdir(join(root, "src"));
  const file = join(root, "src", "money.js");
  await writeFile(file, MONEY, "utf8");
  const edit = createFileEditTool({ allowedPaths: [root] });
  const args = {
    file_path: file, old_string: "Math.floor", new_string: "Math.round", cwd: root, [SESSION_ID_ARG]: session,
  };

  const refused = await edit.execute({ ...args });
  expect(refused.isError).toBe(true);
  expect(refused.content).toContain("File has not been read yet");

  await record('for f in src/*.js; do cat -n "$f"; done', finished(catN(MONEY)));
  const applied = await edit.execute({ ...args });
  expect(applied.isError).not.toBe(true);
});

const MONEY_TEST = "import { test } from 'node:test';\nimport { toCents } from '../src/money.js';\ntest('cents', () => {});\n";

test("a loop over find in a named directory records each printed file the output names", async () => {
  // qb nodefix on DeepSeek: the sources came from `$(find src test -type f)`, so no word names a file.
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "money.js"), MONEY, "utf8");
  await writeFile(join(root, "test", "money.test.js"), MONEY_TEST, "utf8");
  await record(
    'cat README.md && ls -R src test && for f in $(find src test -type f); do echo "--- $f ---"; cat "$f"; done',
    finished(`src:\nmoney.js\n\ntest:\nmoney.test.js\n--- src/money.js ---\n${MONEY}--- test/money.test.js ---\n${MONEY_TEST}`),
  );
  expect(await proves(join(root, "src", "money.js"))).toBe(true);
  expect(await proves(join(root, "test", "money.test.js"))).toBe(true);
  expect(getSessionReadSnapshot(session, join(root, "src", "money.js"))).toMatchObject({ viewKind: "full", rawContent: MONEY });
  expect(hasSessionRead(session, join(root, "test", "money.test.js"))).toBe(true);
});

test("a file found through its directory needs its name in the output", async () => {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "money.js"), MONEY, "utf8");
  // The text is printed, but nothing says which file it came from.
  await record("find src -type f -exec cat {} +", finished(MONEY));
  expect(await proves(join(root, "src", "money.js"))).toBe(false);
  expect(getSessionReadSnapshot(session, join(root, "src", "money.js"))).toBeUndefined();
});

test("a file named without a dot or a slash is checked like any other", async () => {
  const makefile = "test:\n\tnode --test\n\nlint:\n\tnode scripts/lint.mjs --strict --max-warnings 0\n";
  await writeFile(join(root, "Makefile"), makefile, "utf8");
  await record("cat Makefile", finished(makefile));
  expect(await proves(join(root, "Makefile"))).toBe(true);
});

test("a named directory outside the workspace adds nothing", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agenc-printed-outside-dir-")));
  try {
    await writeFile(join(outside, "notes.js"), MONEY, "utf8");
    await record(
      `for f in $(find ${outside} -type f); do echo "--- $f ---"; cat "$f"; done`,
      finished(`--- ${join(outside, "notes.js")} ---\n${MONEY}`),
    );
    expect(await proves(join(outside, "notes.js"))).toBe(false);
    expect(getSessionReadSnapshot(session, join(outside, "notes.js"))).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// The read must be what the model receives. Real exec_command runs, so the head-and-tail cut and the
// returned text are the production ones.
async function execStandard(cmd: string, extra: Record<string, unknown> = {}) {
  const manager = new UnifiedExecProcessManager({ cwd: root });
  try {
    const tool = bindExplicitDangerBoundary(createExecCommandTool({
      cwd: root, allowedPaths: [root], unifiedExecManager: manager,
    }));
    return await tool.execute({ cmd, ...extra, [SESSION_ID_ARG]: session });
  } finally {
    await manager.closeAll();
  }
}

async function editRefused(file: string, oldString: string): Promise<boolean> {
  const edit = createFileEditTool({ allowedPaths: [root] });
  const result = await edit.execute({
    file_path: file, old_string: oldString, new_string: `${oldString}_changed`, cwd: root, [SESSION_ID_ARG]: session,
  });
  return result.isError === true && String(result.content).includes("File has not been read yet");
}

function numberedLines(count: number, width: number): string {
  return Array.from({ length: count }, (_, i) => `line ${String(i).padStart(6, "0")} ${"x".repeat(width)}`).join("\n") + "\n";
}

test("the visible-size bound is the smallest cap the tool-result pipeline applies", () => {
  expect(PRINTED_READ_MAX_VISIBLE_BYTES).toBe(MIN_TOOL_RESULT_BYTES);
});

test("a real cat of a small file counts as read and lets Edit through", async () => {
  await writeFile(join(root, "money.js"), MONEY, "utf8");
  const result = await execStandard("cat money.js");
  expect(result.isError).not.toBe(true);
  expect(await editRefused(join(root, "money.js"), "Math.floor")).toBe(false);
  expect(hasSessionRead(session, join(root, "money.js"))).toBe(true);
});

test("apply_patch accepts the same whole-file shell read as Edit", async () => {
  const file = join(root, "money.js");
  await writeFile(file, MONEY, "utf8");
  const shown = await execStandard('for f in *.js; do echo "--- $f ---"; cat -n "$f"; done');
  expect(shown.isError).not.toBe(true);
  expect(hasSessionRead(session, file)).toBe(false);

  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  const args = {
    input: "*** Begin Patch\n*** Update File: money.js\n@@\n-  return Math.floor(amount * 100);\n+  return Math.round(amount * 100);\n*** End Patch",
    cwd: root,
    [SESSION_ID_ARG]: session,
  };
  expect(patch.preflight?.(args)).toBeNull();
  const applied = await patch.execute(args);
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(MONEY.replace("Math.floor", "Math.round"));
});

test("apply_patch can replace an existing file whose complete text was printed", async () => {
  const file = join(root, "money.js");
  await writeFile(file, MONEY, "utf8");
  await record("cat money.js", finished(MONEY));
  const replacement = MONEY.replace("Math.floor", "Math.round");
  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  const result = await patch.execute({
    input: ["*** Begin Patch", "*** Add File: money.js", ...replacement.trimEnd().split("\n").map(line => `+${line}`), "*** End Patch"].join("\n"),
    cwd: root,
    [SESSION_ID_ARG]: session,
  });
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe(replacement);
});

test.each(["truncated", "changed"])("apply_patch keeps refusing an unproved %s shell read", async reason => {
  const file = join(root, "money.js");
  await writeFile(file, MONEY, "utf8");
  await record("cat money.js", finished(MONEY, { truncated: reason === "truncated" }));
  const current = reason === "changed" ? MONEY.replace("Math.floor", "Math.ceil") : MONEY;
  if (reason === "changed") await writeFile(file, current, "utf8");
  const patch = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  const result = await patch.execute({
    input: "*** Begin Patch\n*** Update File: money.js\n@@\n-  return Math.floor(amount * 100);\n+  return Math.round(amount * 100);\n*** End Patch",
    cwd: root,
    [SESSION_ID_ARG]: session,
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("File has not been read yet");
  expect(await readFile(file, "utf8")).toBe(current);
});

test("a file larger than the default exec output cap, printed with cat, does not count and Edit stays refused", async () => {
  // The default exec cap keeps 40,000 characters as head and tail; this file is about 60 KB.
  const big = numberedLines(1200, 40);
  expect(big.length).toBeGreaterThan(40_000);
  await writeFile(join(root, "big.txt"), big, "utf8");
  const result = await execStandard("cat big.txt");
  expect(String(result.content).length).toBeLessThan(big.length);
  expect(getSessionReadSnapshot(session, join(root, "big.txt"))).toBeUndefined();
  expect(await editRefused(join(root, "big.txt"), "line 000600")).toBe(true);
});

test("an explicit max_output_tokens cut does not count either", async () => {
  const text = numberedLines(60, 20);
  await writeFile(join(root, "mid.txt"), text, "utf8");
  await execStandard("cat mid.txt", { max_output_tokens: 100 });
  expect(getSessionReadSnapshot(session, join(root, "mid.txt"))).toBeUndefined();
  expect(await editRefused(join(root, "mid.txt"), "line 000030")).toBe(true);
});

test("an untruncated result above the smallest pipeline cap does not count", async () => {
  // Under the exec cap (40,000 characters) but over the 16,000 bytes a small-window model's
  // tool-result cap can cut to, so the model might not see all of it.
  const text = numberedLines(500, 40);
  expect(text.length).toBeGreaterThan(PRINTED_READ_MAX_VISIBLE_BYTES);
  expect(text.length).toBeLessThan(40_000);
  await writeFile(join(root, "medium.txt"), text, "utf8");
  const result = await execStandard("cat medium.txt");
  expect(String(result.content)).toContain(text);
  expect(getSessionReadSnapshot(session, join(root, "medium.txt"))).toBeUndefined();
  expect(await editRefused(join(root, "medium.txt"), "line 000250")).toBe(true);
});

test("a file with terminal control characters does not count", async () => {
  await writeFile(join(root, "ansi.txt"), `\u001b[31mred\u001b[0m ${MONEY}`, "utf8");
  await execStandard("cat ansi.txt");
  expect(await proves(join(root, "ansi.txt"))).toBe(false);
  expect(getSessionReadSnapshot(session, join(root, "ansi.txt"))).toBeUndefined();
});

test("a file changed after it was printed is not proved, and its edit stays refused", async () => {
  await writeFile(join(root, "money.js"), MONEY, "utf8");
  await execStandard("cat money.js");
  await writeFile(join(root, "money.js"), MONEY.replace("Math.floor", "Math.trunc"), "utf8");
  expect(await editRefused(join(root, "money.js"), "Math.trunc")).toBe(true);
});

test("Write over a file printed whole goes through, and over an unprinted one stays refused", async () => {
  await writeFile(join(root, "money.js"), MONEY, "utf8");
  await writeFile(join(root, "split.js"), SPLIT, "utf8");
  await execStandard("cat money.js");
  const write = createFileWriteTool({ allowedPaths: [root] });
  const ok = await write.execute({ file_path: join(root, "money.js"), content: "export const x = 1;\n", cwd: root, [SESSION_ID_ARG]: session });
  expect(ok.isError).not.toBe(true);
  const refused = await write.execute({ file_path: join(root, "split.js"), content: "export const y = 2;\n", cwd: root, [SESSION_ID_ARG]: session });
  expect(refused.isError).toBe(true);
  expect(String(refused.content)).toContain("File has not been read yet");
});

test("the preflight leaves a file a kept result may prove to the edit and refuses one no result names", async () => {
  await writeFile(join(root, "money.js"), MONEY, "utf8");
  await writeFile(join(root, "split.js"), SPLIT, "utf8");
  await record("cat money.js", finished(MONEY));
  const args = { [SESSION_ID_ARG]: session, cwd: root };
  expect(mayProvePrintedRead(session, join(root, "money.js"))).toBe(true);
  expect(unreadFilePreflight(args, [join(root, "money.js")], root, [root])).toBeNull();
  expect(unreadFilePreflight(args, [join(root, "split.js")], root, [root])?.code).toBe("file_read_required");
});

test("only the last twelve results of a session are kept", async () => {
  await writeFile(join(root, "money.js"), MONEY, "utf8");
  await record("cat money.js", finished(MONEY));
  for (let i = 0; i < 12; i += 1) await record(`ls -la ${i}`, finished(`listing ${i}\n`));
  expect(await proves(join(root, "money.js"))).toBe(false);
});

test("keeping a result touches no file: a directory word is not walked when the command runs", async () => {
  // In a large tree `ls src` named every file it listed; the old eager proof then read each of
  // them. Now only the command words and the returned text are kept.
  await mkdir(join(root, "src"));
  for (let i = 0; i < 40; i += 1) await writeFile(join(root, "src", `f${i}.js`), `${MONEY}// ${i}\n`, "utf8");
  const listing = Array.from({ length: 40 }, (_, i) => `f${i}.js`).join("\n") + "\n";
  await record("ls src", finished(listing));
  for (let i = 0; i < 40; i += 1) expect(hasSessionRead(session, join(root, "src", `f${i}.js`))).toBe(false);
  // The listing names the files but does not show their text, so none is proved.
  expect(await proves(join(root, "src", "f3.js"))).toBe(false);
});
