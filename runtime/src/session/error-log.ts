/**
 * Error-log sidecar — buffered JSONL error writer with per-MCP-server
 * partitioning.
 *
 * Hand-port of agenc `src/utils/errorLogSink.ts` (235 LOC) stripped
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
import { StateSqliteDriver } from "../state/sqlite-driver.js";
import { LogsRepository } from "../state/logs.js";
import { redactSecretsInValue } from "../secrets/index.js";
import { isRecord } from "../utils/record.js";

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
}

export interface ErrorLogClassification {
  readonly persist: boolean;
  readonly reason?: string;
}

function dateToFilename(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const INTERNAL_WARNING_CAUSES = new Set([
  "model_ui_spoof_pattern",
  "orphaned_turn_recovered",
  "provider_switched",
  "snapshot_behind_rollout",
  "stream_chunk_reordered",
  "system_resumed_from",
  "tool_routing_classified",
  "compact_prompt_build_slow",
  "compact_tool_result_dropped",
  "llm_request_metadata",
  "mode_changed",
  "mode_changed_to_plan",
  "mode_exited_plan",
  "memory_extract_failed",
  "memory_extract_parse_failed",
  "memory_extract_timeout",
]);

function payloadRecord(event: Event): Record<string, unknown> {
  const payload = (event.msg as { readonly payload?: unknown }).payload;
  return isRecord(payload) ? payload : {};
}

export function classifyErrorLogEvent(event: Event): ErrorLogClassification {
  const msg = event.msg;
  if (
    msg.type !== "error" &&
    msg.type !== "warning" &&
    msg.type !== "stream_error"
  ) {
    return { persist: false, reason: "non_error" };
  }

  const payload = payloadRecord(event);
  const visibility = payload.visibility;
  const surface = payload.surface;
  if (
    visibility === "internal" ||
    visibility === "debug" ||
    surface === "internal" ||
    surface === "debug" ||
    surface === "diagnostic"
  ) {
    return { persist: false, reason: "internal" };
  }

  if (
    msg.type === "warning" &&
    typeof payload.cause === "string" &&
    INTERNAL_WARNING_CAUSES.has(payload.cause)
  ) {
    return { persist: false, reason: "internal" };
  }

  return { persist: true };
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
  private readonly stateDriver: StateSqliteDriver;
  private readonly logsRepository: LogsRepository;

  constructor(opts: ErrorLogSidecarOpts) {
    this.errorsDir = join(opts.projectDir, "errors");
    this.mcpDir = join(this.errorsDir, "mcp");
    this.sessionId = opts.sessionId;
    this.onDiagnostic = opts.onDiagnostic;
    this.degraded = new DegradedStore<ErrorLogEntry>({
      flushFn: async (events) => this.replayDegraded(events),
    });
    this.stateDriver = new StateSqliteDriver({
      projectDir: opts.projectDir,
      stateDbPath: join(opts.projectDir, "agenc-state_1.sqlite"),
      logsDbPath: join(opts.projectDir, "agenc-logs_1.sqlite"),
    });
    this.logsRepository = new LogsRepository(this.stateDriver);
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
    this.stateDriver.close();
    this.degraded.stop();
  }

  isDegraded(): boolean {
    return this.degraded.isDegraded;
  }

  onEvent(event: Event): void {
    const classification = classifyErrorLogEvent(event);
    if (!classification.persist) {
      return;
    }
    const msg = event.msg;
    const payload = payloadRecord(event) as {
      cause?: string;
      message?: string;
      provider?: string;
      stack?: string;
      turnId?: string;
      server?: string;
    };
    const level =
      msg.type === "stream_error"
        ? "stream_error"
        : msg.type === "warning"
          ? "warning"
          : "error";
    const entry: ErrorLogEntry = redactSecretsInValue({
      timestamp: new Date().toISOString(),
      level,
      cause: payload.cause ?? "unknown",
      message: payload.message ?? "",
      sessionId: this.sessionId,
      ...(payload.turnId ? { turnId: payload.turnId } : {}),
      ...(payload.provider ? { provider: payload.provider } : {}),
      ...(payload.server ? { server: payload.server } : {}),
      ...(payload.stack ? { stack: payload.stack } : {}),
    }) as ErrorLogEntry;

    if (this.degraded.isDegraded) {
      this.degraded.append(entry);
      return;
    }

    const path = this.pathFor(entry);
    const writer = this.getWriter(path);
    try {
      writer.write(`${JSON.stringify(entry)}\n`);
      this.logsRepository.tryAppend({
        timestamp: entry.timestamp,
        level: entry.level,
        scope: entry.server ? "mcp" : "runtime",
        threadId: entry.sessionId,
        eventType: entry.cause,
        message: entry.message,
        payload: entry,
      });
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
        const sanitized = redactSecretsInValue(entry) as ErrorLogEntry;
        const path = this.pathFor(sanitized);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
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
