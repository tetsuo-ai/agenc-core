/**
 * I-88 — per-turn tool-result byte budget enforcement.
 *
 * Port of openclaude `utils/toolResultStorage.ts::applyToolResultBudget`
 * adapted to gut's flat `LLMMessage` shape (tool messages are
 * `role: "tool"` with `toolCallId`, not `tool_result` blocks inside
 * user `Message.message.content`).
 *
 * What this enforces:
 *   - Walk the message list once, splitting tool-role messages into
 *     per-API-round groups (a maximal run of tool messages between
 *     assistant messages). Mirrors openclaude's `collectCandidatesByMessage`
 *     which groups by adjacent user messages between assistants.
 *   - For each group, partition by prior decision: must-reapply (cached
 *     replacement), frozen (seen unreplaced — prefix already cached),
 *     fresh (new). Mirrors openclaude `partitionByPriorDecision`.
 *   - Sum the group's bytes. If over `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`,
 *     pick the largest fresh candidates and replace until under budget
 *     (or fresh is exhausted). Mirrors openclaude `selectFreshToReplace`.
 *   - Replacement content is a `<persisted-output>` marker carrying the
 *     original size + `[Old tool result content cleared]` body. The tag
 *     is the detection sentinel so subsequent passes do not re-process
 *     the already-replaced block (mirrors openclaude
 *     `isContentAlreadyCompacted`).
 *
 * Decisions are recorded on the `ContentReplacementState` (mutated in
 * place — caller holds the stable reference across turns). State carries
 * `seenIds` (frozen decisions) and `replacements` (cached marker
 * strings) so re-application across turns is byte-identical.
 *
 * Integration with `RolloutStore` (I-88 byte tally): this helper does
 * not need the per-turn byte index for in-memory enforcement — every
 * tool message's bytes are measured directly off `content`. The
 * RolloutStore index already exists at `session/rollout-store.ts:118`
 * (`getToolResultBytes`/`getToolResultBytesIndexSnapshot`) and is
 * consumed by the compact prompt-build path
 * (`llm/compact/compact.ts::filterLargeToolResultsForCompact`). The
 * complementary in-flight enforcement here is what was previously
 * stubbed and is now ported.
 *
 * Skip semantics: `skipToolNames` carries tools whose
 * `maxResultBytes` is `Infinity` (e.g. file readers whose own maxTokens
 * is the bound). Mirrors openclaude's per-tool-`Infinity` opt-out.
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import type {
  ContentReplacementRecord,
  ContentReplacementState,
} from "../../session/_deps/tool-result-storage.js";

// ─────────────────────────────────────────────────────────────────────
// Constants — mirror openclaude `constants/toolLimits.ts`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-API-round aggregate budget. Openclaude default
 * `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` (200KB). Same default
 * here so the in-flight enforcement matches upstream char-budget math.
 *
 * Env override `AGENC_TOOL_RESULT_PER_MESSAGE_BUDGET_CHARS` lets
 * operators tune the threshold without rebuilding. Negative or
 * non-finite values fall back to the default.
 */
const DEFAULT_PER_MESSAGE_BUDGET_CHARS = 200_000;

/**
 * Marker tags used to wrap a replaced tool result. The opening tag is
 * the detection sentinel — once a content string starts with it, the
 * block is treated as already-compacted and skipped on subsequent
 * passes. Mirrors openclaude `PERSISTED_OUTPUT_TAG`.
 */
const PERSISTED_OUTPUT_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSING_TAG = "</persisted-output>";

/** Body inserted inside the persisted-output marker for cleared
 *  tool results. Re-uses snip-compact's existing operator-facing
 *  string so transcripts read consistently across the two clearance
 *  paths. */
const TOOL_RESULT_CLEARED_BODY = "[Old tool result content cleared]";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type ToolResultReplacementRecord = ContentReplacementRecord;

export interface ApplyToolResultBudgetResult<T> {
  readonly messages: T;
  readonly newlyReplaced: ReadonlyArray<ToolResultReplacementRecord>;
}

/**
 * Mirror already-known tool-result replacements back into a live in-memory
 * transcript. This follows openclaude's `applyToolResultReplacementsToMessages`
 * contract: once a tool result has been replaced for model use, the original
 * oversized string must be dropped from the long-lived message array too.
 */
export function applyToolResultReplacementsToMessages<T>(
  messages: T,
  replacements: ReadonlyMap<string, string>,
): T {
  if (replacements.size === 0 || !Array.isArray(messages)) return messages;

  let changed = false;
  const next = (messages as unknown as ReadonlyArray<LLMMessage>).map(
    (message) => {
      if (message.role !== "tool") return message;
      const id = message.toolCallId;
      if (typeof id !== "string" || id.length === 0) return message;
      const replacement = replacements.get(id);
      if (replacement === undefined || message.content === replacement) {
        return message;
      }
      changed = true;
      return { ...message, content: replacement };
    },
  );

  return (changed ? next : messages) as T;
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

interface ToolCandidate {
  readonly index: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly bytes: number;
}

interface PartitionedCandidates {
  readonly mustReapply: ReadonlyArray<ToolCandidate & { replacement: string }>;
  readonly frozen: ReadonlyArray<ToolCandidate>;
  readonly fresh: ReadonlyArray<ToolCandidate>;
}

function getPerMessageBudgetChars(): number {
  const raw = process.env.AGENC_TOOL_RESULT_PER_MESSAGE_BUDGET_CHARS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PER_MESSAGE_BUDGET_CHARS;
}

/** UTF-8 byte length of an LLMMessage `content` value. */
function messageContentBytes(message: LLMMessage): number {
  const content = message.content;
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      total += Buffer.byteLength(part.text, "utf8");
    }
    // image_url / other parts intentionally not counted — they are not
    // text payloads and the caller's compaction policy treats them
    // separately (mirrors openclaude `hasImageBlock` skip).
  }
  return total;
}

function isContentAlreadyCompacted(message: LLMMessage): boolean {
  const content = message.content;
  if (typeof content !== "string") return false;
  return content.startsWith(PERSISTED_OUTPUT_TAG);
}

function hasImageContent(message: LLMMessage): boolean {
  const content = message.content;
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "image_url");
}

/**
 * Build the human-readable replacement string the model sees in place
 * of an over-budget tool result. Mirrors openclaude
 * `buildLargeToolResultMessage` shape (PERSISTED_OUTPUT_TAG ...
 * PERSISTED_OUTPUT_CLOSING_TAG) but without on-disk persistence —
 * gut does not maintain the per-result file store yet, so the body
 * is the cleared-marker explainer with the original size annotation.
 */
function buildReplacementContent(originalBytes: number): string {
  return [
    PERSISTED_OUTPUT_TAG,
    `Tool result was ${originalBytes} bytes; cleared from history to fit per-turn budget.`,
    TOOL_RESULT_CLEARED_BODY,
    PERSISTED_OUTPUT_CLOSING_TAG,
  ].join("\n");
}

/**
 * Group adjacent tool-role messages into per-API-round buckets. A
 * group is bounded by an assistant message (or end-of-list).
 * Non-tool/non-assistant messages do not break a group (mirrors
 * openclaude's treatment of attachments / progress events as
 * non-boundary).
 */
function collectGroups(
  messages: ReadonlyArray<LLMMessage>,
): ToolCandidate[][] {
  const groups: ToolCandidate[][] = [];
  let current: ToolCandidate[] = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      flush();
      continue;
    }
    if (message.role !== "tool") continue;
    if (isContentAlreadyCompacted(message)) continue;
    if (hasImageContent(message)) continue;
    const id = message.toolCallId;
    if (typeof id !== "string" || id.length === 0) continue;
    current.push({
      index: i,
      toolCallId: id,
      toolName: typeof message.toolName === "string" ? message.toolName : "",
      bytes: messageContentBytes(message),
    });
  }
  flush();

  return groups;
}

function partitionByPriorDecision(
  candidates: ReadonlyArray<ToolCandidate>,
  state: ContentReplacementState,
): PartitionedCandidates {
  const mustReapply: Array<ToolCandidate & { replacement: string }> = [];
  const frozen: ToolCandidate[] = [];
  const fresh: ToolCandidate[] = [];
  for (const c of candidates) {
    const replacement = state.replacements.get(c.toolCallId);
    if (replacement !== undefined) {
      mustReapply.push({ ...c, replacement });
    } else if (state.seenIds.has(c.toolCallId)) {
      frozen.push(c);
    } else {
      fresh.push(c);
    }
  }
  return { mustReapply, frozen, fresh };
}

/**
 * Greedy: pick largest fresh candidates until the model-visible total
 * (frozen + remaining fresh) is at or under budget, or fresh exhausted.
 * Mirrors openclaude `selectFreshToReplace`.
 */
function selectFreshToReplace(
  fresh: ReadonlyArray<ToolCandidate>,
  frozenSize: number,
  limit: number,
): ToolCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.bytes - a.bytes);
  const selected: ToolCandidate[] = [];
  let remaining =
    frozenSize + fresh.reduce((sum, c) => sum + c.bytes, 0);
  for (const c of sorted) {
    if (remaining <= limit) break;
    selected.push(c);
    remaining -= c.bytes;
  }
  return selected;
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * I-88 in-flight enforcement. Walk `messages`, group tool-role messages
 * by API-round, and for each over-budget group replace the largest
 * fresh tool results with a `<persisted-output>` clear marker.
 *
 *   - `state` undefined → feature off (call site bypasses enforcement).
 *   - `state` carried across turns: previously-decided ids are frozen
 *     (cache stability). New ids selected for replacement are recorded
 *     into `state.replacements` so subsequent turns re-apply the same
 *     marker byte-identical via the must-reapply path.
 *   - `skipToolNames`: tool names whose `maxResultBytes` is `Infinity`.
 *     Marked `seen` (frozen) but never selected for replacement —
 *     the tool's own bound is the limit, not this wrapper.
 *   - `writeToTranscript`: optional callback invoked once per call with
 *     newly-decided records. The call-site closure is best-effort
 *     persistence (sidecar JSON when a session is bound — see
 *     `recordContentReplacement` in `phases/_deps/session-storage`).
 *
 * Mutates `state` in place. Returns a NEW `messages` array when any
 * replacement (must-reapply or fresh) fires, otherwise returns the
 * input array by reference.
 *
 * Generic `T` matches the call-site `as never` cast in
 * `prepare-context.ts`. Internally we treat `messages` as
 * `ReadonlyArray<LLMMessage>`.
 */
export async function applyToolResultBudget<T>(
  messages: T,
  state: ContentReplacementState | undefined,
  writeToTranscript?: (
    records: ReadonlyArray<ToolResultReplacementRecord>,
  ) => void,
  skipToolNames?: ReadonlySet<string>,
): Promise<ApplyToolResultBudgetResult<T>> {
  if (!state) return { messages, newlyReplaced: [] };
  if (!Array.isArray(messages)) {
    return { messages, newlyReplaced: [] };
  }

  const messagesIn = messages as unknown as ReadonlyArray<LLMMessage>;
  const limit = getPerMessageBudgetChars();
  const groups = collectGroups(messagesIn);
  if (groups.length === 0) {
    return { messages, newlyReplaced: [] };
  }

  const replacementMap = new Map<string, string>();
  const newlyReplaced: ToolResultReplacementRecord[] = [];

  for (const group of groups) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(
      group,
      state,
    );

    // Re-apply: pure Map lookups, byte-identical, cannot fail.
    for (const c of mustReapply) {
      replacementMap.set(c.toolCallId, c.replacement);
    }

    // No fresh candidates → group already fully decided. seenIds
    // already includes mustReapply/frozen ids from prior passes;
    // re-add is a no-op but keeps the invariant explicit.
    if (fresh.length === 0) {
      for (const c of group) state.seenIds.add(c.toolCallId);
      continue;
    }

    // Tools opted out via skipToolNames (maxResultBytes === Infinity)
    // are marked seen (frozen) so the decision sticks across turns,
    // but never selected for replacement.
    const skipped = fresh.filter((c) => skipToolNames?.has(c.toolName));
    for (const c of skipped) state.seenIds.add(c.toolCallId);
    const eligible = fresh.filter((c) => !skipToolNames?.has(c.toolName));

    const frozenSize = frozen.reduce((sum, c) => sum + c.bytes, 0);
    const eligibleSize = eligible.reduce((sum, c) => sum + c.bytes, 0);

    const selected =
      frozenSize + eligibleSize > limit
        ? selectFreshToReplace(eligible, frozenSize, limit)
        : [];

    // Mark non-selected candidates seen NOW. Selected ids are marked
    // alongside the replacements.set call below so observers never see
    // an id in seenIds but absent from replacements (would misclassify
    // as frozen and break cache).
    const selectedIds = new Set(selected.map((c) => c.toolCallId));
    for (const c of group) {
      if (!selectedIds.has(c.toolCallId)) state.seenIds.add(c.toolCallId);
    }

    if (selected.length === 0) continue;

    for (const candidate of selected) {
      const replacement = buildReplacementContent(candidate.bytes);
      state.seenIds.add(candidate.toolCallId);
      state.replacements.set(candidate.toolCallId, replacement);
      replacementMap.set(candidate.toolCallId, replacement);
      newlyReplaced.push({
        kind: "tool-result",
        toolUseId: candidate.toolCallId,
        replacement,
      });
    }
  }

  if (replacementMap.size === 0) {
    return { messages, newlyReplaced: [] };
  }

  // Build new array with replacements applied. Pass through any
  // message whose id is not in replacementMap by reference.
  const next = applyToolResultReplacementsToMessages(messages, replacementMap);

  if (newlyReplaced.length > 0 && writeToTranscript) {
    writeToTranscript(newlyReplaced);
  }

  return {
    messages: next,
    newlyReplaced,
  };
}
