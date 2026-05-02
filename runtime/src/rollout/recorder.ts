/**
 * Ports upstream Rust `rollout/src/recorder.rs` into a synchronous Node JSONL
 * recorder. It writes schema-stamped rollout lines, fsyncs on request, and
 * mirrors latest metadata into the append-only session index.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../app-server/protocol/index.js";
import {
  AGENC_ROLLOUT_SESSIONS_DIR,
  buildAgenCRolloutFileName,
  buildAgenCRolloutMetadata,
} from "./metadata.js";
import { shouldPersistRolloutItem, type AgenCRolloutPersistenceMode } from "./policy.js";
import { AgenCRolloutSessionIndex } from "./session-index.js";
import {
  AGENC_ROLLOUT_LINE_FORMAT,
  AGENC_ROLLOUT_SCHEMA_VERSION,
  type AgenCRolloutLine,
  type AgenCRolloutRecorderOptions,
  type AgenCRolloutSessionMetadata,
} from "./types.js";

const PERSISTED_EXEC_AGGREGATED_OUTPUT_MAX_BYTES = 10_000;

export class AgenCRolloutRecorder {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly index: AgenCRolloutSessionIndex;
  readonly createdAt: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly source?: string;
  readonly traceBundlePath?: string;
  readonly fsync: boolean;
  #fd: number | undefined;
  #seq = 0;
  #updatedAt: string;

  constructor(options: AgenCRolloutRecorderOptions) {
    this.rootDir = options.rootDir;
    this.sessionId = options.sessionId;
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.#updatedAt = this.createdAt;
    this.cwd = options.cwd;
    this.name = options.name;
    this.source = options.source;
    this.traceBundlePath = options.traceBundlePath;
    this.fsync = options.fsync === true;
    const sessionsDir = join(options.rootDir, AGENC_ROLLOUT_SESSIONS_DIR);
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    this.rolloutPath = join(
      sessionsDir,
      buildAgenCRolloutFileName(options.sessionId, this.createdAt),
    );
    this.index = new AgenCRolloutSessionIndex(options.rootDir);
    const existingLines = readAgenCRolloutLines(this.rolloutPath);
    const lastLine = existingLines.at(-1);
    if (lastLine !== undefined) {
      this.#seq = lastLine.seq;
      this.#updatedAt = lastLine.writtenAt;
    }
    this.#fd = openSync(
      this.rolloutPath,
      existsSync(this.rolloutPath) ? "a" : "wx",
      0o600,
    );
    this.index.append(this.metadata());
  }

  append(
    item: JsonValue,
    options: {
      readonly now?: () => string;
      readonly persistenceMode?: AgenCRolloutPersistenceMode;
    } = {},
  ): AgenCRolloutLine | undefined {
    const fd = this.#openFd();
    if (!shouldPersistRolloutItem(item, options.persistenceMode)) {
      return undefined;
    }
    const line: AgenCRolloutLine = {
      format: AGENC_ROLLOUT_LINE_FORMAT,
      schemaVersion: AGENC_ROLLOUT_SCHEMA_VERSION,
      seq: this.#seq + 1,
      sessionId: this.sessionId,
      writtenAt: options.now?.() ?? new Date().toISOString(),
      item: sanitizeAgenCRolloutItemForPersistence(
        item,
        options.persistenceMode ?? "limited",
      ),
    };
    writeSync(fd, `${JSON.stringify(line)}\n`, undefined, "utf8");
    this.#seq = line.seq;
    this.#updatedAt = line.writtenAt;
    if (this.fsync) fsyncSync(fd);
    this.index.append(this.metadata());
    return line;
  }

  flush(): void {
    const fd = this.#fd;
    if (fd !== undefined) fsyncSync(fd);
  }

  close(): void {
    const fd = this.#fd;
    if (fd === undefined) return;
    if (this.fsync) fsyncSync(fd);
    closeSync(fd);
    this.#fd = undefined;
    this.index.append(this.metadata());
  }

  metadata(): AgenCRolloutSessionMetadata {
    const stats = this.#fd === undefined
      ? { size: existsSync(this.rolloutPath) ? statSync(this.rolloutPath).size : 0 }
      : fstatSync(this.#fd);
    return buildAgenCRolloutMetadata({
      sessionId: this.sessionId,
      rolloutPath: this.rolloutPath,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      eventCount: this.#seq,
      byteLength: stats.size,
      ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(this.source !== undefined ? { source: this.source } : {}),
      ...(this.traceBundlePath !== undefined
        ? { traceBundlePath: this.traceBundlePath }
        : {}),
    });
  }

  #openFd(): number {
    if (this.#fd === undefined) {
      throw new Error(`rollout recorder is closed for session ${this.sessionId}`);
    }
    return this.#fd;
  }
}

export function readAgenCRolloutLines(path: string): AgenCRolloutLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseAgenCRolloutLine(line));
}

function parseAgenCRolloutLine(line: string): AgenCRolloutLine {
  const parsed = JSON.parse(line) as Partial<AgenCRolloutLine>;
  if (
    parsed.format !== AGENC_ROLLOUT_LINE_FORMAT ||
    parsed.schemaVersion !== AGENC_ROLLOUT_SCHEMA_VERSION ||
    typeof parsed.seq !== "number" ||
    !Number.isFinite(parsed.seq) ||
    typeof parsed.sessionId !== "string" ||
    parsed.sessionId.length === 0 ||
    typeof parsed.writtenAt !== "string" ||
    parsed.writtenAt.length === 0 ||
    parsed.item === undefined
  ) {
    throw new Error("malformed rollout JSONL row");
  }
  return parsed as AgenCRolloutLine;
}

function sanitizeAgenCRolloutItemForPersistence(
  item: JsonValue,
  mode: AgenCRolloutPersistenceMode,
): JsonValue {
  if (mode !== "extended") return item;
  const object = asJsonRecord(item);
  if (object === undefined) return item;

  const directEvent = sanitizeExecCommandEndEvent(object);
  if (directEvent !== object) return directEvent;

  if (readString(object.type) !== "event_msg") return item;
  const event = asJsonRecord(object.event ?? object.payload);
  if (event === undefined) return item;
  const sanitizedEvent = sanitizeEventEnvelope(event);
  const eventKey = object.event !== undefined ? "event" : "payload";
  return sanitizedEvent === event ? item : { ...object, [eventKey]: sanitizedEvent };
}

function sanitizeEventEnvelope(
  event: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const message = asJsonRecord(event.msg);
  if (message === undefined) return sanitizeExecCommandEndEvent(event);
  const sanitizedMessage = sanitizeExecCommandEndEvent(message);
  return sanitizedMessage === message ? event : { ...event, msg: sanitizedMessage };
}

function sanitizeExecCommandEndEvent(
  event: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (readString(event.type) !== "exec_command_end") return event;
  const payload = asJsonRecord(event.payload);
  if (payload !== undefined) {
    return {
      ...event,
      payload: sanitizeExecCommandPayload(payload),
    };
  }
  return sanitizeExecCommandPayload(event);
}

function sanitizeExecCommandPayload(
  event: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const sanitized: Record<string, JsonValue> = { ...event };
  const aggregatedOutput = readString(sanitized.aggregated_output) ??
    aggregateCommandOutput(sanitized);
  if (aggregatedOutput !== undefined) {
    sanitized.aggregated_output = truncateMiddleChars(
      aggregatedOutput,
      PERSISTED_EXEC_AGGREGATED_OUTPUT_MAX_BYTES,
    );
  }
  const aggregatedOutputCamel = readString(sanitized.aggregatedOutput);
  if (aggregatedOutputCamel !== undefined) {
    sanitized.aggregatedOutput = truncateMiddleChars(
      aggregatedOutputCamel,
      PERSISTED_EXEC_AGGREGATED_OUTPUT_MAX_BYTES,
    );
  }
  if ("stdout" in sanitized) sanitized.stdout = "";
  if ("stderr" in sanitized) sanitized.stderr = "";
  if ("formatted_output" in sanitized) sanitized.formatted_output = "";
  if ("formattedOutput" in sanitized) sanitized.formattedOutput = "";
  return sanitized;
}

function aggregateCommandOutput(
  event: Record<string, JsonValue>,
): string | undefined {
  const parts = [readString(event.stdout), readString(event.stderr)]
    .filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function truncateMiddleChars(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const prefix = takeUtf8Prefix(value, leftBudget);
  const suffix = takeUtf8Suffix(value, rightBudget);
  const removedChars = Math.max(
    0,
    [...value].length - [...prefix].length - [...suffix].length,
  );
  return `${prefix}...${removedChars} chars truncated...${suffix}`;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const char of [...value].reverse()) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out = `${char}${out}`;
    used += size;
  }
  return out;
}

function asJsonRecord(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
