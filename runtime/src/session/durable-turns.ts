/**
 * GOAL #4b Stage 1 — durable / checkpointed turns: shared primitives.
 *
 * This module owns the cross-cutting helpers used by the checkpoint WRITE
 * path (`run-turn.ts`), the reconstruction surfacing (`rollout-reconstruction.ts`),
 * and the resume path (`thread-manager.ts`):
 *
 *   - the runtime build identifier stamped into `turn_started` (build pin),
 *   - durable-turns config resolution (conservative defaults + env),
 *   - the CONTENT prefix hash (sha256 of a canonical projection that is
 *     stable across the in-memory write side and the post-truncation
 *     reconstruction read side — §5 torn-prefix gate),
 *   - dangling-`tool_use` detection over a reconstructed prefix and the
 *     safe-by-default side-effect halt decision (§3.5).
 *
 * Determinism / safety invariants this module upholds (see the design):
 *   - resume is gated by lease + buildId + prefixHash; this module supplies
 *     the buildId and the hash, and classifies dangling tools.
 *   - a no-checkpoint orphan is byte-identical to today (this module only
 *     adds surfacing; the fallback stays in the caller).
 *
 * @module
 */

import { createHash } from "node:crypto";
import { VERSION } from "../version.js";
import type { ResponseItem } from "./rollout-item.js";
import type { TurnCheckpointSliceLine } from "./event-log.js";
import type { DurableTurnsConfig } from "../config/schema.js";

// ─────────────────────────────────────────────────────────────────────
// Build identifier (build pin, §3.6)
// ─────────────────────────────────────────────────────────────────────

/**
 * Stable per-build identifier stamped into `turn_started.buildId`.
 *
 * Derived from the runtime `VERSION` plus an optional build commit
 * (`AGENC_BUILD_COMMIT`, set by the build-version script). Resolved once at
 * module load: it must be CONSTANT for the lifetime of a process so a
 * resumed turn within the same build always matches, and a turn started
 * under a different build is refused. Reading it from a constant (not a
 * disk `VERSION` file) keeps it out of the hot path and stable across the
 * crash/restart boundary on the same installed build.
 *
 * `AGENC_BUILD_ID` (if set) wins outright — for tests and for deployments
 * that want an explicit pin.
 */
function deriveBuildId(): string {
  const explicit = process.env.AGENC_BUILD_ID;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const commit = process.env.AGENC_BUILD_COMMIT;
  if (typeof commit === "string" && commit.length > 0) {
    return `${VERSION}+${commit.slice(0, 12)}`;
  }
  return VERSION;
}

let cachedBuildId: string | null = null;

export function currentBuildId(): string {
  if (cachedBuildId === null) cachedBuildId = deriveBuildId();
  return cachedBuildId;
}

/** Test-only: reset the memoized build id (e.g. after mutating env). */
export function resetBuildIdForTestingOnly(): void {
  cachedBuildId = null;
}

// ─────────────────────────────────────────────────────────────────────
// Config resolution (§6) — conservative defaults + env overrides
// ─────────────────────────────────────────────────────────────────────

export interface ResolvedDurableTurnsConfig {
  readonly checkpointEnabled: boolean;
  readonly checkpointMinIntervalMs: number;
  readonly resumeOnRestart: boolean;
  readonly requireLease: boolean;
  readonly buildPinning: boolean;
}

interface DurableTurnsConfigInput {
  readonly durableTurns?: DurableTurnsConfig;
}

/**
 * Resolve the effective durable-turns config from the canonical captured
 * config snapshot. Environment inputs are projected by config/env before a
 * session is constructed; runtime consumers never read them independently.
 */
export function resolveDurableTurnsConfig(
  config: unknown,
): ResolvedDurableTurnsConfig {
  const cfg = (config as DurableTurnsConfigInput | undefined)?.durableTurns;

  const checkpointEnabled =
    cfg?.checkpoint?.enabled ?? true;

  const minIntervalRaw = cfg?.checkpoint?.minIntervalMs;
  const checkpointMinIntervalMs =
    typeof minIntervalRaw === "number" && Number.isFinite(minIntervalRaw) && minIntervalRaw > 0
      ? minIntervalRaw
      : 0;

  const resumeOnRestart =
    cfg?.resume?.onRestart ?? true;

  const requireLease = cfg?.resume?.requireLease ?? true;
  const buildPinning = cfg?.resume?.buildPinning ?? true;

  return {
    checkpointEnabled,
    checkpointMinIntervalMs,
    resumeOnRestart,
    requireLease,
    buildPinning,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Prefix content hash (§5 torn-prefix / divergence gate)
// ─────────────────────────────────────────────────────────────────────

interface HashableMessage {
  readonly role: string;
  readonly content: unknown;
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
  }>;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/**
 * Extract a stable text projection of a message's content. Mirrors the
 * reconstruction text reader so the in-memory and reconstructed forms map
 * to the same string for the same logical content.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let total = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") {
      total += record.text;
      continue;
    }
    // Non-text parts (images, documents): include a stable structural
    // marker so their presence/absence is part of the hash without
    // depending on the (large, possibly-truncated) payload bytes.
    if (typeof record.type === "string") total += `<${record.type}>`;
  }
  return total;
}

/**
 * Is this a tool-output message? Tool-output BODIES are the only content
 * that diverges between the write side and the read side: reconstruction
 * caps them at `DEFAULT_MAX_TOOL_RESULT_BYTES` on replay, while the live
 * in-memory copy is independently bounded (`boundInMemoryToolResultContent`
 * replaces older large bodies with a fixed marker). So the hash must NOT
 * depend on the variable tool-output body — only on its threading identity
 * and a bound-stable size class.
 */
function isToolOutput(msg: HashableMessage): boolean {
  if (msg.role === "tool") return true;
  if (msg.toolCallId !== undefined || msg.toolName !== undefined) return true;
  if (Array.isArray(msg.content)) {
    return (msg.content as ReadonlyArray<Record<string, unknown>>).some(
      (frag) =>
        frag?.type === "function_call_output" ||
        frag?.type === "tool_use_result" ||
        frag?.type === "tool_result",
    );
  }
  return false;
}

/**
 * Canonical, divergence-detecting projection of one message.
 *
 * The hash is a TORN-PREFIX / divergence gate (§5): it must detect dropped,
 * reordered, or threading-corrupted messages, while being STABLE across the
 * write-side in-memory tool-result bounding and the read-side replay
 * truncation (both of which mutate ONLY tool-output bodies). It therefore
 * hashes the full structural threading identity of every message —
 * role, assistant text, tool-call ids/names, the tool result's
 * `toolCallId`/`toolName` linkage — but for a tool-output body uses a
 * bound-stable size class (capped at the replay cap) rather than the
 * variable bytes. Assistant/user TEXT is hashed in full (it is never
 * bounded/truncated), so any change to model output or user input is
 * caught.
 */
function canonicalMessage(msg: HashableMessage): string {
  const calls = (msg.toolCalls ?? []).map((c) => ({
    id: c.id ?? "",
    name: c.name ?? "",
    arguments: c.arguments ?? "",
  }));
  if (isToolOutput(msg)) {
    // The tool-output BODY is excluded from the hash entirely: it is
    // bounded in-memory (large bodies replaced with a fixed marker) and
    // truncated on replay — neither stable across the write↔read boundary.
    // Threading linkage (toolCallId / toolName / the originating call) plus
    // the surrounding assistant/user text fully detect structural
    // divergence (dropped/reordered/relinked messages), which is the
    // torn-prefix gate's job.
    return JSON.stringify({
      role: msg.role,
      kind: "tool_output",
      calls,
      toolCallId: msg.toolCallId ?? null,
      toolName: msg.toolName ?? null,
    });
  }
  return JSON.stringify({
    role: msg.role,
    text: contentText(msg.content),
    calls,
    toolCallId: msg.toolCallId ?? null,
    toolName: msg.toolName ?? null,
  });
}

/**
 * Content hash (sha256) of the canonicalized persisted prefix
 * `messages[0..count]`. Accepts either live `LLMMessage`s (write side) or
 * reconstructed `ResponseItem`s (read side) — both shapes carry the same
 * load-bearing fields. NEVER a length check.
 */
export function computePrefixHash(
  messages: ReadonlyArray<HashableMessage>,
  count: number,
): string {
  const hash = createHash("sha256");
  const upper = Math.max(0, Math.min(count, messages.length));
  for (let i = 0; i < upper; i += 1) {
    const msg = messages[i];
    if (msg === undefined) continue;
    hash.update(canonicalMessage(msg));
    hash.update(""); // record separator
  }
  return hash.digest("hex");
}

// ─────────────────────────────────────────────────────────────────────
// Dangling-tool_use detection + safe-by-default halt (§3.5)
// ─────────────────────────────────────────────────────────────────────

export interface DanglingToolUse {
  readonly callId: string;
  readonly toolName: string;
}

/**
 * Find assistant `tool_use` blocks in the prefix that have NO paired
 * persisted tool result — the crashed-mid-iteration case where a tool was
 * (possibly) dispatched but its result never landed durably.
 *
 * A result is "paired" when a later `tool`-role / tool-output ResponseItem
 * carries the matching `toolCallId`.
 */
export function findDanglingToolUses(
  prefix: ReadonlyArray<ResponseItem>,
): DanglingToolUse[] {
  const resolvedCallIds = new Set<string>();
  for (const item of prefix) {
    if (typeof item.toolCallId === "string" && item.toolCallId.length > 0) {
      resolvedCallIds.add(item.toolCallId);
    }
  }
  const dangling: DanglingToolUse[] = [];
  for (const item of prefix) {
    if (item.role !== "assistant" || item.toolCalls === undefined) continue;
    for (const call of item.toolCalls) {
      if (typeof call.id !== "string" || call.id.length === 0) continue;
      if (resolvedCallIds.has(call.id)) continue;
      dangling.push({ callId: call.id, toolName: call.name });
    }
  }
  return dangling;
}

/**
 * Classify a dangling tool by name into "replay-safe" vs "must-halt".
 *
 * `lookup(toolName)` resolves the registry classification; when the tool is
 * unknown (not in the live registry) it is treated as side-effecting
 * (fail-safe — the conservative over-halt direction). Resume must HALT on
 * any non-empty `mustHalt`.
 */
export interface DanglingClassification {
  readonly replaySafe: ReadonlyArray<DanglingToolUse>;
  readonly mustHalt: ReadonlyArray<DanglingToolUse>;
}

export function classifyDanglingToolUses(
  dangling: ReadonlyArray<DanglingToolUse>,
  isReplaySafe: (toolName: string) => boolean,
): DanglingClassification {
  const replaySafe: DanglingToolUse[] = [];
  const mustHalt: DanglingToolUse[] = [];
  for (const d of dangling) {
    if (isReplaySafe(d.toolName)) replaySafe.push(d);
    else mustHalt.push(d);
  }
  return { replaySafe, mustHalt };
}

/** Human-facing halt message for a side-effecting dangling tool (§3.5). */
export function sideEffectHaltMessage(toolName: string): string {
  return (
    `a side-effecting tool (${toolName}) may have already executed before ` +
    `the crash; not retried automatically. Re-issue if needed.`
  );
}

// ─────────────────────────────────────────────────────────────────────
// ResumableTurn descriptor — produced by reconstruction, consumed on resume
// ─────────────────────────────────────────────────────────────────────

/**
 * Descriptor surfaced by I-48 reconstruction for an orphaned `turn_started`
 * that carried a durable `turn_checkpoint`. When present (and the resume
 * gates pass), the resume path re-enters the drain loop from
 * `lastCheckpoint.iterationIndex + 1` instead of discarding the turn.
 *
 * `historyPrefixValid` is the §5 content-hash check against the
 * reconstructed prefix; `buildMatches` is the §3.6 build pin. Either being
 * false → caller falls back to EXACTLY today's behavior.
 */
export interface ResumableTurn {
  readonly turnId: string;
  readonly buildId?: string;
  readonly buildMatches: boolean;
  readonly historyPrefixValid: boolean;
  /** A3 raw-prefix gate evaluated before replay truncation. */
  readonly checkpointIntegrityStatus: "valid" | "invalid" | "deferred";
  readonly checkpointIntegrityReason?: string;
  readonly lastCheckpoint: {
    readonly iterationIndex: number;
    readonly checkpointSeq: number;
    readonly persistedMessageCount: number;
    readonly prefixHash: string;
    readonly resumableState: TurnCheckpointSliceLine;
  };
  /** Dangling tool_use blocks in the persisted prefix (unclassified). */
  readonly danglingToolUses: ReadonlyArray<DanglingToolUse>;
}
