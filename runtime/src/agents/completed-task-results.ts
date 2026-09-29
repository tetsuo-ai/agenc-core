/** Maximum retained result storage per reusable worker (1 MiB). */
export const MAX_COMPLETED_TASK_RESULT_BYTES = 1_024 * 1_024;

/** LRU front for the durable task journal. Oversized answers stay journal-only. */
export class CompletedTaskResults {
  private readonly entries = new Map<string, { text: string; bytes: number }>();
  private bytes = 0;

  constructor(readonly maxBytes = MAX_COMPLETED_TASK_RESULT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid result cache byte limit");
  }

  get retainedBytes(): number { return this.bytes; }
  get size(): number { return this.entries.size; }

  get(turnId: string): string | undefined {
    const entry = this.entries.get(turnId);
    if (entry === undefined) return undefined;
    this.entries.delete(turnId);
    this.entries.set(turnId, entry);
    return entry.text;
  }

  set(turnId: string, text: string): void {
    const previous = this.entries.get(turnId);
    if (previous !== undefined) {
      this.entries.delete(turnId);
      this.bytes -= previous.bytes;
    }
    // Charge both key and answer, allowing for UTF-16 storage and per-entry
    // overhead. Empty answers therefore cannot create an unbounded key map.
    const bytes = Math.max(Buffer.byteLength(text, "utf8"), text.length * 2) +
      Math.max(Buffer.byteLength(turnId, "utf8"), turnId.length * 2) + 128;
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(turnId, { text, bytes });
    this.bytes += bytes;
  }
}
