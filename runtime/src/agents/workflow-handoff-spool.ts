/** Synchronous, backpressured disk spool for workflow child output deltas. */

import { createHash, type Hash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantOutputStreamSink } from "../contracts/assistant-output-stream.js";
import type { AtomicArtifactByteSource } from "../durability/atomic-artifact.js";
import { estimateUtf8TokenUnits } from "../llm/token-accounting.js";
import { assertWindowsPrivatePathSecurity } from "./workflow-private-path.js";

const SPOOL_DIRECTORY_PREFIX = "agenc-workflow-handoff-";
const SPOOL_FILENAME = "output.spool";
const SPOOL_DIRECTORY_MODE = 0o700;
const SPOOL_FILE_MODE = 0o600;
const SPOOL_READ_BYTES = 64 * 1_024;
const SPOOL_WRITE_CODE_UNITS = 16 * 1_024;

export class WorkflowHandoffSpoolLimitError extends Error {
  readonly code = "WORKFLOW_HANDOFF_SPOOL_LIMIT" as const;

  constructor(readonly maximumBytes: number) {
    super(`workflow child output exceeds ${maximumBytes} UTF-8 bytes`);
    this.name = "WorkflowHandoffSpoolLimitError";
  }
}

export class WorkflowHandoffSpoolTokenLimitError extends Error {
  readonly code = "WORKFLOW_HANDOFF_SPOOL_TOKEN_LIMIT" as const;

  constructor(readonly maximumTokens: number) {
    super(`workflow child output exceeds ${maximumTokens} accounted tokens`);
    this.name = "WorkflowHandoffSpoolTokenLimitError";
  }
}

export interface WorkflowHandoffSpoolOptions {
  readonly maximumBytes: number;
  readonly maximumTokens: number;
  readonly onLimit?: (error: Error) => void;
}

/**
 * The provider callback is synchronous, so disk writes are synchronous too:
 * no promise queue can retain unbounded deltas when storage is slower than the
 * network. Only a possible trailing UTF-16 high surrogate is held in memory.
 */
export class WorkflowHandoffSpool implements AssistantOutputStreamSink {
  readonly #root: string;
  readonly #path: string;
  readonly #fd: number;
  readonly #maximumBytes: number;
  readonly #maximumTokens: number;
  readonly #onLimit: ((error: Error) => void) | undefined;
  #hash: Hash = createHash("sha256");
  #byteLength = 0;
  #tokenCount = 0;
  #pendingHighSurrogate = "";
  #sealed = false;
  #disposed = false;
  #failure: Error | undefined;
  #sha256: string | undefined;

  private constructor(
    root: string,
    path: string,
    fd: number,
    options: WorkflowHandoffSpoolOptions,
  ) {
    this.#root = root;
    this.#path = path;
    this.#fd = fd;
    this.#maximumBytes = options.maximumBytes;
    this.#maximumTokens = options.maximumTokens;
    this.#onLimit = options.onLimit;
  }

  static create(options: WorkflowHandoffSpoolOptions): WorkflowHandoffSpool {
    if (
      !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 1 ||
      !Number.isSafeInteger(options.maximumTokens) ||
      options.maximumTokens < 1
    ) {
      throw new TypeError("workflow handoff spool maximum must be positive");
    }
    const root = mkdtempSync(join(tmpdir(), SPOOL_DIRECTORY_PREFIX));
    const path = join(root, SPOOL_FILENAME);
    let fd: number | undefined;
    try {
      if (process.platform === "win32") {
        assertWindowsPrivatePathSecurity(root, "directory", true);
      } else {
        chmodSync(root, SPOOL_DIRECTORY_MODE);
      }
      fd = openSync(
        path,
        fsConstants.O_RDWR |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollowFlag(),
        SPOOL_FILE_MODE,
      );
      if (process.platform === "win32") {
        assertWindowsPrivatePathSecurity(path, "file", true);
        assertWindowsPrivatePathSecurity(root, "directory", false);
      }
      return new WorkflowHandoffSpool(root, path, fd, options);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Continue cleanup while preserving the security failure.
        }
      }
      try {
        unlinkSync(path);
      } catch {
        // The file may not have been created yet.
      }
      try {
        rmdirSync(root);
      } catch {
        // Preserve the creation error; the private empty root is harmless.
      }
      throw error;
    }
  }

  get failure(): Error | undefined {
    return this.#failure;
  }

  get tokenCount(): number {
    return this.#tokenCount;
  }

  reset(): void {
    this.#assertWritable();
    ftruncateSync(this.#fd, 0);
    this.#hash = createHash("sha256");
    this.#byteLength = 0;
    this.#tokenCount = 0;
    this.#pendingHighSurrogate = "";
  }

  writeCanonicalDelta(delta: string): void {
    this.#assertWritable();
    let text = this.#pendingHighSurrogate + delta;
    this.#pendingHighSurrogate = "";
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      this.#pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    for (const chunk of utf8Chunks(text)) {
      // C1's one-byte/token fallback is applied to complete decoded segments.
      // Carrying a split surrogate above and summing per-segment normalized
      // upper bounds is fail-closed across provider chunk boundaries.
      const tokenCount = estimateUtf8TokenUnits(chunk.text, 1);
      if (this.#tokenCount > this.#maximumTokens - tokenCount) {
        this.#failTokenLimit();
      }
      if (this.#byteLength > this.#maximumBytes - chunk.bytes.byteLength) {
        this.#failLimit();
      }
      writeAll(this.#fd, chunk.bytes, this.#byteLength);
      this.#hash.update(chunk.bytes);
      this.#byteLength += chunk.bytes.byteLength;
      this.#tokenCount += tokenCount;
    }
  }

  seal(): AtomicArtifactByteSource {
    this.#assertWritable();
    if (this.#pendingHighSurrogate.length > 0) {
      const pendingText = this.#pendingHighSurrogate;
      const pending = Buffer.from(pendingText, "utf8");
      this.#pendingHighSurrogate = "";
      if (this.#byteLength > this.#maximumBytes - pending.byteLength) {
        this.#failLimit();
      }
      const pendingTokens = estimateUtf8TokenUnits(pendingText, 1);
      if (this.#tokenCount > this.#maximumTokens - pendingTokens) {
        this.#failTokenLimit();
      }
      writeAll(this.#fd, pending, this.#byteLength);
      this.#hash.update(pending);
      this.#byteLength += pending.byteLength;
      this.#tokenCount += pendingTokens;
    }
    fsyncSync(this.#fd);
    this.#sealed = true;
    this.#sha256 = this.#hash.digest("hex");
    const fd = this.#fd;
    const byteLength = this.#byteLength;
    const sha256 = this.#sha256;
    return Object.freeze({
      byteLength,
      sha256,
      async *chunks(): AsyncIterable<Uint8Array> {
        let position = 0;
        while (position < byteLength) {
          const buffer = Buffer.allocUnsafe(
            Math.min(SPOOL_READ_BYTES, byteLength - position),
          );
          const bytesRead = readSync(
            fd,
            buffer,
            0,
            buffer.byteLength,
            position,
          );
          if (bytesRead < 1) {
            throw new Error("workflow handoff spool ended before its length");
          }
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
        const after = fstatSync(fd);
        if (!after.isFile() || after.size !== byteLength) {
          throw new Error("workflow handoff spool changed after sealing");
        }
      },
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      closeSync(this.#fd);
    } catch {
      // Continue best-effort cleanup of the private spill path.
    }
    try {
      unlinkSync(this.#path);
    } catch {
      // The spill is content-only and never a committed artifact.
    }
    try {
      rmdirSync(this.#root);
    } catch {
      // A failed cleanup leaks private temporary bytes, not public output.
    }
  }

  #assertWritable(): void {
    if (this.#disposed) {
      throw new Error("workflow handoff spool is disposed");
    }
    if (this.#sealed) {
      throw new Error("workflow handoff spool is sealed");
    }
    if (this.#failure !== undefined) throw this.#failure;
  }

  #failLimit(): never {
    const error = new WorkflowHandoffSpoolLimitError(this.#maximumBytes);
    this.#failure = error;
    this.#onLimit?.(error);
    throw error;
  }

  #failTokenLimit(): never {
    const error = new WorkflowHandoffSpoolTokenLimitError(
      this.#maximumTokens,
    );
    this.#failure = error;
    this.#onLimit?.(error);
    throw error;
  }
}

function* utf8Chunks(
  text: string,
): Generator<{ readonly text: string; readonly bytes: Buffer }> {
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + SPOOL_WRITE_CODE_UNITS);
    if (
      end < text.length &&
      end > start &&
      isHighSurrogate(text.charCodeAt(end - 1))
    ) {
      end -= 1;
    }
    if (end === start) end += 1;
    const value = text.slice(start, end);
    yield { text: value, bytes: Buffer.from(value, "utf8") };
    start = end;
  }
}

function writeAll(fd: number, buffer: Buffer, initialPosition: number): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(
      fd,
      buffer,
      offset,
      buffer.byteLength - offset,
      initialPosition + offset,
    );
    if (written < 1) {
      throw new Error("workflow handoff spool write made no progress");
    }
    offset += written;
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function noFollowFlag(): number {
  return (
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0
  );
}
