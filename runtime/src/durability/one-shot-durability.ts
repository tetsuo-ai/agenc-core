import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** A client request is only a candidate; daemon ingress rechecks its surface. */
export function selectRelaxedOneShot(input: {
  readonly requested?: boolean;
  readonly nonInteractive?: boolean;
  readonly source?: unknown;
  readonly mode?: unknown;
  readonly resumed?: boolean;
  readonly routine?: boolean;
  readonly goal?: boolean;
}): boolean {
  return input.requested === true && input.nonInteractive === true &&
    input.source === "agenc.prompt" && input.mode === "one-shot" &&
    !input.resumed && !input.routine && !input.goal;
}

export class OneShotRecoveryError extends Error {
  constructor(message: string) {
    super(`one-shot recovery refused: ${message}; uncertain effects require review`);
    this.name = "OneShotRecoveryError";
  }
}

interface Seal {
  readonly schema: 1;
  readonly runId: string;
  readonly rollout: string;
  readonly phase: "active" | "sealed";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface OneShotWriterAuthority {
  readonly projectDir: string;
  readonly runId: string;
  readonly rolloutPath: string;
  relaxed: boolean;
  seal(): void;
  promote(): void;
  release(): void;
}

const writers = new Map<string, OneShotWriterAuthority>();
// This context exists only during a synchronous, explicitly run-bound write.
// An async queue drain cannot inherit a different client's durability choice.
let writeScope: { readonly projectDir: string; readonly runId: string } | undefined;

export function withOneShotWriteScope<T>(projectDir: string, runId: string, operation: () => T): T {
  const previous = writeScope;
  writeScope = { projectDir: resolve(projectDir), runId };
  try { return operation(); } finally { writeScope = previous; }
}

export function relaxedOneShotTransaction(projectDir: string, runId?: string): boolean {
  const project = resolve(projectDir);
  const selected = writeScope?.projectDir === project ? writeScope.runId : runId;
  if (selected === undefined) return false;
  return [...writers.values()].some(w => w.projectDir === project && w.runId === selected && w.relaxed);
}

export function promoteOneShotRun(runId: string): void {
  for (const writer of writers.values()) if (writer.runId === runId && writer.relaxed) writer.promote();
}

function markerPath(rolloutPath: string): string { return `${rolloutPath}.durability.json`; }
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeMarker(rolloutPath: string, marker: Seal): void {
  const target = markerPath(rolloutPath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(marker) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, target); syncDirectory(dirname(target));
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function contentProof(fd: number): { bytes: number; sha256: string } {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OneShotRecoveryError("canonical source is not a single regular file");
  }
  const bytes = Number(before.size);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (count === 0) throw new OneShotRecoveryError("canonical source shortened during verification");
    hash.update(buffer.subarray(0, count)); offset += count;
  }
  const after = fstatSync(fd, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new OneShotRecoveryError("canonical source changed during verification");
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Check before any tail repair, replay or projection recovery. */
export function assertOneShotRecoverable(rolloutPath: string, sourceFd?: number): void {
  const path = resolve(rolloutPath);
  if (writers.has(path)) return; // Only the live writer has complete process evidence.
  let markerFd: number;
  try { markerFd = openSync(markerPath(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new OneShotRecoveryError("durability marker is unreadable");
  }
  let marker: Seal;
  try {
    const stat = fstatSync(markerFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024) throw new Error("invalid marker file");
    marker = JSON.parse(readFileSync(markerFd, "utf8")) as Seal;
    if (marker?.schema !== 1 || marker.rollout !== basename(path) || marker.runId !== basename(dirname(path)) ||
        marker.phase !== "sealed" || !Number.isSafeInteger(marker.bytes) || (marker.bytes ?? -1) < 0 ||
        typeof marker.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.sha256)) {
      throw new Error("missing completed seal");
    }
  } catch { throw new OneShotRecoveryError("relaxed run has no valid durable completion seal"); }
  finally { closeSync(markerFd); }
  const fd = sourceFd ?? openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const proof = contentProof(fd);
    if (proof.bytes !== marker.bytes || proof.sha256 !== marker.sha256) {
      throw new OneShotRecoveryError("canonical history differs from its durable completion seal");
    }
  } finally { if (sourceFd === undefined) closeSync(fd); }
}

/** Called only under the canonical writer lease, before full-mode mutation. */
export function consumeOneShotSeal(rolloutPath: string, sourceFd?: number): void {
  assertOneShotRecoverable(rolloutPath, sourceFd);
  if (existsSync(markerPath(rolloutPath))) {
    unlinkSync(markerPath(rolloutPath)); syncDirectory(dirname(rolloutPath));
  }
}

export function beginOneShotWriter(input: {
  readonly rolloutPath: string;
  readonly runId: string;
  readonly flushAndSync: () => void;
  readonly checkpoint: () => void;
}): OneShotWriterAuthority {
  const path = resolve(input.rolloutPath);
  const projectDir = dirname(dirname(dirname(path)));
  if (basename(dirname(path)) !== input.runId || writers.has(path) || existsSync(markerPath(path))) {
    throw new OneShotRecoveryError("writer is not a fresh uniquely bound run");
  }
  const base = { schema: 1 as const, runId: input.runId, rollout: basename(path) };
  writeMarker(path, { ...base, phase: "active" });
  // Newly created session/project directory entries must survive before work.
  for (const directory of [dirname(dirname(path)), projectDir, dirname(projectDir), dirname(dirname(projectDir))]) syncDirectory(directory);
  const authority: OneShotWriterAuthority = {
    projectDir, runId: input.runId, rolloutPath: path, relaxed: true,
    seal() {
      if (!authority.relaxed) return;
      input.flushAndSync();
      input.checkpoint();
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        fsyncSync(fd);
        try { writeMarker(path, { ...base, phase: "sealed", ...contentProof(fd) }); }
        catch (error) {
          // Publication may have renamed before the directory sync failed.
          // Revoke that apparent seal; preserve the original error too.
          try { writeMarker(path, { ...base, phase: "active" }); }
          catch (revokeError) { throw new AggregateError([error, revokeError], "one-shot seal publication and revocation failed"); }
          throw error;
        }
      } finally { closeSync(fd); }
      authority.relaxed = false;
    },
    promote() {
      authority.seal();
      // The exact prefix is now fully durable; all subsequent writes are FULL.
      unlinkSync(markerPath(path)); syncDirectory(dirname(path));
    },
    release() { writers.delete(path); },
  };
  writers.set(path, authority);
  return authority;
}
