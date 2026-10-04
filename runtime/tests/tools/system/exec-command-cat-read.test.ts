import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { recordShellReads } from "./exec-command.js";
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
  await recordShellReads({ cmd, output, cwd: root, allowedPaths: [root], args: { [SESSION_ID_ARG]: session } });
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
    ["cat *.go", finished("package a\n")],
    ["nl -ba a.go", finished("     1\tpackage a\n")],
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

test("cat steps of a chain and exact sed or head windows record reads of what was shown", async () => {
  await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n", "utf8");
  await writeFile(join(root, "go.mod"), "module m\n", "utf8");
  await writeFile(join(root, "big.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf8");
  await writeFile(join(root, "small.ts"), "export const x = 1;\n", "utf8");
  await record(
    "cat a.go; printf '\\n---\\n'; cat go.mod 2>/dev/null; sed -n '1,10p' big.ts; head -n 50 small.ts; git status --short",
    finished("package a\n\nfunc A() {}\n\n---\nmodule m\n" + Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\nexport const x = 1;\n M a.go\n"),
  );
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "go.mod"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "big.ts"))).toMatchObject({ viewKind: "partial", readOffset: 1, readLimit: 10 });
  expect(getSessionReadSnapshot(session, join(root, "small.ts"))).toMatchObject({ viewKind: "full" });
});

test("a read step whose file content is not in the output records nothing for that file", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await writeFile(join(root, "b.go"), "package b\n", "utf8");
  await record("cat a.go; cat b.go", finished("package a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toBeUndefined();
  await record("sed -n '1,5p' b.go", finished("package c\n"));
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toBeUndefined();
});

test("unsupported shell syntax and quoted separators fail closed; a literal 2>/dev/null is allowed", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  for (const cmd of [
    "cat a.go | cat", "cat a.go $(echo x)", "cat `echo a.go`", "cat a.go || true", "cat a.go & wait",
    "cat a.go\ncat a.go", "echo '; cat a.go'", "echo \"; cat a.go\"", "cat a.go > copy.go", "cat a.g?",
  ]) {
    await record(cmd, finished("package a\n"));
    expect(getSessionReadSnapshot(session, join(root, "a.go")), cmd).toBeUndefined();
  }
  await record("cat a.go 2>/dev/null; true", finished("package a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
});

test("only steps that certainly ran count: not a later step of an earlier && list", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await writeFile(join(root, "b.go"), "package b\n", "utf8");
  await record("ls x && cat a.go; cat b.go", finished("package a\npackage b\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toBeUndefined();
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toMatchObject({ viewKind: "full" });
  await record("cat b.go && cat a.go", finished("package b\npackage a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
});

test("a chain with any step outside the allowlist records nothing", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  for (const cmd of [
    "printf old; exit 0; cat a.go", "exec /usr/bin/printf x; cat a.go", "eval true; cat a.go", "X=1; cat a.go", "foo; cat a.go",
    "printf old && exit 0; cat a.go", "true && exec /usr/bin/printf x; cat a.go",
  ]) {
    await record(cmd, finished("package a\n"));
    expect(getSessionReadSnapshot(session, join(root, "a.go")), cmd).toBeUndefined();
  }
  await record("pwd; ls; cat a.go; git status --short", finished("/w\na.go\npackage a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
});

test("inherited shell startup hooks turn the shell read proof off", async () => {
  const { UnifiedExecProcessManager } = await import("../../unified-exec/process-manager.js");
  for (const [name, value] of [["BASH_ENV", "/tmp/hook.sh"], ["BASH_FUNC_cat%%", "() { echo x; }"], ["SHELLOPTS", "errexit"], ["ENV", "/tmp/e"]]) {
    const hooked = new UnifiedExecProcessManager({ baseEnv: { PATH: "/usr/bin:/bin", [name!]: value! } } as never);
    expect(hooked.shellStartupHooksPresent(), name).toBe(true);
  }
  const clean = new UnifiedExecProcessManager({ baseEnv: { PATH: "/usr/bin:/bin", HOME: "/tmp" } } as never);
  expect(clean.shellStartupHooksPresent()).toBe(false);
});
