import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
    ["cat a.go", finished("package a\n", { exitCode: null, exit_code: null })],
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
    "cat a.go | cat", "cat a.go $(echo x)", "cat `echo a.go`", "cat a.go || echo x", "cat a.go & wait",
    "cat a.go |& cat", "cat a.go || true || true", "cat a.go || true && true", "cat a.go || true | cat",
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

test("pipelines elsewhere in a chain no longer void its plain read steps; pipeline output never records", async () => {
  await writeFile(join(root, "nested.py"), "\"\"\"nested.\"\"\"\n", "utf8");
  await writeFile(join(root, "pyproject.toml"), "[project]\nname = \"x\"\n", "utf8");
  await record(
    "cat nested.py; cat pyproject.toml | head -85; ls tests | head",
    finished("\"\"\"nested.\"\"\"\n[project]\nname = \"x\"\ntest_a.py\n"),
  );
  expect(getSessionReadSnapshot(session, join(root, "nested.py"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "pyproject.toml"))).toBeUndefined();
});

test("a list ending in || true counts only its first step", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await writeFile(join(root, "b.go"), "package b\n", "utf8");
  await record("printf x && cat a.go || true", finished("xpackage a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toBeUndefined();
  await record("cat a.go || true; grep -R -n b . || true; cat b.go", finished("package a\n./b.go:1:package b\npackage b\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toMatchObject({ viewKind: "full" });
});

test("an exact interpreter version probe keeps a chain readable; other interpreter use does not", async () => {
  await writeFile(join(root, "a.ts"), "export {}\n", "utf8");
  await record("cat a.ts; node -e 'console.log(1)'", finished("export {}\n1\n"));
  await record("cat a.ts; node --version extra", finished("export {}\nv26.8.1\n"));
  await record("cat a.ts; python3 --version; node script.js", finished("export {}\nPython 3.14.0\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.ts"))).toBeUndefined();
  await record("cat a.ts; git status --short; node --version", finished("export {}\nv26.8.1\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.ts"))).toMatchObject({ viewKind: "full" });
});

test("cd counts only when it names the absolute directory the command already runs in", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await mkdir(join(root, "sub"), { recursive: true });
  for (const cmd of ["cd sub && cat ../a.go", `cd ${join(root, "sub")} && cat ../a.go`, "cd && cat a.go", "cd - && cat a.go", `cd ${root} extra; cat a.go`]) {
    await record(cmd, finished("package a\n"));
    expect(getSessionReadSnapshot(session, join(root, "a.go")), cmd).toBeUndefined();
  }
  await record(`cd ${root}/ && cat a.go`, finished("package a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
});

test("after a nonzero exit only the first step of each ; list counts", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await writeFile(join(root, "b.go"), "package b\n", "utf8");
  const failed = (stdout: string) => finished(stdout, { exitCode: 2, exit_code: 2 });
  await record("cat a.go && cat b.go", failed("package a\npackage b\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toBeUndefined();
  await rm(join(root, "a.go"));
  await writeFile(join(root, "c.go"), "package c\n", "utf8");
  await record("ls missing; cat c.go && cat b.go; ls examples docs", failed("package c\npackage b\n"));
  expect(getSessionReadSnapshot(session, join(root, "c.go"))).toMatchObject({ viewKind: "full" });
  expect(getSessionReadSnapshot(session, join(root, "b.go"))).toBeUndefined();
});

test("a shell that did not exit on its own records nothing", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  await record("cat a.go; ls", finished("package a\n", { exitCode: null, exit_code: null }));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toBeUndefined();
});

test("empty commands bash rejects fail closed; a single trailing ; is fine", async () => {
  await writeFile(join(root, "a.go"), "package a\n", "utf8");
  for (const cmd of ["cat a.go; ; true", "; cat a.go", "cat a.go && && true", "cat a.go | | cat", "cat a.go &&", "cat a.go ||", "cat a.go |", "cat a.go;;", ""]) {
    await record(cmd, finished("package a\n"));
    await record(cmd, finished("package a\n", { exitCode: 2, exit_code: 2 }));
    expect(getSessionReadSnapshot(session, join(root, "a.go")), cmd).toBeUndefined();
  }
  await record("cat a.go ;  ", finished("package a\n"));
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "full" });
});


test("a grep -n window of one file records a partial read of exactly the lines it numbered", async () => {
  const text = ["package a", "", "// B doubles", "func B(x int) int {", "\treturn 2 * x", "}", ""].join("\n");
  await writeFile(join(root, "a.go"), text, "utf8");
  await writeFile(join(root, "a_test.go"), "package a\n\nfunc TestB() {}\n", "utf8");
  await record(
    "grep -n -A2 -B1 'func B' a.go; grep -n -e TestB -C1 a_test.go; git status --short",
    finished("3-// B doubles\n4:func B(x int) int {\n5-\treturn 2 * x\n6-}\n2-\n3:func TestB() {}\n M a.go\n"),
  );
  expect(getSessionReadSnapshot(session, join(root, "a.go"))).toMatchObject({ viewKind: "partial", readOffset: 3, readLimit: 4, content: "// B doubles\nfunc B(x int) int {\n\treturn 2 * x\n}" });
  expect(getSessionReadSnapshot(session, join(root, "a_test.go"))).toMatchObject({ viewKind: "partial", readOffset: 2, readLimit: 2 });
  const edit = createFileEditTool({ allowedPaths: [root] });
  const applied = await edit.execute({ file_path: join(root, "a.go"), old_string: "2 * x", new_string: "x + x", cwd: root, [SESSION_ID_ARG]: session });
  expect(applied.isError).not.toBe(true);
});

test("grep output that is not this file's numbered lines, or an unsupported grep form, records nothing", async () => {
  await writeFile(join(root, "a.go"), "package a\nfunc A() {}\n", "utf8");
  await writeFile(join(root, "b.go"), "package b\n", "utf8");
  const cases: Array<[string, string]> = [
    ["grep -n 'func A' a.go", "2:func B() {}\n"],
    ["grep -n 'func A' a.go", "3:func A() {}\n"],
    ["grep 'func A' a.go", "2:func A() {}\n"],
    ["grep -n 'func A' a.go b.go", "a.go:2:func A() {}\n"],
    ["grep -rn 'func A' a.go", "2:func A() {}\n"],
    ["grep -n -o 'func A' a.go", "2:func A() {}\n"],
    ["grep -n 'func A' a.go | head", "2:func A() {}\n"],
    ["grep -n -A x 'func A' a.go", "2:func A() {}\n"],
  ];
  for (const [cmd, stdout] of cases) {
    await record(cmd, finished(stdout));
    expect(getSessionReadSnapshot(session, join(root, "a.go")), cmd).toBeUndefined();
  }
});
