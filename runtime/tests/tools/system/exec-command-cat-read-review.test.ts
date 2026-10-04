// Reviewer regressions and controls (rv, 2026-10-02, v7) for the Light shell read proof. The race hook also
// wraps file handles from open(), where the proof now reads, so the injected write lands between its snapshots.
// Reviewer regressions and controls (rv, 2026-10-02, v5) for the Light shell read proof. The race hook also
// wraps file handles from open(), where the proof now reads, so the injected write lands between its snapshots.
// Reviewer regressions and controls (rv, 2026-10-02, v4) for the Light shell read proof. The race hook also
// wraps file handles from open(), where the proof now reads, so the injected write lands between its snapshots.
import { constants, openSync, writeSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { getSessionReadSnapshot, SESSION_ID_ARG } from "./filesystem.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";

const growth = vi.hoisted(() => ({ target: "", enabled: false, fired: false, maxRead: 0 }));
const race = vi.hoisted(() => ({
  target: "", replacement: "", enabled: false, fired: false,
  done: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...args);
      if (race.enabled && String(args[0]) === race.target) {
        // Deterministic legal interleaving: bytes were read, an external writer
        // changes the file, then the concurrent stat observes the new mtime.
        await actual.writeFile(race.target, race.replacement);
        const later = new Date(Date.now() + 2000);
        await actual.utimes(race.target, later, later);
        race.release!();
      }
      return bytes;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (growth.enabled && String(args[0]) === growth.target) {
        const stat = handle.stat.bind(handle);
        const readFile = handle.readFile.bind(handle);
        handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
          const before = await stat(...statArgs);
          if (!growth.fired) {
            growth.fired = true;
            await actual.writeFile(growth.target, Buffer.alloc(8 * 1024 * 1024, 65));
          }
          return before;
        }) as typeof handle.stat;
        handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
          const bytes = await readFile(...readArgs);
          growth.maxRead = Math.max(growth.maxRead, bytes.length);
          return bytes;
        }) as typeof handle.readFile;
        // The proof reads through handle.read; count every byte this handle returns.
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        let total = 0;
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await read(...readArgs);
          total += result.bytesRead;
          growth.maxRead = Math.max(growth.maxRead, total);
          return result;
        }) as typeof handle.read;
      }
      if (race.enabled && String(args[0]) === race.target) {
        const readFile = handle.readFile.bind(handle);
        handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
          const bytes = await readFile(...readArgs);
          if (!race.fired) {
            // Same interleaving through the proof's handle: bytes were read, then an external writer changes the file.
            race.fired = true;
            await actual.writeFile(race.target, race.replacement);
            const later = new Date(Date.now() + 2000);
            await actual.utimes(race.target, later, later);
            race.release!();
          }
          return bytes;
        }) as typeof handle.readFile;
        // Same interleaving through handle.read, which the proof uses.
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        handle.read = (async (...readArgs: unknown[]) => {
          const result = await read(...readArgs);
          if (!race.fired) {
            race.fired = true;
            await actual.writeFile(race.target, race.replacement);
            const later = new Date(Date.now() + 2000);
            await actual.utimes(race.target, later, later);
            race.release!();
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (race.enabled && String(args[0]) === race.target) await race.done;
      return actual.stat(...args);
    },
  };
});

let root: string;
let session: string;
let sequence = 0;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rv-cat-")));
  session = `rv-cat-${process.pid}-${++sequence}`;
});
afterEach(async () => {
  race.enabled = false;
  race.fired = false;
  growth.enabled = false;
  growth.fired = false;
  growth.maxRead = 0;
  race.release?.();
  await rm(root, { recursive: true, force: true });
});
function finished(stdout: string): ExecCommandToolOutput {
  return { output: stdout, stdout, stderr: "", exitCode: 0, exit_code: 0,
    durationMs: 1, wall_time_seconds: .001, timedOut: false, truncated: false, original_token_count: 1 };
}
async function cat(stdout: string, lightMode = true, cmd = "cat source.txt", onExec?: () => Promise<void>, shellArgs: { shell?: string; login?: boolean } = {}, managerShell?: string) {
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30000, shellStartupHooksPresent: () => false,
    ...(managerShell === undefined ? {} : { shellPath: managerShell }),
    execCommand: vi.fn(async () => { await onExec?.(); return finished(stdout); }),
    writeStdin: vi.fn(async () => finished("")),
    closeAll: vi.fn(async () => {}),
  };
  const tool = bindExplicitDangerBoundary(createExecCommandTool({
    cwd: root, allowedPaths: [root], lightMode, unifiedExecManager: manager,
  }));
  const result = await tool.execute({ cmd, ...shellArgs, [SESSION_ID_ARG]: session });
  expect(result.isError).not.toBe(true);
  expect(manager.execCommand).toHaveBeenCalledOnce();
  expect(String(result.content)).toContain(stdout);
}
async function edit() {
  return createFileEditTool({ allowedPaths: [root] }).execute({
    file_path: join(root, "source.txt"), old_string: "old", new_string: "new",
    cwd: root, [SESSION_ID_ARG]: session,
  });
}

test("control: normal Light cat authorizes an edit with CRLF preserved", async () => {
  await writeFile(join(root, "source.txt"), "old\r\n");
  await cat("old\r\n");
  expect((await edit()).isError).not.toBe(true);
  expect(await readFile(join(root, "source.txt"), "utf8")).toBe("new\r\n");
});
test("control: Standard cat does not authorize an edit", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  await cat("old\n", false);
  expect((await edit()).isError).toBe(true);
});
test("control: outside symlink does not establish an allowed read", async () => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "rv-cat-outside-")));
  try {
    const target = join(outside, "source.txt");
    await writeFile(target, "old\n");
    await symlink(target, join(root, "source.txt"));
    await cat("old\n");
    expect(getSessionReadSnapshot(session, target)).toBeUndefined();
    expect((await edit()).isError).toBe(true);
  } finally { await rm(outside, { recursive: true, force: true }); }
});
test("control: mutation after the recorded cat is rejected by Edit", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  await cat("old\n");
  await writeFile(file, "unseen change\nold\n");
  const later = new Date(Date.now() + 2000);
  await utimes(file, later, later);
  expect((await edit()).isError).toBe(true);
});
test("regression: mutation between snapshot bytes and stat must not bypass stale Edit", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  race.target = file;
  race.replacement = "unseen change\nold\n";
  race.done = new Promise<void>(resolve => { race.release = resolve; });
  race.enabled = true;
  try { await cat("old\n"); } finally { race.enabled = false; }
  const snapshot = getSessionReadSnapshot(session, file);
  if (snapshot !== undefined) {
    expect(await readFile(file, "utf8")).toBe("unseen change\nold\n");
    expect(snapshot.rawContent).toBe("old\n");
    expect(snapshot.timestamp).toBe((await stat(file)).mtimeMs);
  } else {
    expect(["old\n", "unseen change\nold\n"]).toContain(await readFile(file, "utf8"));
  }
  const result = await edit();
  expect(result.isError, "Edit must reject unseen current contents, even when stale old_string still matches").toBe(true);
});
test("regression: lossy UTF-8 equality must not establish byte-identical cat proof", async () => {
  const file = join(root, "source.txt");
  const observed = Buffer.from([0xff, 0x0a]);
  const current = Buffer.from([0xfe, 0x0a]);
  expect(observed.equals(current)).toBe(false);
  expect(observed.toString("utf8")).toBe(current.toString("utf8"));
  await writeFile(file, current);
  await cat(observed.toString("utf8"));
  expect(getSessionReadSnapshot(session, file), "Distinct byte sequences collapse to the same replacement-character string").toBeUndefined();
});


test("regression: post-exit FIFO replacement must not keep the finished exec waiting for a writer", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  let completed = false;
  let managerReturned = false;
  let managerFinished!: () => void;
  const managerBarrier = new Promise<void>(resolve => { managerFinished = resolve; });
  const result = cat("old\n", true, "cat source.txt", async () => {
    // Model-facing cat has finished successfully; another process replaces
    // the path before the runtime's optional read-proof postprocessing.
    await unlink(file);
    execFileSync("mkfifo", [file]);
    managerReturned = true;
    managerFinished();
  }).finally(() => { completed = true; });
  await managerBarrier;
  await new Promise(resolve => setTimeout(resolve, 250));
  const completedBeforeUnrelatedWriter = completed;
  const managerHadReturned = managerReturned;
  // Release every attempted FIFO read with bounded nonblocking writers. The
  // previous fixture released only the first of the implementation's two reads.
  // Preserve that timeout receipt; this version reaches the precise assertion.
  for (let attempt = 0; !completed && attempt < 100; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(fd, "old\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(completed, "Bounded fixture cleanup must release all FIFO readers").toBe(true);
  await result;
  expect(managerHadReturned).toBe(true);
  expect(getSessionReadSnapshot(session, file)).toBeUndefined();
  expect(completedBeforeUnrelatedWriter, "A successful completed exec must not depend on a later FIFO writer").toBe(true);
});


test("control: an actual cat step in a command chain authorizes the named file", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  const cmd = "cat source.txt; printf '%s\\n' done";
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  await cat(stdout, true, cmd);
  expect((await edit()).isError).not.toBe(true);
});

test("regression: a quoted cat example inside printf is not an executed read step", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  const cmd = "printf '%s\\n' '; cat source.txt; old'";
  // Real shell output, not invented tool metadata. The shell executes only
  // printf; semicolons and cat are characters inside one quoted argument.
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  expect(stdout).toBe("; cat source.txt; old\n");
  await cat(stdout, true, cmd);
  const result = await edit();
  expect(result.isError, "Printed shell source must not manufacture a read step and authorize Edit").toBe(true);
});


test("regression: double-quoted backslashes must not name a different file", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  await writeFile(join(root, "sou\\rce.txt"), "other\n");
  const cmd = String.raw`cat "sou\rce.txt"; printf '%s\n' old`;
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  expect(stdout).toBe("other\nold\n");
  await cat(stdout, true, cmd);
  expect((await edit()).isError, "The shell read sou-backslash-rce.txt, not source.txt").toBe(true);
});

test("regression: a short-circuited cat is not an executed read", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  const cmd = "false && cat source.txt; printf '%s\\n' old";
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  expect(stdout).toBe("old\n");
  await cat(stdout, true, cmd);
  expect((await edit()).isError, "The failed condition prevented cat from executing").toBe(true);
});

test("regression: growth after fstat must not defeat the 2 MiB snapshot bound", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  growth.target = file;
  growth.enabled = true;
  await cat("old\n", true, "head -n 1 source.txt");
  growth.enabled = false;
  expect(growth.fired, "The writer must run after the opened handle's stat").toBe(true);
  expect(getSessionReadSnapshot(session, file)).toBeUndefined();
  expect(growth.maxRead, "The optional proof must bound actual bytes read, even if the file grows").toBeLessThanOrEqual(2 * 1024 * 1024 + 1);
});


test("regression: successful early exit does not prove later read steps ran", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  const cmd = "printf '%s\\n' old; exit 0; cat source.txt";
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  expect(stdout).toBe("old\n");
  await cat(stdout, true, cmd);
  expect((await edit()).isError, "The shell exited before cat, so no named read occurred").toBe(true);
});

test("regression: successful exec replacement does not prove later read steps ran", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  const cmd = "exec /usr/bin/printf '%s\\n' old; cat source.txt";
  const stdout = execFileSync("/bin/sh", ["-c", cmd], {cwd: root, encoding: "utf8"});
  expect(stdout).toBe("old\n");
  await cat(stdout, true, cmd);
  expect((await edit()).isError, "exec replaced the shell before cat, so no named read occurred").toBe(true);
});

test.each([
  ["exit", "printf '%s\\n' old && exit 0; cat source.txt"],
  ["exec", "true && exec /usr/bin/printf '%s\\n' old; cat source.txt"],
])("regression: a filtered earlier and-list %s must still invalidate the whole chain", async (_label, cmd) => {
  await writeFile(join(root, "source.txt"), "old\n");
  const stdout = execFileSync("/bin/sh", ["-c", cmd], { cwd: root, encoding: "utf8" });
  expect(stdout).toBe("old\n");
  await cat(stdout, true, cmd);
  expect((await edit()).isError, "The earlier && step ended/replaced the shell before the named cat could execute").toBe(true);
});

test.each([
  ["/bin/bash", false, undefined, true],
  ["/bin/dash", false, undefined, true],
  ["/usr/bin/fish", false, undefined, false],
  ["/bin/bash", true, undefined, false],
  [undefined, false, "/usr/bin/fish", false],
  ["/bin/bash", false, "/usr/bin/fish", true],
  ["/usr/bin/fish", false, "/bin/bash", false],
] as const)("control: shell %s login %s manager default %s gates read recognition %s", async (shell, login, managerShell, shouldRecord) => {
  await writeFile(join(root, "source.txt"), "old\n");
  await cat("old\n", true, "cat source.txt", undefined, { ...(shell === undefined ? {} : { shell }), login }, managerShell);
  expect((await edit()).isError === true).toBe(!shouldRecord);
});
