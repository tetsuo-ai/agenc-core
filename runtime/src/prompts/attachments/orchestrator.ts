/**
 * Per-turn attachments orchestrator.
 *
 * Hand-port of the upstream attachment orchestrator
 * (`src/utils/attachments.ts:744-1004`, `getAttachments()`). Runs every
 * registered producer in parallel each turn, collects their outputs, and
 * returns a flat `Attachment[]`. Producers
 * are pure functions of `(opts, trackingState)` and are responsible for
 * their own gating (turn-counting, hash diffing, mode checks).
 *
 * Call site: `runtime/src/session/run-turn.ts:prepareSamplingRequestBoundary`
 * between `prepareContext()` and `buildSamplingRequestContract()`. The
 * orchestrator's `Attachment[]` output is converted to `LLMMessage[]` via
 * `./messages.ts:attachmentsToMessages` and inserted after the leading
 * system-prompt prefix in `state.messagesForQuery`.
 *
 * Producers are registered statically in `PRODUCERS` below — adding a new
 * producer means: (1) declare its variant in `./types.ts`, (2) implement
 * the producer file, (3) add it to `PRODUCERS`, (4) extend
 * `attachmentsToMessages` to render it.
 *
 * @module
 */

import type { LLMMessage, LLMTool } from "../../llm/types.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import type { AttachmentTrackingState } from "../../session/attachment-state.js";
import { getAttachmentTrackingState } from "../../session/attachment-state.js";
import { agentListingDeltaProducer } from "./agent-listing-delta.js";
import { autoModeProducer } from "./auto-mode.js";
import { swarmModeProducer } from "./swarm-mode.js";
import { criticalReminderProducer } from "./critical-reminder.js";
import { dateChangeProducer } from "./date-change.js";
import { deferredToolsDeltaProducer } from "./deferred-tools-delta.js";
import { mcpInstructionsDeltaProducer } from "./mcp-delta.js";
import { outputStyleProducer } from "./output-style.js";
import { planModeProducer } from "./plan-mode.js";
import { verifyPlanReminderProducer } from "./verify-plan-reminder.js";
import { changedFilesProducer } from "./changed-files.js";
import { agentMentionsProducer } from "./agent-mentions.js";
import { fileMentionsProducer } from "./file-mentions.js";
import { lspDiagnosticsProducer } from "./lsp-diagnostics.js";
import { mcpResourcesProducer } from "./mcp-resources.js";
import { relevantMemoriesProducer } from "./relevant-memories.js";
import { skillListingProducer } from "./skill-listing.js";
import type { Attachment } from "./types.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";

/**
 * Inputs every producer receives. Mirrors the upstream donor's
 * `getAttachments(input, toolUseContext, ...)` parameter set, adapted to
 * AgenC types.
 */
export interface GetAttachmentsOptions {
  /**
   * Opaque session identity for cross-turn state isolation. Anything
   * stable per-session works (the `Session` instance itself is the
   * canonical choice).
   */
  readonly sessionKey: object;
  /** Most recent user-channel message text, if any. */
  readonly userInput: string | null;
  /**
   * Provider-shaped tool catalog the model will see this turn. Drives the
   * deferred-tools delta hash.
   */
  readonly loadedTools: readonly LLMTool[];
  /**
   * Names of deferred tools that have been discovered (loaded into the
   * visible catalog) via `system.searchTools` so far this session. Drives
   * the deferred-tools delta producer's diff. Optional — when omitted,
   * the producer treats the discovered set as empty (matches AgenC
   * bootstraps with no ToolSearch tool registered).
   *
   * Sourced at the call site from
   * `session.services.registry.getDiscoveredToolNames?.() ?? new Set()`.
   */
  readonly discoveredToolNames?: ReadonlySet<string>;
  /**
   * Conversation history projected for the next model request, post-
   * compaction. Producers scan this for prior `<system-reminder>` markers
   * to throttle re-emission.
   */
  readonly messages: readonly LLMMessage[];
  /** Active permission mode + sandbox context. */
  readonly permissionContext: ToolPermissionContext;
  /** Workspace cwd; used for AGENC.md walk + file-mention resolution. */
  readonly cwd: string;
  /** Authenticated process boundary for attachment helpers such as Poppler. */
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  /**
   * Additional roots allowed for `@path` file mention rendering. When
   * omitted, file mentions are limited to `cwd`.
   */
  readonly fileMentionAllowedRoots?: readonly string[];
  /** Subagent depth (0 for the main thread). Some producers are main-only. */
  readonly subagentDepth: number;
  /** Cancellation signal threaded from the turn loop. */
  readonly signal: AbortSignal;
  /**
   * AgenC home directory used to derive `<agencHome>/memory` for the
   * relevant-memory producer. Optional — when omitted (e.g. unit tests
   * that do not exercise memory), the producer skips the scan and emits
   * nothing. Sourced at the call site from
   * `session.services.configStore?.agencHome`.
   */
  readonly agencHome?: string;
  /** Runtime skill manager used to announce Skill-tool candidates. */
  readonly skillsManager?: {
    skillsForConfig(input: unknown, fs: unknown): Promise<{
      readonly availableSkills?: ReadonlyArray<{
        readonly name: string;
        readonly description?: string;
        readonly whenToUse?: string;
        readonly disableModelInvocation?: boolean;
        readonly loadedFrom?: string;
      }>;
    }>;
  };
  /** Current loaded config snapshot for config-gated skill/plugin discovery. */
  readonly config?: unknown;
  /** Current model context window, if known, for listing budget sizing. */
  readonly contextWindowTokens?: number;
}

/**
 * A producer is an async function that may emit zero or more attachments
 * for the current turn. Producers MUST honor the abort signal and MUST be
 * safe to call concurrently with other producers.
 */
export type AttachmentProducer = (
  opts: GetAttachmentsOptions,
  trackingState: AttachmentTrackingState,
) => Promise<readonly Attachment[]>;

/**
 * Static registry of every producer. Order is not significant — outputs
 * are flattened in registration order, but callers should not depend on
 * inter-attachment ordering for correctness. Most attachments are
 * idempotent within a turn.
 *
 * Producers land in this list as their files are added in subsequent
 * commits. Empty during the foundation commit; the orchestrator and
 * call-site wiring are otherwise complete.
 */
const PRODUCERS: readonly AttachmentProducer[] = [
  // Phase 2 — Mode pulses:
  planModeProducer,
  verifyPlanReminderProducer,
  autoModeProducer,
  swarmModeProducer,
  //
  // Phase 3 — Mid-session deltas:
  deferredToolsDeltaProducer,
  agentListingDeltaProducer,
  mcpInstructionsDeltaProducer,
  //
  // Phase 4 — System reminders:
  dateChangeProducer,
  criticalReminderProducer,
  outputStyleProducer,
  //
  // Phase 5 — Memory + file injections:
  relevantMemoriesProducer,
  changedFilesProducer,
  lspDiagnosticsProducer,
  agentMentionsProducer,
  mcpResourcesProducer,
  fileMentionsProducer,
  skillListingProducer,
];

/**
 * Run every producer in parallel and return the flattened attachment
 * list.
 *
 * Producer failures are logged (per producer) and treated as empty
 * outputs — one failing producer must not block the others. Matches
 * AgenC's `maybe()` wrapper at `attachments.ts:1006`.
 */
export async function getAttachments(
  opts: GetAttachmentsOptions,
): Promise<readonly Attachment[]> {
  const trackingState = getAttachmentTrackingState(opts.sessionKey);
  const settled = await Promise.allSettled(
    PRODUCERS.map((producer) => producer(opts, trackingState)),
  );
  const all: Attachment[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      all.push(...result.value);
      continue;
    }
    // Producer threw. Producer authors are responsible for not throwing,
    // but we never let one failure block the others. Surface to console
    // for the daemon log; do not propagate.
    // eslint-disable-next-line no-console
    console.error("[attachments] producer failed:", result.reason);
  }
  return all;
}
