// Reviewer regressions and controls (rv, 2026-10-02) for the Light plain-cat read proof.
import { mkdtemp, realpath, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createExecCommandTool } from "./exec-command.js";
import { createFileEditTool } from "./file-edit.js";
import { getSessionReadSnapshot, SESSION_ID_ARG } from "./filesystem.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../../unified-exec/types.js";

const race = vi.hoisted(() => ({
  target: "", replacement: "", enabled: false,
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
  race.release?.();
  await rm(root, { recursive: true, force: true });
});
function finished(stdout: string): ExecCommandToolOutput {
  return { output: stdout, stdout, stderr: "", exitCode: 0, exit_code: 0,
    durationMs: 1, wall_time_seconds: .001, timedOut: false, truncated: false, original_token_count: 1 };
}
async function cat(stdout: string, lightMode = true, cmd = "cat source.txt") {
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: 30000,
    execCommand: vi.fn(async () => finished(stdout)),
    writeStdin: vi.fn(async () => finished("")),
    closeAll: vi.fn(async () => {}),
  };
  const tool = bindExplicitDangerBoundary(createExecCommandTool({
    cwd: root, allowedPaths: [root], lightMode, unifiedExecManager: manager,
  }));
  const result = await tool.execute({ cmd, [SESSION_ID_ARG]: session });
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
    // No proof recorded. The lead's fix reads the bytes on both sides of the stats, so the injected
    // mutation is detected (second read differs) instead of never happening; the file may have changed.
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
