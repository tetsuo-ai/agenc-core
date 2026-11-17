import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import { beginWorkspaceChanges } from "../../src/session/workspace-changes.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";

describe("C3 read-only workspace checkpoints", () => {
  it("finds shell writes, creates and deletes outside git, with applicable diffs", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-changes-"));
    try {
      await writeFile(join(root, "a.txt"), "before\n");
      await writeFile(join(root, "gone.txt"), "gone\n");
      const checkpoint = await beginWorkspaceChanges(root, true);
      execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'after\\n')", join(root, "a.txt")]);
      await writeFile(join(root, "new.txt"), "new\n");
      await rm(join(root, "gone.txt"));
      const result = await checkpoint.finish("t");
      expect(result.skipped).not.toBe(true);
      expect(result.files).toEqual([
        { path: "a.txt", op: "modified", added: 1, removed: 1 },
        { path: "gone.txt", op: "deleted", added: 0, removed: 1 },
        { path: "new.txt", op: "created", added: 1, removed: 0 },
      ]);
      const firstPatch = result.diff!.split('--- "a/gone.txt"')[0]!;
      expect(applyPatch("before\n", firstPatch)).toBe("after\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("leaves git state untouched and skips symlinks and protected paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-git-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "a.txt"), "before\n");
      execFileSync("git", ["-C", root, "add", "a.txt"]);
      const index = await readFile(join(root, ".git/index"));
      const head = await readFile(join(root, ".git/HEAD"));
      await mkdir(join(root, ".ssh"));
      await writeFile(join(root, ".ssh/fixture"), "not collected");
      await symlink("a.txt", join(root, "alias"));
      const checkpoint = await beginWorkspaceChanges(root, false);
      await writeFile(join(root, "a.txt"), "after\n");
      const result = await checkpoint.finish("t");
      expect(result.files.map(file => file.path)).toEqual(["a.txt"]);
      expect(result).not.toHaveProperty("diff");
      expect(await readFile(join(root, ".git/index"))).toEqual(index);
      expect(await readFile(join(root, ".git/HEAD"))).toEqual(head);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("skips oversized workspaces with a note and bounds diff output", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-limits-"));
    try {
      await writeFile(join(root, "a"), "a".repeat(80000));
      const small = await beginWorkspaceChanges(root, true, { bytes: 1 });
      expect(await small.finish("t")).toMatchObject({ skipped: true, files: [], note: "workspace size limit" });
      const checkpoint = await beginWorkspaceChanges(root, true);
      await writeFile(join(root, "a"), "b".repeat(80000));
      expect(await checkpoint.finish("t")).toMatchObject({ diffTruncated: true, diff: "", files: [{ path: "a", added: 1, removed: 1 }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("marks binary files and preserves a missing final newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-binary-"));
    try {
      await writeFile(join(root, "a.txt"), "before");
      await writeFile(join(root, "b.bin"), Buffer.from([0, 1]));
      const checkpoint = await beginWorkspaceChanges(root, true);
      await writeFile(join(root, "a.txt"), "after");
      await writeFile(join(root, "b.bin"), Buffer.from([0, 2]));
      const result = await checkpoint.finish("t");
      expect(result.files[1]).toEqual({ path: "b.bin", op: "modified", added: 0, removed: 0, binary: true });
      expect(applyPatch("before", result.diff!)).toBe("after");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("negotiates checkpoints for opted-in=%s clients", async enabled => {
    const sent: any[] = [], submissions: any[] = [];
    let connection: any;
    const event = { method: "event.session_event", params: { sessionId: "s", event: { type: "turn_changes", payload: { turnId: "t", from: "checkpoint", files: [] } } } };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { streamAgentMessage: async (params: any) => { submissions.push(params); await connection.sendNotification(event); return { disposition: "started", acceptedAt: "now" }; } } as never });
    connection = dispatcher.createConnection({ sendNotification: message => { sent.push(message); } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: enabled ? { "turn.changes.v1": true } : {} } })).toMatchObject({ result: { capabilities: { "turn.changes.v1": true } } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 2, method: "message.stream", params: { sessionId: "s", content: "test", ...(enabled ? { turnChanges: { includeDiff: true } } : {}) } })).toHaveProperty("result");
    expect(submissions[0].turnChanges).toEqual(enabled ? { includeDiff: true } : undefined);
    expect(sent).toEqual(enabled ? [event] : []);
    await connection.close();
  });
});
