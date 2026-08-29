import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const TRACE_EVENT_LIMIT = 32;
const TRACE_FILE_BYTE_LIMIT = 16 * 1024;
const TRACE_DETAIL_BYTE_LIMIT = 256;
const TRACE_FILENAME = "tui-startup-trace.jsonl";

let eventCount = 0;
const emittedPhases = new Set<string>();
const startedAt = Date.now();
let traceDescriptor: number | null = null;
let traceDisabled = false;
let traceBytesWritten = 0;
let openedTracePath: string | null = null;

function tracePath(env: NodeJS.ProcessEnv): string | null {
  if (env.TUI_E2E_DEBUG !== "1") return null;
  const agencHome = env.AGENC_HOME;
  const configuredPath = env.TUI_E2E_STARTUP_TRACE;
  if (
    agencHome === undefined ||
    configuredPath === undefined ||
    !isAbsolute(agencHome) ||
    !isAbsolute(configuredPath)
  ) {
    return null;
  }
  const expectedPath = join(resolve(agencHome), TRACE_FILENAME);
  return resolve(configuredPath) === expectedPath ? expectedPath : null;
}

function boundedDetail(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  const singleLine = raw.replace(/[\r\n]+/gu, " ");
  if (Buffer.byteLength(singleLine, "utf8") <= TRACE_DETAIL_BYTE_LIMIT) {
    return singleLine;
  }
  const encoded = Buffer.from(singleLine, "utf8");
  let end = TRACE_DETAIL_BYTE_LIMIT - 3;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}...`;
}

function disableTrace(): void {
  traceDisabled = true;
  if (traceDescriptor !== null) {
    try {
      closeSync(traceDescriptor);
    } catch {}
  }
  traceDescriptor = null;
  openedTracePath = null;
}

function ensureTraceDescriptor(path: string): number | null {
  if (traceDisabled) return null;
  if (traceDescriptor !== null) {
    if (openedTracePath !== path) disableTrace();
    return traceDescriptor;
  }

  // Optimistically disable before touching the filesystem. Any failure stays
  // fail-closed, so a render loop cannot repeat synchronous diagnostic I/O.
  traceDisabled = true;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.nlink !== 1 || state.size !== 0) {
      closeSync(descriptor);
      return null;
    }
    traceDescriptor = descriptor;
    openedTracePath = path;
    traceDisabled = false;
    return descriptor;
  } catch {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    return null;
  }
}

/**
 * Record one bounded startup phase for the private hosted TUI gate.
 * Ordinary AgenC processes cannot select a destination: the gate-provided
 * path must exactly match the canonical file beneath AGENC_HOME.
 */
export function traceTuiStartupPhase(
  phase: string,
  error?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    traceTuiStartupPhaseUnsafe(phase, error, env);
  } catch {
    disableTrace();
  }
}

function traceTuiStartupPhaseUnsafe(
  phase: string,
  error: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (
    traceDisabled ||
    eventCount >= TRACE_EVENT_LIMIT ||
    emittedPhases.has(phase)
  ) {
    return;
  }
  const path = tracePath(env);
  if (path === null) return;

  // Count the attempt before any synchronous I/O. A failed write for this
  // phase can never become an unbounded render-loop retry.
  emittedPhases.add(phase);
  eventCount += 1;
  const detail = boundedDetail(error);
  const record = {
    phase: phase.replace(/[^a-z0-9:-]/giu, "_").slice(0, 64),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(detail === undefined ? {} : { detail }),
  };
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (line.byteLength > 512) return;

  try {
    const descriptor = ensureTraceDescriptor(path);
    if (descriptor === null) return;
    if (traceBytesWritten + line.byteLength > TRACE_FILE_BYTE_LIMIT) {
      disableTrace();
      return;
    }
    const written = writeSync(descriptor, line, 0, line.byteLength);
    if (written !== line.byteLength) {
      disableTrace();
      return;
    }
    traceBytesWritten += written;
  } catch {
    disableTrace();
  }
}

/** Close the diagnostic after the first complete frame. */
export function closeTuiStartupTrace(): void {
  disableTrace();
}
