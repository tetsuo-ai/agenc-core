import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FullOutputLog } from "../../src/unified-exec/log-output.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "exec-log-storage-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("a planted exec-logs directory symlink cannot redirect log creation", async () => {
  const outside = join(root, "outside");
  const temp = join(root, "child-temp");
  await mkdir(outside); await mkdir(temp);
  await symlink(outside, join(temp, "exec-logs"), "dir");
  const log = new FullOutputLog(temp);
  try {
    log.append("PLANTED-BY-COMMAND");
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(log.path!, "utf8")).toBe("PLANTED-BY-COMMAND");
    expect((await stat(dirname(log.path!))).mode & 0o777).toBe(0o700);
  } finally { log.close(); }
});

test("logs stop at 8 MiB even across many append calls", async () => {
  const log = new FullOutputLog(root);
  try {
    for (let i = 0; i < 40; i++) log.append("x".repeat(1_000_000));
    expect((await stat(log.path!)).size).toBe(8 * 1024 * 1024);
  } finally { log.close(); }
});

test("the manager ignores a command-planted link and removes named and unnamed logs at close", async () => {
  const temp = join(root, "child-temp");
  const outside = join(root, "outside");
  const home = join(root, "daemon-home");
  await mkdir(temp); await mkdir(outside); await mkdir(home);
  const manager = new UnifiedExecProcessManager({ cwd: root, shellPath: "/bin/sh", sessionTempRoot: temp,
    baseEnv: { PATH: process.env.PATH, AGENC_HOME: home }, env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  let path: string | undefined;
  try {
    await manager.execCommand({ cmd: `ln -s '${outside}' "$TMPDIR/exec-logs"; printf small` });
    const result = await manager.execCommand({ cmd: "head -c 20000 /dev/zero | tr '\\0' x; printf PLANTED-BY-COMMAND", max_output_tokens: 100 });
    path = /\[full output: (.+)\]/.exec(result.output)?.[1];
    expect(path).toBeTruthy();
    expect(await readdir(outside)).toEqual([]);
    expect(path!.startsWith(home + "/")).toBe(true);
    expect(await readdir(home)).toHaveLength(1); // the small unreferenced log is gone
    expect((await readFile(path!, "utf8")).endsWith("PLANTED-BY-COMMAND")).toBe(true);
  } finally { await manager.closeAll(); }
  await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(home)).toEqual([]);
});

test("capped log references say they contain a prefix, then session cleanup removes them", async () => {
  const home = join(root, "daemon-home");
  await mkdir(home);
  const manager = new UnifiedExecProcessManager({ cwd: root, shellPath: "/bin/sh", sessionTempRoot: root,
    baseEnv: { PATH: process.env.PATH, AGENC_HOME: home }, env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  try {
    const result = await manager.execCommand({ cmd: "head -c 10000000 /dev/zero | tr '\\0' x", max_output_tokens: 100 });
    const path = /\[output log \(first 8388608 bytes\): (.+)\]/.exec(result.output)?.[1];
    expect(path).toBeTruthy();
    expect((await stat(path!)).size).toBe(8 * 1024 * 1024);
  } finally { await manager.closeAll(); }
  expect(await readdir(home)).toEqual([]);
});

test("retention keeps at most 32 completed logs and durable close removes released commands' logs", async () => {
  const home = join(root, "daemon-home");
  await mkdir(home);
  const manager = new UnifiedExecProcessManager({ cwd: root, shellPath: "/bin/sh", sessionTempRoot: root,
    baseEnv: { PATH: process.env.PATH, AGENC_HOME: home }, env: { AGENC_EXEC_OUTPUT_KEEP: "log" } });
  try {
    for (let i = 0; i < 34; i++) {
      const result = await manager.execCommand({ cmd: "head -c 2000 /dev/zero | tr '\\0' x", max_output_tokens: 100 });
      expect(result.output).toContain("[full output:");
    }
    expect(await readdir(home)).toHaveLength(32);
    await manager.prepareForDurableClose();
    expect(await readdir(home)).toEqual([]);
  } finally { await manager.closeAll(); }
});
