import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const THREAD_REGISTRY_FILENAME = "threads.json";

/** Shared across processes by the atomic creation of a project lock directory. */
export class ThreadRegistryLock {
  readonly path: string;
  private acquired = false;
  private token: string | undefined;

  constructor(projectDir: string) {
    this.path = `${join(projectDir, THREAD_REGISTRY_FILENAME)}.lock`;
  }

  acquire(): void {
    if (this.acquired) return;
    const deadline = Date.now() + 30_000;
    while (!this.tryAcquire()) {
      if (Date.now() >= deadline) throw new Error(`failed to acquire registry lock ${this.path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  /** One attempt that never waits: false while another live holder has the lock. */
  tryAcquire(): boolean {
    if (this.acquired) return true;
    mkdirSync(dirname(this.path), { recursive: true });
    // A second pass only follows the removal of a dead holder's lock.
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        mkdirSync(this.path);
        const token = `${process.pid}:${randomUUID()}`;
        try { writeFileSync(join(this.path, "holder.pid"), token, { encoding: "utf8", flag: "wx" }); }
        catch (error) {
          rmSync(this.path, { recursive: true, force: true });
          throw new Error(`failed to write registry lock holder ${this.path}`, { cause: error });
        }
        this.token = token;
        this.acquired = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`failed to acquire registry lock ${this.path}`, { cause: error });
        }
        if (!this.tryReclaimStaleLock()) return false;
      }
    }
    return false;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      if (this.token !== undefined && this.readHolderToken() === this.token) {
        rmSync(this.path, { recursive: true, force: true });
      }
    } finally {
      this.token = undefined;
      this.acquired = false;
    }
  }

  private readHolderToken(): string | undefined {
    try { return readFileSync(join(this.path, "holder.pid"), "utf8").trim(); }
    catch { return undefined; }
  }

  private holderIsStale(token: string | undefined): boolean {
    let holderPid: number | null = null;
    const pidText = token?.match(/^([1-9]\d*)(?::[0-9a-f-]+)?$/u)?.[1];
    if (pidText !== undefined) {
      const parsed = Number(pidText);
      if (Number.isSafeInteger(parsed)) holderPid = parsed;
    }
    if (holderPid !== null) {
      try {
        process.kill(holderPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    try { return Date.now() - statSync(this.path).mtimeMs >= 5_000; }
    catch { return false; }
  }

  private tryReclaimStaleLock(): boolean {
    const observed = this.readHolderToken();
    if (!this.holderIsStale(observed)) return false;
    // SQLite's writer reservation serializes reclaimers and is released even
    // if a process dies midway through reclaiming the stale directory.
    const gate = new DatabaseSync(`${this.path}.reclaim.sqlite`, { timeout: 0 });
    let held = false;
    try {
      try { gate.exec("BEGIN IMMEDIATE"); held = true; }
      catch (error) {
        if ((error as { errcode?: number }).errcode === 5) return false; // SQLITE_BUSY
        throw error;
      }
      if (this.readHolderToken() !== observed || !this.holderIsStale(observed)) return false;
      rmSync(this.path, { recursive: true, force: true });
      return true;
    } catch { return false; }
    finally {
      try { if (held) gate.exec("ROLLBACK"); }
      finally { gate.close(); }
    }
  }
}
