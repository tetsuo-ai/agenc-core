import { turnDiffCache } from "./turn-diff-cache.js";
import { Worker } from "node:worker_threads";

export interface TurnChanges {
  readonly turnId: string;
  readonly from: "checkpoint";
  readonly files: readonly { readonly path: string; readonly op: "created" | "modified" | "deleted"; readonly added: number; readonly removed: number; readonly binary?: boolean }[];
  readonly diff?: string;
  readonly diffTruncated?: boolean;
  readonly skipped?: boolean;
  readonly note?: string;
}

// Self-contained worker source survives bundling. No git command, index or disk snapshot.
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const excluded = new Set(['.git', '.agenc', '.ssh', '.codex', '.claude', 'node_modules', '.venv', 'vendor', 'dist', 'build']);
const note = 'Read-only workspace comparison. Excludes dependency/build directories, agent state, secret files and symlinks. Concurrent external edits may be included.';
const limits = workerData.limits;
let root;
function snapshot() {
  const files = new Map();
  let bytes = 0, entries = 0;
  const deadline = Date.now() + limits.timeMs;
  function walk(dir, depth) {
    if (depth > 32) throw Error('workspace depth limit');
    const handle = fs.opendirSync(dir);
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++entries > limits.entries || Date.now() > deadline) throw Error('workspace scan limit');
        const name = entry.name;
        if (excluded.has(name) || /^\.env(?:\.|$)/i.test(name) || /(?:credential|token|secret|wallet|keypair)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || /^id_(rsa|ed25519|ecdsa)/.test(name)) continue;
        const full = path.join(dir, name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        const real = fs.realpathSync(full);
        if (!real.startsWith(root + path.sep)) throw Error('workspace path changed');
        if (stat.isDirectory()) { walk(real, depth + 1); continue; }
        if (!stat.isFile()) continue;
        if (files.size >= limits.files || stat.size > limits.fileBytes || bytes + stat.size > limits.bytes) throw Error('workspace size limit');
        const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw Error('workspace changed during scan');
          const content = Buffer.alloc(opened.size);
          let offset = 0;
          while (offset < content.length) {
            if (Date.now() > deadline) throw Error('workspace scan limit');
            const n = fs.readSync(fd, content, offset, content.length - offset, offset);
            if (!n) throw Error('workspace changed during scan');
            offset += n;
          }
          const after = fs.fstatSync(fd);
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error('workspace changed during scan');
          bytes += content.length;
          files.set(path.relative(root, real).split(path.sep).join('/'), content);
        } finally { fs.closeSync(fd); }
      }
    } finally { handle.closeSync(); }
  }
  walk(root, 0);
  return files;
}
function lines(buffer) {
  if (!buffer.length) return [];
  const text = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(text).equals(buffer)) return null;
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}
function compare(before, after) {
  const files = [], fileDiffs = []; let diff = '', diffTruncated = false, fileDiffBytes = 0;
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const name of paths) {
    const old = before.get(name), next = after.get(name);
    if (old && next && old.equals(next)) continue;
    if (files.length >= 256) throw Error('changed file limit');
    const a = lines(old || Buffer.alloc(0)), b = lines(next || Buffer.alloc(0));
    if (name.length > 512) throw Error('changed path length limit');
    const op = !old ? 'created' : !next ? 'deleted' : 'modified';
    if (a === null || b === null) { files.push({ path: name, op, added: 0, removed: 0, binary: true }); fileDiffs.push({ path: name, binary: true }); continue; }
    let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const removed = a.length - start - end, added = b.length - start - end;
    files.push({ path: name, op, added, removed });
    const contextStart = Math.max(0, start - 3), contextEnd = Math.min(end, 3);
    const oldCount = a.length - end + contextEnd - contextStart;
    const newCount = b.length - end + contextEnd - contextStart;
    let patch = '--- ' + (old ? JSON.stringify('a/' + name) : '/dev/null') + '\n+++ ' + (next ? JSON.stringify('b/' + name) : '/dev/null') + '\n@@ -' + (oldCount ? contextStart + 1 : contextStart) + ',' + oldCount + ' +' + (newCount ? contextStart + 1 : contextStart) + ',' + newCount + ' @@\n';
    function append(prefix, line) { patch += prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'); }
    for (let i = contextStart; i < start; i++) append(' ', a[i]);
    for (let i = start; i < a.length - end; i++) append('-', a[i]);
    for (let i = start; i < b.length - end; i++) append('+', b[i]);
    for (let i = 0; i < contextEnd; i++) append(' ', a[a.length - end + i]);
    const patchBytes = Buffer.byteLength(patch);
    if (patchBytes > 65536) fileDiffs.push({ path: name, diffTruncated: true, unavailable: true, note: 'file diff exceeds 64 KiB' });
    else if (fileDiffBytes + patchBytes > 256 * 1024) fileDiffs.push({ path: name, unavailable: true, note: 'turn diff cache limit' });
    else { fileDiffs.push({ path: name, diff: patch }); fileDiffBytes += patchBytes; }
    if (workerData.includeDiff && !diffTruncated) {
      if (Buffer.byteLength(diff) + patchBytes > 65536) diffTruncated = true;
      else diff += patch;
    }
  }
  return { files, fileDiffs, note, ...(workerData.includeDiff ? { diff, ...(diffTruncated ? { diffTruncated: true } : {}) } : {}) };
}
try {
  root = fs.realpathSync(workerData.root);
  if (root === path.parse(root).root || root === os.homedir() || root.split(path.sep).some(p => ['.git', '.ssh', '.agenc', '.codex', '.claude'].includes(p))) throw Error('workspace root excluded');
  const before = snapshot();
  parentPort.postMessage({ ready: true });
  parentPort.once('message', () => {
    try { parentPort.postMessage(compare(before, snapshot())); }
    catch (error) { parentPort.postMessage({ files: [], skipped: true, note: error.message }); }
  });
} catch (error) { parentPort.postMessage({ files: [], skipped: true, note: error.message }); }
`;

export interface WorkspaceChangeCheckpoint { finish(turnId: string, runId?: string): Promise<TurnChanges>; dispose(): void }

/** Hard deadline on each scan. Idle workers retain at most 8 MiB of file data. */
export async function beginWorkspaceChanges(root: string, includeDiff: boolean, overrides: Partial<{
  timeMs: number; entries: number; files: number; fileBytes: number; bytes: number;
}> = {}): Promise<WorkspaceChangeCheckpoint> {
  let worker: Worker | undefined;
  let failure: { files: []; skipped: true; note: string } | undefined;
  const skip = (note: string) => ({ files: [] as [], skipped: true as const, note });
  const limits = { timeMs: 1000, entries: 10000, files: 2000, fileBytes: 256 * 1024, bytes: 8 * 1024 * 1024, ...overrides };
  const dispose = () => { void worker?.terminate(); worker = undefined; };
  const receive = (): Promise<any> => new Promise(resolve => {
    const active = worker!;
    const done = (value: unknown) => { clearTimeout(timer); active.off("message", message); active.off("error", error); active.off("exit", exit); resolve(value); };
    const message = (value: unknown) => done(value);
    const error = () => done(skip("workspace snapshot worker failed"));
    const exit = () => done(skip("workspace snapshot worker exited"));
    const timer = setTimeout(() => { done(skip("workspace snapshot deadline exceeded")); dispose(); }, limits.timeMs + 1000);
    active.once("message", message); active.once("error", error); active.once("exit", exit);
  });
  try {
    worker = new Worker(SOURCE, { eval: true, workerData: { root, includeDiff, limits }, resourceLimits: { maxOldGenerationSizeMb: 48, stackSizeMb: 4 } });
    const ready = await receive();
    if (!ready.ready) { failure = ready; dispose(); }
  } catch { failure = skip("workspace snapshot unavailable"); dispose(); }
  return {
    dispose,
    async finish(turnId, runId) {
      if (failure || !worker) {
        if (runId !== undefined) turnDiffCache.put(runId, turnId, []);
        return { turnId, from: "checkpoint", ...(failure ?? skip("workspace snapshot unavailable")) };
      }
      const result = receive();
      worker.postMessage("finish");
      const { fileDiffs = [], ...changes } = await result;
      if (runId !== undefined) turnDiffCache.put(runId, turnId, fileDiffs);
      dispose();
      return { turnId, from: "checkpoint", ...changes };
    },
  };
}
