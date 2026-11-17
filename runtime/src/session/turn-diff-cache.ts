export interface CachedFileDiff {
  readonly path: string;
  readonly diff?: string;
  readonly binary?: true;
  readonly diffTruncated?: true;
  readonly unavailable?: true;
  readonly note?: string;
}

/** Immutable turn patches, never a read of today's workspace. No disk persistence. */
export class TurnDiffCache {
  private readonly turns = new Map<string, { files: Map<string, CachedFileDiff>; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxTurns = 64, private readonly maxBytes = 4 * 1024 * 1024) {}
  put(runId: string, turnId: string, files: readonly CachedFileDiff[]): void {
    const key = JSON.stringify([runId, turnId]);
    const previous = this.turns.get(key);
    if (previous) { this.bytes -= previous.bytes; this.turns.delete(key); }
    const saved = new Map<string, CachedFileDiff>();
    let bytes = 0;
    for (const file of files.slice(0, 256)) {
      if (file.path.length > 512) continue;
      let copy = { ...file };
      if (Buffer.byteLength(file.diff ?? "") > 65536 || bytes + Buffer.byteLength(JSON.stringify(copy)) > 256 * 1024) {
        copy = { path: file.path, unavailable: true, note: "turn diff cache limit" };
      }
      bytes += Buffer.byteLength(JSON.stringify(copy));
      saved.set(file.path, copy);
    }
    this.turns.set(key, { files: saved, bytes });
    this.bytes += bytes;
    while (this.turns.size > this.maxTurns || this.bytes > this.maxBytes) {
      const oldest = this.turns.keys().next().value!;
      this.bytes -= this.turns.get(oldest)!.bytes;
      this.turns.delete(oldest);
    }
  }
  read(runId: string, turnId: string, path: string): CachedFileDiff {
    const file = this.turns.get(JSON.stringify([runId, turnId]))?.files.get(path);
    return file ? { ...file } : { path, unavailable: true, note: "turn file diff not retained" };
  }
}

export const turnDiffCache = new TurnDiffCache();
