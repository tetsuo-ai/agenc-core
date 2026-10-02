import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { recordPlainCatReads } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { getSessionReadSnapshot, SESSION_ID_ARG } from "./filesystem.js";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

let root: string;
let session: string;
let counter = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-cat-read-")));
  counter += 1;
  session = `session-cat-read-${process.pid}-${counter}`;
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

async function record(cmd: string, output: ExecCommandToolOutput): Promise<void> {
  await recordPlainCatReads({ cmd, output, cwd: root, allowedPaths: [root], args: { [SESSION_ID_ARG]: session } });
}

test("a plain cat whose output equals the files records full reads", async () => {
  await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n", "utf8");
  await writeFile(join(root, "b.go"), "package a\r\n", "utf8");
  await record("cat a.go b.go", finished("package a\n\nfunc A() {}\npackage a\r\n"));
  const a = getSessionReadSnapshot(session, join(root, "a.go"));
  expect(a).toMatchObject({ viewKind: "full", content: "package a\n\nfunc A() {}\n", rawContent: "package a\n\nfunc A() {}\n" });
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toMatchObject({ viewKind: "full", content: "package a\n" });
});

test("output that differs from the files, or an unsafe or incomplete command, records nothing", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  const cases: Array<[string, ExecCommandToolOutput]> = [
    ["cat a.go", finished("package b\n")],
    ["cat a.go | head -5", finished("package a\n")],
    ["cat -n a.go", finished("package a\n")],
    ["cat a.go; echo done", finished("package a\n")],
    ["cat *.go", finished("package a\n")],
    ["cat a.go", finished("package a\n", { truncated: true })],
    ["cat a.go", finished("package a\n", { exitCode: 1, exit_code: 1 })],
    ["cat a.go", finished("package a\n", { exitCode: null, exit_code: null, session_id: 7 })],
  ];
  for (const [cmd, output] of cases) await record(cmd, output);
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toBeUndefined();
});

test("a file outside the workspace is never recorded", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agenc-cat-outside-")));
  try {
    await writeFile(join(outside, "secret.txt"), "x\n", "utf8");
    await record(`cat ${join(outside, "secret.txt")}`, finished("x\n"));
    expect(getSessionReadSnapshot(session, join(outside, "secret.txt"))).toBeUndefined();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("an Edit after a matching cat passes the read-before-write gate", async () => {
  const file = join(root, "bytes.go");
  await writeFile(file, "func Bytes() string { return \"B\" }\n", "utf8");
  const edit = createFileEditTool({ allowedPaths: [root] });
  const args = { file_path: file, old_string: "\"B\"", new_string: "\"b\"", cwd: root, [SESSION_ID_ARG]: session };

  const refused = await edit.execute(args);
  expect(String(refused.content)).toContain("has not been read yet");

  await record("cat bytes.go", finished("func Bytes() string { return \"B\" }\n"));
  const applied = await edit.execute(args);
  expect(applied.isError).not.toBe(true);
});
