import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { getSessionReadSnapshot, SESSION_ID_ARG } from "./filesystem.js";
import { resetPrintedOutputsForTest } from "./printed-read-proof.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { UnifiedExecProcessManager } from "../../unified-exec/process-manager.js";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

let root: string;
let session: string;
let counter = 0;
const SOURCE = "export function toCents(amount) {\n\n  return Math.floor(amount * 100);\n}\n";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-light-proof-")));
  session = `light-proof-${process.pid}-${++counter}`;
  resetPrintedOutputsForTest();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/money.js"), SOURCE);
  await writeFile(join(root, "src/other.js"), SOURCE.replace("toCents", "otherCents"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function exec(cmd: string, extra: Record<string, unknown> = {}) {
  const manager = new UnifiedExecProcessManager({ cwd: root });
  try {
    const tool = bindExplicitDangerBoundary(createExecCommandTool({
      cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager,
    }));
    return await tool.execute({ cmd, ...extra, [SESSION_ID_ARG]: session });
  } finally { await manager.closeAll(); }
}
async function edit(file = join(root, "src/money.js"), old_string = "Math.floor") {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: file, old_string, new_string: "Math.round", cwd: root, [SESSION_ID_ARG]: session,
  });
}

test.each([
  'for f in src/*.js; do echo "=== $f ==="; cat "$f"; done',
  'for f in src/money.js src/other.js; do cat -n "$f"; done',
  'for f in src/*.js; do nl -ba "$f"; done',
  'cd src && cat -n money.js other.js',
  'cd src && nl -ba money.js other.js',
  'cat src/money.js src/other.js',
  'cat -n src/money.js',
])("Light accepts edits after complete real shell output: %s", async cmd => {
  const result = await exec(cmd);
  expect(result.isError, String(result.content)).not.toBe(true);
  expect(String(result.content)).toContain("[exec exit_code=0]");
  const applied = await edit();
  expect(applied.isError, String(applied.content)).not.toBe(true);
  expect(await readFile(join(root, "src/money.js"), "utf8")).toBe(SOURCE.replace("Math.floor", "Math.round"));
  if (cmd.startsWith("for ")) {
    const other = await edit(join(root, "src/other.js"));
    expect(other.isError, String(other.content)).not.toBe(true);
  }
});

test.each([
  "head -n 3 src/money.js",
  "sed -n '1,3p' src/money.js",
  "grep -n 'Math.floor' src/money.js",
  'for f in src/*.js; do head -n 3 "$f"; done',
])("Light refuses a partial view of a longer file: %s", async cmd => {
  await exec(cmd);
  expect((await edit()).isError).toBe(true);
  expect(getSessionReadSnapshot(session, join(root, "src/money.js"))).toBeUndefined();
});

test.each(["literal", "loop"])("Light refuses truncated %s output", async shape => {
  await exec(shape === "literal" ? "cat src/money.js" : 'for f in src/*.js; do cat -n "$f"; done', { max_output_tokens: 5 });
  expect((await edit()).isError).toBe(true);
});

test.each(["literal", "loop"])("Light refuses %s output that a later pipeline cap may offload", async shape => {
  const text = SOURCE + "// unseen padding\n".repeat(1000);
  await writeFile(join(root, "src/money.js"), text);
  const result = await exec(shape === "literal" ? "cat src/money.js" : 'for f in src/*.js; do cat "$f"; done');
  expect(String(result.content)).toContain(text); // no exec truncation: the later cap is the risk
  expect((await edit()).isError).toBe(true);
});

test("Light refuses a changed file even when the edit's old string still exists", async () => {
  await exec('for f in src/*.js; do cat -n "$f"; done');
  await writeFile(join(root, "src/money.js"), SOURCE + "// unseen change\n");
  const later = new Date(Date.now() + 2000);
  await utimes(join(root, "src/money.js"), later, later);
  expect((await edit()).isError).toBe(true);
});

test("Light refuses a workspace path swapped to an outside symlink after reading", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agenc-light-outside-")));
  try {
    const file = join(root, "src/money.js");
    const target = join(outside, "money.js");
    await writeFile(target, SOURCE);
    await exec('for f in src/*.js; do cat -n "$f"; done');
    await unlink(file);
    await symlink(target, file);
    expect((await edit()).isError).toBe(true);
    expect(await readFile(target, "utf8")).toBe(SOURCE);
    await exec(`cat ${target}`);
    expect((await edit(target)).isError).toBe(true);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("Light refuses a symlink swapped to unseen contents inside the workspace", async () => {
  const file = join(root, "src/money.js");
  await exec('for f in src/*.js; do cat -n "$f"; done');
  await writeFile(join(root, "replacement.js"), SOURCE + "// unseen target\n");
  await unlink(file);
  await symlink(join(root, "replacement.js"), file);
  expect((await edit()).isError).toBe(true);
});

test.each([
  { exitCode: null, exit_code: null, session_id: 7, process_id: 7 },
  // Defensively reject a live handle even when an inconsistent manager supplies an exit code.
  { session_id: 7 },
  { process_id: 7 },
  { timedOut: true },
])("Light refuses incomplete exec output: %j", async overrides => {
  const output: ExecCommandToolOutput = {
    output: SOURCE, stdout: SOURCE, stderr: "", exitCode: 0, exit_code: 0,
    durationMs: 1, wall_time_seconds: 0.001, timedOut: false, truncated: false,
    original_token_count: 20, ...overrides,
  };
  const manager = {
    execCommand: async () => output, shellPath: "/bin/bash", shellStartupHooksPresent: () => false,
  } as unknown as UnifiedExecProcessManager;
  const tool = bindExplicitDangerBoundary(createExecCommandTool({
    cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager,
  }));
  await tool.execute({ cmd: "cat src/money.js", [SESSION_ID_ARG]: session });
  expect((await edit()).isError).toBe(true);
});

test.each(["cat src/money.js", 'for f in src/*.js; do cat "$f"; done'])("Light refuses output above an operator's lower offload threshold: %s", async cmd => {
  vi.stubEnv("AGENC_TOOL_RESULT_OFFLOAD_BYTES", "64");
  await exec(cmd);
  expect((await edit()).isError).toBe(true);
});

test.each(["cat src/money.js", "head -n 10 src/money.js", "sed -n '1,10p' src/money.js"])("Light does not count terminal sequences stripped from the displayed file: %s", async cmd => {
  await writeFile(join(root, "src/money.js"), `\u001b[31m${SOURCE}\u001b[0m`);
  await exec(cmd);
  expect((await edit()).isError).toBe(true);
});

test("Light refuses raw controls replaced by downstream display sanitization", async () => {
  await writeFile(join(root, "src/money.js"), `\u0001${SOURCE}`);
  await exec("cat src/money.js");
  expect((await edit()).isError).toBe(true);
});
