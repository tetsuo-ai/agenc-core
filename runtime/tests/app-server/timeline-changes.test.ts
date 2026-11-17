import { TurnDiffCache, turnDiffCache } from "../../src/session/turn-diff-cache.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
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
      turnDiffCache.put("diff-limits", "skipped", [{ path: "a", diff: "previous" }]);
      const small = await beginWorkspaceChanges(root, true, { bytes: 1 });
      expect(await small.finish("skipped", "diff-limits")).toMatchObject({ skipped: true, files: [], note: "workspace size limit" });
      expect(turnDiffCache.read("diff-limits", "skipped", "a").unavailable).toBe(true);
      const checkpoint = await beginWorkspaceChanges(root, true);
      await writeFile(join(root, "a"), "b".repeat(80000));
      expect(await checkpoint.finish("large", "diff-limits")).toMatchObject({ diffTruncated: true, diff: "", files: [{ path: "a", added: 1, removed: 1 }] });
      expect(turnDiffCache.read("diff-limits", "large", "a")).toMatchObject({ unavailable: true, diffTruncated: true });
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
      const result = await checkpoint.finish("binary", "diff-limits");
      expect(turnDiffCache.read("diff-limits", "binary", "b.bin")).toEqual({ path: "b.bin", binary: true });
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

it("retains immutable per-file patches without sending a turn diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "timeline-file-diff-"));
  try {
    await writeFile(join(root, "a.txt"), "before\n");
    const checkpoint = await beginWorkspaceChanges(root, false);
    await writeFile(join(root, "a.txt"), "after\n");
    await writeFile(join(root, "b.txt"), "other\n");
    const changes = await checkpoint.finish("file-turn", "file-run");
    expect(changes).not.toHaveProperty("diff");
    expect(changes).not.toHaveProperty("fileDiffs");
    await writeFile(join(root, "a.txt"), "later\n");
    const result = turnDiffCache.read("file-run", "file-turn", "a.txt");
    expect(applyPatch("before\n", result.diff!)).toBe("after\n");
    expect(result.diff).not.toContain("b.txt");
    expect(turnDiffCache.read("other-run", "file-turn", "a.txt").unavailable).toBe(true);
    expect(turnDiffCache.read("file-run", "file-turn", "../a.txt").unavailable).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("bounds cached patches and turn retention", () => {
  const cache = new TurnDiffCache(2, 1024);
  cache.put("r", "1", [{ path: "a", diff: "one" }]);
  cache.put("r", "2", [{ path: "a", diff: "two" }]);
  cache.put("r", "3", [{ path: "a", diff: "three" }]);
  expect(cache.read("r", "1", "a").unavailable).toBe(true);
  cache.put("r", "4", [{ path: "a", diff: "x".repeat(70000) }]);
  expect(cache.read("r", "4", "a").unavailable).toBe(true);
  cache.put("r", "5", [{ path: "a", diff: "x".repeat(1100) }]);
  expect(cache.read("r", "5", "a").unavailable).toBe(true);
});
it.each([{}, { "turn.changes.v1": true }, { "turn.changes.v1": true, "turn.diff.read.v1": true }])("gates the per-file RPC on both capabilities: %j", async capabilities => {
  const reads: any[] = [];
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { readSessionTurnDiff: async (params: any) => { reads.push(params); return { ...params, diff: "patch" }; } } as never });
  const connection = dispatcher.createConnection();
  expect(await connection.dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities } })).toMatchObject({ result: { capabilities: { "turn.diff.read.v1": true } } });
  const response = await connection.dispatch({ jsonrpc: "2.0", id: 2, method: "session.turn.diff", params: { sessionId: "s", turnId: "t", path: "a" } });
  if ("turn.diff.read.v1" in capabilities) {
    expect(response).toMatchObject({ result: { sessionId: "s", turnId: "t", path: "a", diff: "patch" } });
    expect(await connection.dispatch({ jsonrpc: "2.0", id: 3, method: "session.turn.diff", params: { sessionId: "s", turnId: "t", path: "x".repeat(513) } })).toHaveProperty("error");
    expect(reads).toHaveLength(1);
  } else { expect(response).toHaveProperty("error"); expect(reads).toHaveLength(0); }
  await connection.close();
});
it("checks session resolution and the visible turn before reading the cache", async () => {
  turnDiffCache.put("visible-run", "t", [{ path: "a", diff: "patch" }]);
  const read = AgenCDaemonAgentManager.prototype.readSessionTurnDiff;
  const params = { sessionId: "s", turnId: "t", path: "a" };
  const visible = { getSessionTranscriptV2: async () => ({ runId: "visible-run", turns: [{ turnId: "t" }] }) };
  expect(await read.call(visible as never, params)).toMatchObject({ diff: "patch" });
  expect(await read.call({ getSessionTranscriptV2: async () => ({ runId: "visible-run", turns: [] }) } as never, params)).toMatchObject({ unavailable: true });
  await expect(read.call({ getSessionTranscriptV2: async () => { throw Error("session denied"); } } as never, params)).rejects.toThrow("session denied");
});
