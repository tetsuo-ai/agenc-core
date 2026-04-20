/**
 * Auto-save — threshold-driven memory extraction via forked subagent.
 *
 * Hand-port of openclaude `services/SessionMemory/sessionMemory.ts`
 * (300+ LOC) + `services/extractMemories/extractMemories.ts` closure
 * machinery. Differs:
 *   - Defaults match TODO.MD §T10-C: ≥5K token growth AND ≥5 tool
 *     calls, OR ≥5K growth AND zero tool calls in the last assistant
 *     turn (natural conversation break).
 *   - Integration with T9 `delegate()` is wired via `DelegateFn` — a
 *     stub is shipped until delegate.ts is fully reachable.
 *   - I-29 write lock: every write goes through `getMemoryWriteLock`.
 *
 * Call sites:
 *   - `maybeAutoSaveMemory(session, turnState)` — invoked at the
 *     commit phase (see T5 run-turn), fire-and-forget. Returns the
 *     work promise so callers that want to drain on shutdown can.
 *   - `registerAutoSaveSidecar(sidecar, session)` — subscribes to
 *     `turn_complete` events on the session's sidecar manager.
 *
 * Extraction state is per-session, stashed in a WeakMap keyed on the
 * Session object so short-lived tests can create sessions freely
 * without leaking accumulated state.
 *
 * @module
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getMemoryWriteLock } from "./loader.js";
import { serializeMemory, type MemoryFrontmatter } from "./types.js";
import type { Sidecar } from "../../session/sidecar.js";
import type { Event } from "../../session/event-log.js";

// ─────────────────────────────────────────────────────────────────────
// Thresholds — from TODO.MD §T10-C
// ─────────────────────────────────────────────────────────────────────

/** Minimum token growth (since the last extraction) to trigger. */
export const AUTO_SAVE_MIN_TOKEN_GROWTH = 5_000;

/** Minimum tool calls (since the last extraction) for the tool path. */
export const AUTO_SAVE_MIN_TOOL_CALLS = 5;

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/** Minimal session-shape the extractor needs — not the full Session. */
export interface AutoSaveSession {
  /** Absolute path to the session's memory directory. */
  readonly memoryDir: string;
  /** Absolute path to the MEMORY.md index file. */
  readonly memoryMdPath: string;
}

/** Turn bookkeeping — deltas from the last extraction boundary. */
export interface TurnState {
  /** Total prompt+completion tokens consumed in the current session. */
  readonly tokensConsumed: number;
  /** Count of tool calls issued since the session started. */
  readonly toolCallsIssued: number;
  /** True when the last assistant turn contained NO tool_use blocks. */
  readonly lastTurnHadNoTools: boolean;
  /** Full conversation transcript snapshot for the extractor. */
  readonly transcript?: string;
}

/** A candidate memory emitted by the extraction subagent. */
export interface MemoryCandidate {
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
  /** Absolute path to write this memory to. */
  readonly filePath: string;
}

/**
 * Forked-subagent delegate contract. The extractor calls this to ask
 * a child agent to read the transcript and return `MemoryCandidate[]`.
 *
 * Kept as a plain function type (not a direct import of T9 `delegate`)
 * so auto-save can be tested in isolation and so a stub can ship until
 * T9 is wired through Wave 2 commit.
 */
export type ExtractMemoriesFn = (
  transcript: string,
  session: AutoSaveSession,
) => Promise<readonly MemoryCandidate[]>;

/**
 * Default stub extractor — returns no candidates. Swap with the real
 * forked-subagent flow when T9 `delegate()` is wired into this path.
 */
export const stubExtractor: ExtractMemoriesFn = async () => [];

// ─────────────────────────────────────────────────────────────────────
// Per-session bookkeeping
// ─────────────────────────────────────────────────────────────────────

interface AutoSaveState {
  /** Token count at the last successful extraction. */
  tokensAtLastExtraction: number;
  /** Tool-call count at the last successful extraction. */
  toolCallsAtLastExtraction: number;
  /** In-flight extraction promise; null when no extraction is running. */
  inFlight: Promise<void> | null;
}

const sessionState = new WeakMap<object, AutoSaveState>();

function getState(session: AutoSaveSession): AutoSaveState {
  let state = sessionState.get(session as object);
  if (state === undefined) {
    state = {
      tokensAtLastExtraction: 0,
      toolCallsAtLastExtraction: 0,
      inFlight: null,
    };
    sessionState.set(session as object, state);
  }
  return state;
}

/** Reset auto-save state for a session. Test-only helper. */
export function _resetAutoSaveStateForTest(session: AutoSaveSession): void {
  sessionState.delete(session as object);
}

// ─────────────────────────────────────────────────────────────────────
// Trigger gate
// ─────────────────────────────────────────────────────────────────────

/**
 * Pure predicate: does `turnState` meet the TODO.MD §T10-C thresholds
 * relative to the given deltas? Exposed so tests can exercise the
 * trigger independently of the write path.
 */
export function shouldExtract(
  state: AutoSaveState,
  turnState: TurnState,
): boolean {
  const tokenGrowth = turnState.tokensConsumed - state.tokensAtLastExtraction;
  const toolCallDelta =
    turnState.toolCallsIssued - state.toolCallsAtLastExtraction;

  const hasGrowth = tokenGrowth >= AUTO_SAVE_MIN_TOKEN_GROWTH;
  const hasTools = toolCallDelta >= AUTO_SAVE_MIN_TOOL_CALLS;

  // Branch 1: growth + tool-call burst.
  if (hasGrowth && hasTools) return true;
  // Branch 2: growth + natural conversation break (no tool calls in the
  // last assistant turn). Prevents growth-only stuck-in-thought loops
  // from being extracted mid-tool-use.
  if (hasGrowth && turnState.lastTurnHadNoTools) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Candidate filter
// ─────────────────────────────────────────────────────────────────────

/**
 * `isMemoryWorthy` — reject candidates that are too short, too generic,
 * or ephemeral in the WHAT_NOT_TO_SAVE_SECTION sense. Defensive guard
 * against a noisy extraction agent; the prompt-side guidance does the
 * heavy lifting.
 */
export function isMemoryWorthy(candidate: MemoryCandidate): boolean {
  const body = candidate.body.trim();
  if (body.length < 20) return false;
  if (candidate.frontmatter.name === undefined) return false;
  if (candidate.frontmatter.type === undefined) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Write path (I-29)
// ─────────────────────────────────────────────────────────────────────

/**
 * Write a single memory file under I-29. The caller passes an already
 * resolved absolute `filePath`; this helper owns lock acquisition,
 * parent-dir creation, and file serialization.
 */
export async function writeMemoryFile(
  candidate: MemoryCandidate,
): Promise<void> {
  const lock = getMemoryWriteLock(candidate.filePath);
  await lock.with(async () => {
    await mkdir(dirname(candidate.filePath), { recursive: true });
    const serialized = serializeMemory({
      frontmatter: candidate.frontmatter,
      body: candidate.body,
    });
    await writeFile(candidate.filePath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  });
}

/**
 * Append/refresh a pointer in `MEMORY.md` for a newly written
 * memory file. Idempotent — if a line containing the same filename
 * already exists, the existing line is preserved.
 *
 * The MEMORY.md write is serialized via its own I-29 lock instance so
 * concurrent pointer-writes don't interleave.
 */
export async function upsertIndexEntry(
  memoryMdPath: string,
  candidate: MemoryCandidate,
): Promise<void> {
  const lock = getMemoryWriteLock(memoryMdPath);
  await lock.with(async () => {
    const relPath = candidate.filePath.startsWith(dirname(memoryMdPath) + "/")
      ? candidate.filePath.slice(dirname(memoryMdPath).length + 1)
      : candidate.filePath;
    const title =
      candidate.frontmatter.name ??
      relPath.replace(/\.md$/, "").replace(/[_-]/g, " ");
    const hook = candidate.frontmatter.description ?? "";
    const newLine =
      hook.length > 0
        ? `- [${title}](${relPath}) — ${hook}`
        : `- [${title}](${relPath})`;

    let existing = "";
    try {
      const { readFile } = await import("node:fs/promises");
      existing = await readFile(memoryMdPath, "utf8");
    } catch {
      existing = "";
    }

    // If any line already references this exact path, leave it alone.
    const alreadyIndexed = existing
      .split("\n")
      .some((line) => line.includes(`(${relPath})`));
    if (alreadyIndexed) return;

    await mkdir(dirname(memoryMdPath), { recursive: true });
    const next =
      existing.length === 0
        ? `${newLine}\n`
        : existing.replace(/\n*$/, "") + `\n${newLine}\n`;
    await writeFile(memoryMdPath, next, {
      encoding: "utf8",
      mode: 0o600,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Entry point called from the turn commit phase. If the thresholds
 * are met, spawns an async extraction; otherwise returns immediately.
 *
 * Returns the in-flight promise so callers that want to drain on
 * shutdown can await it. Fire-and-forget callers just ignore the
 * return value.
 */
export async function maybeAutoSaveMemory(
  session: AutoSaveSession,
  turnState: TurnState,
  extractor: ExtractMemoriesFn = stubExtractor,
): Promise<void> {
  const state = getState(session);

  // Overlap guard: if a run is in flight, let it finish.
  if (state.inFlight !== null) return;

  if (!shouldExtract(state, turnState)) return;

  const run = (async () => {
    try {
      const candidates = await extractor(
        turnState.transcript ?? "",
        session,
      );
      for (const candidate of candidates) {
        if (!isMemoryWorthy(candidate)) continue;
        await writeMemoryFile(candidate);
        await upsertIndexEntry(session.memoryMdPath, candidate);
      }
      state.tokensAtLastExtraction = turnState.tokensConsumed;
      state.toolCallsAtLastExtraction = turnState.toolCallsIssued;
    } finally {
      state.inFlight = null;
    }
  })();

  state.inFlight = run;
  await run;
}

/**
 * Build a Sidecar that runs `maybeAutoSaveMemory` on every
 * `turn_complete` event. The extractor is closed over so the same
 * instance (typically bound to a real T9 delegate) persists across
 * turns.
 *
 * The caller is responsible for computing the TurnState from the
 * session's turn telemetry. Keeping that extraction out of this module
 * means the Sidecar doesn't need to reach into run-turn internals.
 */
export function registerAutoSaveSidecar(params: {
  readonly session: AutoSaveSession;
  readonly extractor?: ExtractMemoriesFn;
  readonly getTurnState: () => TurnState | null;
}): Sidecar {
  const { session, extractor = stubExtractor, getTurnState } = params;
  return {
    name: "memory-auto-save",
    onEvent(event: Event) {
      if (event.msg.type !== "turn_complete") return;
      const turnState = getTurnState();
      if (turnState === null) return;
      // Fire-and-forget; errors swallowed inside maybeAutoSaveMemory.
      void maybeAutoSaveMemory(session, turnState, extractor).catch(() => {});
    },
  };
}
