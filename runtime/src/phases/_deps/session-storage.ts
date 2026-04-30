/**
 * I-88 best-effort transcript-write hook.
 *
 * Port of agenc `utils/sessionStorage.ts::recordContentReplacement`
 * adapted to gut's runtime boundaries. Upstream writes a
 * `ContentReplacementEntry` line to the project transcript so resume
 * reconstructs the same replacement Map and prompt-cache prefix stays
 * stable across session restarts.
 *
 * Gut adaptation:
 *   - Resume reconstruction in gut already works WITHOUT on-disk
 *     records: `applyToolResultBudget` mutates `messagesForQuery` in
 *     place and that mutated history is what the rollout writer sees.
 *     `provisionContentReplacementState(priorMessages)` then walks the
 *     resumed history, finds tool-role messages tagged with the
 *     `<persisted-output>` marker, and freezes their ids via `seenIds`.
 *     Cache stability holds even with no record file.
 *   - The records buffer here is exposed for observability + tests
 *     (so callers can assert the budget actually fired) and is
 *     bounded so a long-running session does not leak memory.
 *
 * Optional persistence: when `AGENC_CONTENT_REPLACEMENT_LOG` is set to
 * a writable file path, every record is appended as a JSONL line so
 * operators have an offline audit trail. Failures are silently
 * swallowed — this is best-effort observability, never an
 * enforcement-breaking dependency.
 *
 * @module
 */

import { appendFileSync } from "node:fs";
import type { ContentReplacementRecord } from "../../session/_deps/tool-result-storage.js";

export type { ContentReplacementRecord };

/**
 * Bounded in-memory ring of recorded replacements. Newest at the
 * tail. Cap keeps long sessions from leaking memory; observers that
 * need stricter bounds can drain via {@link drainRecordedReplacements}.
 */
const RECORDED_REPLACEMENTS: ContentReplacementRecord[] = [];
const RECORDED_REPLACEMENTS_CAP = 1024;

/**
 * Persist a batch of newly-decided replacement records.
 *
 * Mirrors agenc `recordContentReplacement(replacements, agentId?)`
 * call shape — the AgenC context adapter passes `(records)` only.
 *
 * Behavior:
 *   1. Append each record to the bounded in-memory buffer (drops
 *      oldest entries past the cap).
 *   2. If `AGENC_CONTENT_REPLACEMENT_LOG` is set, append each record
 *      as a JSONL line (best-effort, failures swallowed).
 *
 * The async signature is preserved so the upstream call shape (and
 * potential future on-disk writers using the rollout flock) can drop
 * in without re-wiring callers.
 */
export async function recordContentReplacement(
  replacements: ReadonlyArray<ContentReplacementRecord>,
  _agentId?: string,
): Promise<void> {
  if (!Array.isArray(replacements) || replacements.length === 0) return;

  for (const record of replacements) {
    if (!record || record.kind !== "tool-result") continue;
    if (
      typeof record.toolUseId !== "string" ||
      typeof record.replacement !== "string"
    ) {
      continue;
    }
    RECORDED_REPLACEMENTS.push({
      kind: "tool-result",
      toolUseId: record.toolUseId,
      replacement: record.replacement,
    });
  }

  // Trim the ring once past the cap.
  if (RECORDED_REPLACEMENTS.length > RECORDED_REPLACEMENTS_CAP) {
    const overflow = RECORDED_REPLACEMENTS.length - RECORDED_REPLACEMENTS_CAP;
    RECORDED_REPLACEMENTS.splice(0, overflow);
  }

  const logPath = process.env.AGENC_CONTENT_REPLACEMENT_LOG;
  if (typeof logPath === "string" && logPath.length > 0) {
    try {
      const lines =
        replacements
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n";
      appendFileSync(logPath, lines, "utf8");
    } catch {
      // Best-effort observability path; never block enforcement.
    }
  }
}

/**
 * Test-and-observability helper. Returns and clears the in-memory
 * buffer of recorded replacements.
 */
export function drainRecordedReplacements(): ContentReplacementRecord[] {
  const out = RECORDED_REPLACEMENTS.splice(0, RECORDED_REPLACEMENTS.length);
  return out;
}

/**
 * Test helper. Read-only snapshot of currently buffered replacements.
 * Does not clear the buffer.
 */
export function peekRecordedReplacements(): ReadonlyArray<ContentReplacementRecord> {
  return RECORDED_REPLACEMENTS.slice();
}
