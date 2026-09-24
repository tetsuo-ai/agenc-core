import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const THREAD_REGISTRY_FILENAME = "threads.json";

/** Shared across processes by the atomic creation of a project lock directory. */
export class ThreadRegistryLock {
  readonly path: string;
  private acquired = false;

  constructor(projectDir: string) {
    this.path = `${join(projectDir, THREAD_REGISTRY_FILENAME)}.lock`;
  }

  acquire(): void {
    if (this.acquired) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + 30_000;
    const holderFile = join(this.path, "holder.pid");
    while (true) {
      try {
        mkdirSync(this.path);
        try { writeFileSync(holderFile, `${process.pid}`, "utf8"); }
        catch { /* The directory itself is the lock; the pid aids recovery. */ }
        this.acquired = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`failed to acquire registry lock ${this.path}`, { cause: error });
        }
        if (this.tryReclaimStaleLock(holderFile)) continue;
        if (Date.now() >= deadline) throw new Error(`failed to acquire registry lock ${this.path}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  release(): void {
    if (!this.acquired) return;
    try { rmSync(this.path, { recursive: true, force: true }); }
    finally { this.acquired = false; }
  }

  private tryReclaimStaleLock(holderFile: string): boolean {
    let holderPid: number | null = null;
    try {
      const parsed = Number.parseInt(readFileSync(holderFile, "utf8").trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) holderPid = parsed;
    } catch { /* A holder may not have written its pid yet. */ }
    if (holderPid !== null) {
      try {
        process.kill(holderPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    } else {
      try {
        if (Date.now() - statSync(this.path).mtimeMs < 5_000) return false;
      } catch { return true; }
    }
    try {
      rmSync(this.path, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }
}
