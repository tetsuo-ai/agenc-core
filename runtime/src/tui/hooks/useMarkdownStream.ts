/**
 * useMarkdownStream — React wrapper around the AgenC markdown stream
 * collector shipped by `watch/agenc-watch-markdown-stream.mjs`.
 *
 * The watch-side collector is the authority on how AgenC renders
 * streaming assistant text: header detection, table buffering, link
 * preview stability, etc. We wrap it verbatim — any behavior change
 * belongs in that module, not here.
 *
 * Runtime loading:
 *   - The `.mjs` module is resolved through a lazy dynamic `import()`
 *     so the TUI bundle does not eagerly pull in markdown-it at module
 *     load. The first render to need it awaits the import, subsequent
 *     renders use the cached handle.
 *   - If the module cannot be loaded for any reason we fall back to a
 *     naive concatenation path so the UI still shows the assistant's
 *     words. The error is reported once via stderr for diagnosis.
 *
 * Contract:
 *   - `chunks` is the ordered list of assistant_text deltas for the
 *     current turn. Order matters and each chunk is appended to the
 *     collector in sequence.
 *   - `rendered` is the ANSI-colored string the TUI should paint.
 *   - `isComplete` flips true once the caller marks the stream done
 *     via a sentinel chunk (see `STREAM_DONE_CHUNK`) — we infer that
 *     from an empty trailing entry so callers can signal "finalize"
 *     without a separate method.
 *   - `lastDeltaMs` is the millisecond timestamp of the most recent
 *     chunk addition, useful for idle-fade animations.
 *
 * @module
 */

import { useEffect, useRef, useState } from "react";

/**
 * Minimal collector surface we depend on. Mirrors the real
 * `createMarkdownStreamCollector` return type — we use structural
 * typing so tests can substitute a stub without importing the .mjs.
 */
interface StreamCollector {
  clear(): void;
  pushDelta(delta: string): void;
  snapshot(): ReadonlyArray<{ readonly text: string }>;
  finalizeAndDrain(): ReadonlyArray<{ readonly text: string }>;
}

interface StreamModule {
  createMarkdownStreamCollector(options?: {
    readonly cacheSize?: number;
  }): StreamCollector;
}

/**
 * Sentinel chunk callers can append to signal "stream complete".
 * We use an empty string because any real assistant_text delta is
 * non-empty (tracing layer strips blank deltas upstream).
 */
export const STREAM_DONE_CHUNK = "";

export interface UseMarkdownStreamOptions {
  readonly cacheSize?: number;
}

export interface UseMarkdownStreamResult {
  readonly rendered: string;
  readonly isComplete: boolean;
  readonly lastDeltaMs: number;
}

// ─────────────────────────────────────────────────────────────────────
// Module loader with single-flight caching.
// ─────────────────────────────────────────────────────────────────────

let cachedModule: StreamModule | null = null;
let loadPromise: Promise<StreamModule | null> | null = null;
let loadFailedReason: string | null = null;
const MODULE_SPECIFIER = "../../watch/agenc-watch-markdown-stream.mjs";

async function loadStreamModule(): Promise<StreamModule | null> {
  if (cachedModule) return cachedModule;
  if (loadFailedReason !== null) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const mod = (await import(MODULE_SPECIFIER)) as Partial<StreamModule>;
      if (typeof mod.createMarkdownStreamCollector !== "function") {
        loadFailedReason = "createMarkdownStreamCollector export missing";
        warnOnce(
          "stream-missing-export",
          `markdown stream module missing expected export; using fallback. Reason: ${loadFailedReason}`,
        );
        return null;
      }
      cachedModule = mod as StreamModule;
      return cachedModule;
    } catch (error) {
      loadFailedReason = error instanceof Error ? error.message : String(error);
      warnOnce(
        "stream-load-failed",
        `failed to load markdown stream module; using fallback. Reason: ${loadFailedReason}`,
      );
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

const warned = new Set<string>();
function warnOnce(tag: string, message: string): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  try {
    process.stderr.write(`[useMarkdownStream] ${message}\n`);
  } catch {
    // stderr may be stubbed in sandboxed tests.
  }
}

/**
 * Render a collector snapshot (array of display lines) into a single
 * newline-joined string suitable for direct `<Text>` rendering.
 */
function linesToString(lines: ReadonlyArray<{ readonly text: string }>): string {
  return lines.map((line) => line.text ?? "").join("\n");
}

/**
 * Fallback path when the .mjs module is unavailable. We just
 * concatenate chunks verbatim — no markdown rendering, no ANSI, but
 * the user's words still appear on screen.
 */
function fallbackRender(chunks: readonly string[]): string {
  return chunks.join("");
}

export function useMarkdownStream(
  chunks: readonly string[],
  opts: UseMarkdownStreamOptions = {},
): UseMarkdownStreamResult {
  const [rendered, setRendered] = useState<string>("");
  const [isComplete, setIsComplete] = useState<boolean>(false);
  const [lastDeltaMs, setLastDeltaMs] = useState<number>(0);

  // Track the indices we've already pushed into the collector so we
  // don't re-ingest earlier chunks when `chunks` grows by append.
  const ingestedCount = useRef<number>(0);
  const collectorRef = useRef<StreamCollector | null>(null);
  const optsRef = useRef<UseMarkdownStreamOptions>(opts);
  optsRef.current = opts;

  useEffect(() => {
    let cancelled = false;

    // Reset scenario: chunks array shorter than what we've already
    // ingested → the caller started a new stream. Rewind.
    if (chunks.length < ingestedCount.current) {
      ingestedCount.current = 0;
      collectorRef.current?.clear();
      setRendered("");
      setIsComplete(false);
    }

    const process = async (): Promise<void> => {
      const mod = await loadStreamModule();
      if (cancelled) return;

      if (!mod) {
        // Fallback path: naive concat, mark complete on sentinel chunk.
        const final = chunks.at(-1) === STREAM_DONE_CHUNK;
        const payload = final ? chunks.slice(0, -1) : chunks;
        setRendered(fallbackRender(payload));
        setIsComplete(final);
        if (chunks.length > ingestedCount.current) {
          setLastDeltaMs(Date.now());
          ingestedCount.current = chunks.length;
        }
        return;
      }

      let collector = collectorRef.current;
      if (!collector) {
        collector = mod.createMarkdownStreamCollector({
          ...(optsRef.current.cacheSize !== undefined
            ? { cacheSize: optsRef.current.cacheSize }
            : {}),
        });
        collectorRef.current = collector;
      }

      let sawFinalize = false;
      for (let i = ingestedCount.current; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (chunk === STREAM_DONE_CHUNK) {
          sawFinalize = true;
          continue;
        }
        collector.pushDelta(chunk ?? "");
      }

      if (chunks.length > ingestedCount.current) {
        setLastDeltaMs(Date.now());
        ingestedCount.current = chunks.length;
      }

      if (sawFinalize) {
        // Drain anything buffered in the collector's preview window and
        // emit the final rendering.
        const finalLines = collector.finalizeAndDrain();
        setRendered(linesToString(finalLines));
        setIsComplete(true);
      } else {
        setRendered(linesToString(collector.snapshot()));
      }
    };

    void process();

    return () => {
      cancelled = true;
    };
    // chunks.length is the canonical "did it grow" signal; referencing
    // the array identity alone would miss in-place mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks, chunks.length]);

  return { rendered, isComplete, lastDeltaMs };
}

/**
 * Testing helpers — reset module-level caches so each test starts
 * from a clean slate.
 */
export function __resetMarkdownStreamModuleForTests(): void {
  cachedModule = null;
  loadPromise = null;
  loadFailedReason = null;
  warned.clear();
}

/**
 * Testing-only: inject a fake module implementation. Bypasses the
 * dynamic import path entirely for unit tests that want to observe
 * collector interactions without loading markdown-it.
 */
export function __setMarkdownStreamModuleForTests(
  mod: StreamModule | null,
  failureReason: string | null = null,
): void {
  cachedModule = mod;
  loadFailedReason = failureReason;
  loadPromise = null;
}
