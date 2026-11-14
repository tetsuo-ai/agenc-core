import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FullOutputLog, logOutputEnabled, reduceLogsTogether } from "../../src/unified-exec/log-output.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "exec-log-test-")); });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });

test("only log selects the reducer", () => {
  for (const value of [undefined, "", "bad", "headtail"]) expect(logOutputEnabled({ AGENC_EXEC_OUTPUT_KEEP: value })).toBe(false);
  expect(logOutputEnabled({ AGENC_EXEC_OUTPUT_KEEP: "log" })).toBe(true);
});
test("keeps middle failures, final lines and repeat counts", () => {
  const text = "progress 1\rprogress 2\n" + "same\n".repeat(200) + "error: middle failure\n" + "pass\n".repeat(200) + "FINAL";
  const [result] = reduceLogsTogether([text], 400);
  expect(result!.text).toContain("error: middle failure");
  expect(result!.text).toContain("FINAL");
  expect(result!.text).toContain("repeated 199 times");
  expect(result!.text).toContain("progress 2");
  expect(result!.text).not.toContain("progress 1");
  expect(result!.text.length).toBeLessThanOrEqual(400);
});
test("spools exact chunks privately and invalidates a failed save", async () => {
  const log = new FullOutputLog(root);
  log.append("a\r"); log.append("b\n");
  expect(await readFile(log.path!, "utf8")).toBe("a\rb\n");
  if (process.platform !== "win32") expect((await stat(log.path!)).mode & 0o777).toBe(0o600);
  log.close();
  const failed = new FullOutputLog(log.path!);
  failed.append("lost");
  expect(failed.path).toBeUndefined();
});
test("truncated commands name a readable full log, including output beyond the live cap", async () => {
  if (process.platform === "win32") return;
  const manager = new UnifiedExecProcessManager({ cwd: process.cwd(), shellPath: "/bin/sh", sessionTempRoot: root,
    env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  try {
    const result = await manager.execCommand({ cmd: "printf START; head -c 2500000 /dev/zero | tr '\\0' x; printf 'error: MIDDLE\\n'; printf END", max_output_tokens: 100 });
    expect(result.truncated).toBe(true);
    const path = /\[full output: (.+)\]/.exec(result.output)?.[1];
    expect(path).toBeTruthy();
    const full = await readFile(path!, "utf8");
    expect(full).toHaveLength(2500022);
    expect(full.startsWith("START")).toBe(true);
    expect(full.endsWith("error: MIDDLE\nEND")).toBe(true);
  } finally { await manager.closeAll("test cleanup"); }
});
test("legacy and malformed exec switches preserve exact result text", async () => {
  if (process.platform === "win32") return;
  const outputs: string[] = [];
  for (const mode of [undefined, "headtail", "bad"]) {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd(), shellPath: "/bin/sh", sessionTempRoot: root,
      baseEnv: { PATH: process.env.PATH, AGENC_EXEC_OUTPUT_KEEP: mode } });
    try { outputs.push((await manager.execCommand({ cmd: "head -c 2000 /dev/zero | tr '\\0' x", max_output_tokens: 100 })).output); }
    finally { await manager.closeAll("test cleanup"); }
  }
  expect(outputs[0]).toBe(outputs[1]); expect(outputs[0]).toBe(outputs[2]);
  expect(outputs[0]).toContain("[... omitted 1600 chars ...]");
});
test("normal exec reads recover the saved middle and polls share one complete log", async () => {
  if (process.platform === "win32") return;
  const manager = new UnifiedExecProcessManager({ cwd: process.cwd(), shellPath: "/bin/sh", sessionTempRoot: root,
    env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  try {
    const started = await manager.execCommand({ cmd: "printf BEFORE; sleep 0.5; head -c 20000 /dev/zero | tr '\\0' x; printf AFTER", yield_time_ms: 250 });
    expect(started.output).toBe("BEFORE");
    const result = await manager.writeStdin({ session_id: started.session_id!, chars: "", max_output_tokens: 100 });
    const path = /\[full output: (.+)\]/.exec(result.output)?.[1];
    expect(path).toBeTruthy();
    expect(await readFile(path!, "utf8")).toBe("BEFORE" + "x".repeat(20000) + "AFTER");
    const recovered = await manager.execCommand({ cmd: `tail -c 5 '${path}'` });
    expect(recovered.output).toBe("AFTER");
  } finally { await manager.closeAll("test cleanup"); }
});
test("passing logs use a smaller budget while failures keep their requested budget", async () => {
  if (process.platform === "win32") return;
  const manager = new UnifiedExecProcessManager({ cwd: process.cwd(), shellPath: "/bin/sh", sessionTempRoot: root,
    env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  try {
    const command = "head -c 12000 /dev/zero | tr '\\0' x";
    const passing = await manager.execCommand({ cmd: command });
    const failing = await manager.execCommand({ cmd: command + "; exit 1" });
    expect(passing.output.length).toBeLessThanOrEqual(8000);
    expect(passing.output).toContain("[full output:");
    expect(failing.output.length).toBe(12000);
    expect(failing.truncated).toBe(false);
  } finally { await manager.closeAll("test cleanup"); }
});

test("replacing the log path cannot redirect later chunks into another file", async () => {
  if (process.platform === "win32") return;
  const log = new FullOutputLog(root);
  log.append("before");
  const path = log.path!;
  const moved = path + ".moved";
  const target = join(root, "target.txt");
  await writeFile(target, "untouched");
  await rename(path, moved);
  await symlink(target, path);
  try {
    log.append("after");
    expect(log.path).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect(await readFile(moved, "utf8")).toBe("beforeafter");
  } finally { log.close(); }
});
