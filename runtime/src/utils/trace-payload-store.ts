import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeStringify } from "../tools/types.js";
import { sanitizeTracePayloadForArtifact } from "./trace-payload-serialization.js";

const TRACE_PAYLOAD_ROOT = join(homedir(), ".agenc", "trace-payloads");

export interface TracePayloadArtifactRef {
  /**
   * Filesystem path to the artifact, optionally followed by a
   * `#sha256=<hex>` anchor that names the specific JSONL line within
   * the per-traceId file (new format). Old per-event refs are bare
   * file paths without an anchor and remain readable via the legacy
   * branch in `getArtifact`.
   */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function sanitizeSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const collapsed = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
  const bounded = collapsed.slice(0, 96).replace(/^_+|_+$/g, "");
  return bounded.length > 0 ? bounded : fallback;
}

/**
 * Per-traceId write chain. Each traceId gets a Promise that resolves
 * once all of its queued appends have flushed to disk. New appends
 * chain off the current tail so concurrent producers writing to the
 * same JSONL file never interleave their multi-KB lines (Node's
 * O_APPEND atomicity only holds under PIPE_BUF / 4096 bytes; real
 * trace lines often exceed that).
 *
 * The map entry is removed in `.finally()` once the chain settles
 * AND no newer write has replaced it. This keeps map size bounded
 * to currently-active traceIds.
 */
const writeChains = new Map<string, Promise<void>>();

export function persistTracePayloadArtifact(params: {
  traceId?: string;
  eventName: string;
  payload: Record<string, unknown>;
}): TracePayloadArtifactRef | undefined {
  try {
    const sanitizedPayload = sanitizeTracePayloadForArtifact(params.payload);
    const traceIdSegment = sanitizeSegment(params.traceId ?? "trace", "trace");
    const filePath = join(TRACE_PAYLOAD_ROOT, `${traceIdSegment}.jsonl`);

    // Compute sha over the sanitized payload + metadata so it can be
    // stored on the JSONL line for O(N) lookup on read. Storing the
    // sha as a field eliminates any drift risk from re-serialization
    // ordering at read time.
    const docNoSha = {
      eventName: params.eventName,
      traceId: params.traceId,
      capturedAt: new Date().toISOString(),
      payload: sanitizedPayload,
    };
    const serializedNoSha = safeStringify(docNoSha);
    const sha256 = createHash("sha256").update(serializedNoSha).digest("hex");
    const document = { sha256, ...docNoSha };
    const serialized = safeStringify(document);
    const anchoredPath = `${filePath}#sha256=${sha256}`;
    const bytes = Buffer.byteLength(serialized);

    const previousChain = writeChains.get(traceIdSegment) ?? Promise.resolve();
    const next: Promise<void> = previousChain
      .then(() => {
        mkdirSync(TRACE_PAYLOAD_ROOT, { recursive: true });
        writeFileSync(filePath, `${serialized}\n`, {
          encoding: "utf8",
          flag: "a",
        });
      })
      .catch(() => {
        // Trace persistence failures must never crash the runtime
        // path that emitted them. Caller has the ref optimistically;
        // a missed write surfaces as a benign "Artifact not found"
        // on the read side rather than as a runtime crash here.
      })
      .finally(() => {
        if (writeChains.get(traceIdSegment) === next) {
          writeChains.delete(traceIdSegment);
        }
      });
    writeChains.set(traceIdSegment, next);

    return {
      path: anchoredPath,
      sha256,
      bytes,
    };
  } catch {
    return undefined;
  }
}

/**
 * @internal — for tests only. Resolves once the per-traceId write
 * chain has drained for the given traceId (or all traceIds if none
 * given). Production callers never need to await — refs are valid
 * for downstream UI fetches that happen seconds after emission, and
 * the write chain drains long before then.
 */
export async function awaitTracePayloadDrain(
  traceId?: string,
): Promise<void> {
  if (traceId !== undefined) {
    const seg = sanitizeSegment(traceId, "trace");
    const chain = writeChains.get(seg);
    if (chain) await chain;
    return;
  }
  await Promise.all([...writeChains.values()]);
}

/**
 * @internal — for tests only. Returns the count of in-flight
 * per-traceId write chains.
 */
export function tracePayloadActiveChainCount(): number {
  return writeChains.size;
}
