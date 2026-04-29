/**
 * Error-log sidecar — buffered JSONL error writer with per-MCP-server
 * partitioning.
 *
 * Hand-port of AgenC `src/utils/errorLogSink.ts` (235 LOC) stripped
 * of its axios/bootstrap-state dependencies. The AgenC port integrates
 * with `SidecarManager` + `DegradedStore` for I-12/I-43.
 *
 * On-disk layout:
 *
 *   ~/.agenc/projects/<slug>/errors/
 *     <YYYY-MM-DD>.jsonl               # main error log
 *     mcp/<serverName>/<YYYY-MM-DD>.jsonl  # per-MCP-server partition
 *
 * Invariants wired here:
 *   I-12 (filesystem error handling) — writes catch ENOSPC/EROFS/EACCES/EIO
 *        and route to the sidecar's local DegradedStore.
 *   I-43 (per-sidecar isolation + reserved 64KB buffer) — on disk
 *        failure, diagnostics still land in `SidecarManager.reservedBuffer`
 *        so the error-log's own ENOSPC is never silent.
 *
 * @module
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { monotonicMs } from "./_deps/utils.js";
import type { Event } from "./event-log.js";
import { DegradedStore } from "./degraded-store.js";
import { isDegradedErrno } from "./session-store.js";
import type { Sidecar } from "./sidecar.js";

export interface ErrorLogEntry {
  readonly timestamp: string;
  readonly level: "error" | "warning" | "stream_error";
  readonly cause: string;
  readonly message: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly provider?: string;
  readonly server?: string;
  readonly stack?: string;
  readonly raw?: Event;
}

function dateToFilename(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Buffered JSONL writer — flushes on dispose or every N writes.
// ─────────────────────────────────────────────────────────────────────

interface BufferedWriter {
  write(line: string): void;
  flush(): void;
  dispose(): void;
}

interface BufferedWriterOpts {
  readonly path: string;
  readonly maxBufferSize?: number;
  readonly onDegradedError?: (err: unknown) => void;
}

function createBufferedWriter(opts: BufferedWriterOpts): BufferedWriter {
  let buffer: string[] = [];
  const maxBuf = opts.maxBufferSize ?? 32;
  let disposed = false;

  const writeDirectly = (content: string): boolean => {
    try {
      appendFileSync(opts.path, content, { mode: 0o600 });
      return true;
    } catch (err) {
      const dir = dirname(opts.path);
      if ((err as { code?: string }).code === "ENOENT") {
        try {
          mkdirSync(dir, { recursive: true });
          appendFileSync(opts.path, content, { mode: 0o600 });
          return true;
        } catch (err2) {
          if (isDegradedErrno(err2)) {
            opts.onDegradedError?.(err2);
            return false;
          }
          throw err2;
        }
      }
      if (isDegradedErrno(err)) {
        opts.onDegradedError?.(err);
        return false;
      }
      throw err;
    }
  };

  return {
    write(line: string): void {
      if (disposed) return;
      buffer.push(line);
      if (buffer.length >= maxBuf) this.flush();
    },
    flush(): void {
      if (buffer.length === 0) return;
      const content = buffer.join("");
      buffer = [];
      writeDirectly(content);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      this.flush();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// ErrorLogSidecar
// ─────────────────────────────────────────────────────────────────────

export interface ErrorLogSidecarOpts {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly onDiagnostic?: (d: {
    readonly cause: string;
    readonly message: string;
  }) => void;
}

export class ErrorLogSidecar implements Sidecar {
  readonly name = "error-log";
  private readonly errorsDir: string;
  private readonly mcpDir: string;
  private readonly sessionId: string;
  private readonly onDiagnostic?: (d: {
    cause: string;
    message: string;
  }) => void;
  private readonly writers = new Map<string, BufferedWriter>();
  private readonly degraded: DegradedStore<ErrorLogEntry>;

  constructor(opts: ErrorLogSidecarOpts) {
    this.errorsDir = join(opts.projectDir, "errors");
    this.mcpDir = join(this.errorsDir, "mcp");
    this.sessionId = opts.sessionId;
    this.onDiagnostic = opts.onDiagnostic;
    this.degraded = new DegradedStore<ErrorLogEntry>({
      flushFn: async (events) => this.replayDegraded(events),
    });
  }

  async start(): Promise<void> {
    try {
      mkdirSync(this.errorsDir, { recursive: true });
    } catch (err) {
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `errors dir mkdir failed: ${(err as { code?: string }).code}`,
        );
      } else {
        throw err;
      }
    }
    this.degraded.start();
  }

  async stop(): Promise<void> {
    for (const writer of this.writers.values()) {
      writer.dispose();
    }
    this.writers.clear();
    this.degraded.stop();
  }

  isDegraded(): boolean {
    return this.degraded.isDegraded;
  }

  onEvent(event: Event): void {
    const msg = event.msg;
    if (
      msg.type !== "error" &&
      msg.type !== "warning" &&
      msg.type !== "stream_error"
    ) {
      return;
    }
    const payload = msg.payload as {
      cause?: string;
      message?: string;
      provider?: string;
      stack?: string;
      turnId?: string;
      server?: string;
    };
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      level: msg.type,
      cause: payload.cause ?? "unknown",
      message: payload.message ?? "",
      sessionId: this.sessionId,
      ...(payload.turnId ? { turnId: payload.turnId } : {}),
      ...(payload.provider ? { provider: payload.provider } : {}),
      ...(payload.server ? { server: payload.server } : {}),
      ...(payload.stack ? { stack: payload.stack } : {}),
      raw: event,
    };

    if (this.degraded.isDegraded) {
      this.degraded.append(entry);
      return;
    }

    const path = this.pathFor(entry);
    const writer = this.getWriter(path);
    try {
      writer.write(`${JSON.stringify(entry)}\n`);
    } catch (err) {
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `write failed: ${(err as { code?: string }).code}`,
        );
        this.degraded.append(entry);
      } else {
        this.onDiagnostic?.({
          cause: "error_log_write_threw",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private pathFor(entry: ErrorLogEntry): string {
    if (entry.server) {
      return join(
        this.mcpDir,
        entry.server,
        `${dateToFilename(new Date(entry.timestamp))}.jsonl`,
      );
    }
    return join(this.errorsDir, `${dateToFilename(new Date(entry.timestamp))}.jsonl`);
  }

  private getWriter(path: string): BufferedWriter {
    let writer = this.writers.get(path);
    if (!writer) {
      writer = createBufferedWriter({
        path,
        onDegradedError: (err) => {
          this.degraded.enterDegraded(
            `buffered writer path=${path}: ${(err as { code?: string }).code ?? "unknown"}`,
          );
        },
      });
      this.writers.set(path, writer);
    }
    return writer;
  }

  private async replayDegraded(
    entries: ReadonlyArray<ErrorLogEntry>,
  ): Promise<boolean> {
    try {
      for (const entry of entries) {
        const path = this.pathFor(entry);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      }
      return true;
    } catch (err) {
      return !isDegradedErrno(err);
    }
  }

  /** Manual flush — used by shutdown path. */
  flushNow(): void {
    for (const writer of this.writers.values()) writer.flush();
  }

  /** Stats for telemetry. */
  getStats(): {
    readonly degraded: boolean;
    readonly partitionCount: number;
    readonly degradedBufferSize: number;
    readonly startedAtMs: number;
  } {
    return {
      degraded: this.degraded.isDegraded,
      partitionCount: this.writers.size,
      degradedBufferSize: this.degraded.size,
      startedAtMs: monotonicMs(),
    };
  }
}
