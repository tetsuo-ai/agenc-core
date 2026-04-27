/**
 * Per-turn memory attachments — surfaces the most-relevant memories
 * from the directory into the system prompt for a single turn.
 *
 * Hand-port of AgenC `utils/attachments.ts` relevant-memory
 * subset. Differs:
 *   - Caps from TODO.MD §T10-C: ≤5 files/turn, ≤4KB each, ≤60KB per
 *     session cumulative.
 *   - Relevance signal: keyword overlap between `name + description`
 *     and the user message, plus a type priority
 *     (feedback > project > reference > user). Ties broken by mtime
 *     (newest first).
 *   - Per-session accumulation is tracked in a WeakMap so tests can
 *     instantiate fresh sessions without leaking prior selection budget.
 *
 * The selector is deterministic for a given (memories, message,
 * session-bytes) input — no randomness, no LLM rerank. The upstream
 * auto-save extractor is the place for model-driven selection.
 *
 * @module
 */

import type { MemoryEntry, MemoryType } from "./types.js";
import { serializeMemory } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Caps — from TODO.MD §T10-C
// ─────────────────────────────────────────────────────────────────────

/** Maximum memory files surfaced per turn. */
export const ATTACHMENT_MAX_FILES_PER_TURN = 5;

/** Maximum bytes per individual memory surfaced per turn. */
export const ATTACHMENT_MAX_BYTES_PER_FILE = 4_000;

/** Maximum cumulative bytes surfaced in one session. */
export const ATTACHMENT_MAX_BYTES_PER_SESSION = 60_000;

// ─────────────────────────────────────────────────────────────────────
// Session-local budget tracker
// ─────────────────────────────────────────────────────────────────────

interface AttachmentBudget {
  bytesInjected: number;
}

const sessionBudgets = new WeakMap<object, AttachmentBudget>();

function getBudget(sessionKey: object): AttachmentBudget {
  let budget = sessionBudgets.get(sessionKey);
  if (budget === undefined) {
    budget = { bytesInjected: 0 };
    sessionBudgets.set(sessionKey, budget);
  }
  return budget;
}

/** Reset a session's attachment budget. Test-only. */
export function _resetAttachmentBudgetForTest(sessionKey: object): void {
  sessionBudgets.delete(sessionKey);
}

// ─────────────────────────────────────────────────────────────────────
// Relevance scoring
// ─────────────────────────────────────────────────────────────────────

const TYPE_PRIORITY: Readonly<Record<MemoryType, number>> = Object.freeze({
  feedback: 4,
  project: 3,
  reference: 2,
  user: 1,
});

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "and",
  "or",
  "but",
  "with",
  "by",
  "as",
  "it",
  "that",
  "this",
  "what",
  "how",
  "why",
  "when",
  "where",
  "can",
  "do",
  "does",
  "did",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "us",
  "our",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Score a memory entry against the user message. Higher is more
 * relevant.
 *
 * Signal sources:
 *   - Keyword overlap between tokens(name + description) and
 *     tokens(user message). Each match adds 10 points.
 *   - Type priority (feedback > project > reference > user) adds 1–4.
 *   - Newer mtime breaks ties via a small fractional bump.
 */
export function scoreMemory(
  entry: MemoryEntry,
  userMessage: string,
): number {
  const userTokens = tokenize(userMessage);
  const hay = `${entry.frontmatter.name ?? ""} ${entry.frontmatter.description ?? ""}`;
  const memTokens = tokenize(hay);
  let overlap = 0;
  for (const t of memTokens) {
    if (userTokens.has(t)) overlap++;
  }
  const typeBonus =
    entry.frontmatter.type !== undefined
      ? TYPE_PRIORITY[entry.frontmatter.type]
      : 0;
  // mtime bonus: up to ~0.9 for very recent files, near-zero for old ones.
  const ageDays = Math.max(
    0,
    (Date.now() - entry.mtimeMs) / (1000 * 60 * 60 * 24),
  );
  const recencyBonus = 1 / (1 + ageDays * 0.1);
  return overlap * 10 + typeBonus + recencyBonus * 0.9;
}

// ─────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────

/**
 * Select the top-N most-relevant memories for a turn. Respects
 * per-file and per-session byte caps.
 *
 * `sessionKey` is opaque — pass the Session object (or any stable
 * reference) you want accumulated across turns.
 */
export function selectRelevantMemoriesForTurn(
  allMemories: readonly MemoryEntry[],
  userMessage: string,
  sessionKey: object,
  options?: {
    readonly maxFiles?: number;
    readonly maxBytesPerFile?: number;
    readonly maxBytesPerSession?: number;
  },
): readonly MemoryEntry[] {
  const maxFiles = options?.maxFiles ?? ATTACHMENT_MAX_FILES_PER_TURN;
  const maxBytesPerFile =
    options?.maxBytesPerFile ?? ATTACHMENT_MAX_BYTES_PER_FILE;
  const maxBytesPerSession =
    options?.maxBytesPerSession ?? ATTACHMENT_MAX_BYTES_PER_SESSION;

  const budget = getBudget(sessionKey);

  // Filter out oversized individual files (respect per-file cap).
  const eligible = allMemories.filter((m) => m.byteLength <= maxBytesPerFile);

  // Sort by score descending; mtime tiebreaker already in score.
  const scored = eligible
    .map((entry) => ({ entry, score: scoreMemory(entry, userMessage) }))
    .sort((a, b) => b.score - a.score);

  const picked: MemoryEntry[] = [];
  for (const { entry } of scored) {
    if (picked.length >= maxFiles) break;
    if (budget.bytesInjected + entry.byteLength > maxBytesPerSession) continue;
    picked.push(entry);
    budget.bytesInjected += entry.byteLength;
  }
  return picked;
}

/**
 * Append selected memories to a system prompt as a single trailing
 * `## Relevant memories` section. Each entry is serialized with its
 * frontmatter — the model sees exactly what's on disk.
 */
export function injectAttachmentsIntoPrompt(
  systemPrompt: string,
  memories: readonly MemoryEntry[],
): string {
  if (memories.length === 0) return systemPrompt;
  const header = "\n\n## Relevant memories\n";
  const body = memories
    .map((entry) =>
      serializeMemory({ frontmatter: entry.frontmatter, body: entry.body }),
    )
    .join("\n");
  return `${systemPrompt}${header}${body}`;
}

/**
 * Inspect the remaining session byte budget for attachments. Used by
 * tests; real code should only care about whether the next selection
 * returns results.
 *
 * `capBytes` defaults to {@link ATTACHMENT_MAX_BYTES_PER_SESSION} but
 * can be overridden to match a custom cap passed into
 * `selectRelevantMemoriesForTurn`.
 */
export function attachmentBudgetFor(
  sessionKey: object,
  capBytes: number = ATTACHMENT_MAX_BYTES_PER_SESSION,
): {
  readonly bytesInjected: number;
  readonly bytesRemaining: number;
} {
  const budget = getBudget(sessionKey);
  return {
    bytesInjected: budget.bytesInjected,
    bytesRemaining: Math.max(0, capBytes - budget.bytesInjected),
  };
}
