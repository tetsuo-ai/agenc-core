/**
 * Per-turn attachment data type.
 *
 * Hand-port of the `Attachment` discriminated union from AgenC's
 * `src/utils/attachments.ts:441-718`, restricted to the subset of variants
 * that have an AgenC analog. Variants tied to features AgenC doesn't ship
 * (`ultrathink_effort`, `bagel_console_errors`, `buddy_intro`,
 * `lsp_diagnostics`, `ide_selection`, `verified_plan_reminder`,
 * `structured_output`, `skill_*`) are intentionally absent — when AgenC
 * adds the underlying feature, the variant lands here alongside its
 * producer.
 *
 * Attachment names use AgenC branding where AgenC branded for itself
 * (e.g. `AGENC.md` instead of `CLAUDE.md`). Otherwise the prose, schema,
 * and gating logic match AgenC exactly.
 *
 * @module
 */

/**
 * Memory file injection from the per-file 4-phase nested traversal.
 * Source: AgenC `attachments.ts:494-512`.
 */
export interface NestedMemoryAttachment {
  readonly kind: "nested_memory";
  /** Absolute path to the memory file. */
  readonly path: string;
  /** Display path (relative to cwd when the path lives under it). */
  readonly displayPath: string;
  /** Memory file type — drives header rendering + permissions. */
  readonly memoryType: "User" | "Project" | "Local" | "Managed";
  /** The processed content actually injected into the model context. */
  readonly content: string;
  /** Disk mtime in ms. Used for cache stability + freshness display. */
  readonly mtimeMs: number;
}

/**
 * Selected relevant memories surfaced via the per-turn ranker.
 * Source: AgenC `attachments.ts:514-524`.
 */
export interface RelevantMemoriesAttachment {
  readonly kind: "relevant_memories";
  readonly memories: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly mtimeMs: number;
    /** Stable header bytes ("# <path> (mtime: ...)") — pre-computed for cache. */
    readonly header?: string;
    /** Truncation marker line count. Undefined for full reads. */
    readonly limit?: number;
    /** Structured citation metadata for audit/usage tracking. */
    readonly citation?: {
      readonly path: string;
      readonly lineStart: number;
      readonly lineEnd: number;
      readonly note: string;
      readonly rolloutIds: readonly string[];
    };
  }>;
}

/**
 * Plan-mode reminder pulse (full or sparse).
 * Source: AgenC `attachments.ts:566-577`.
 */
export interface PlanModeAttachment {
  readonly kind: "plan_mode";
  /** "full" fires on entry + every Nth attachment; "sparse" fires between. */
  readonly variant: "full" | "sparse";
  /** Absolute plan-file path for the active session. */
  readonly planFilePath: string;
  /** Whether the plan file already exists on disk. */
  readonly planExists: boolean;
}

/**
 * Plan-mode re-entry attachment (after a prior exit).
 * Source: AgenC `attachments.ts:579-583`.
 */
export interface PlanModeReentryAttachment {
  readonly kind: "plan_mode_reentry";
  readonly planFilePath: string;
  readonly planExists: boolean;
}

/**
 * Plan-mode exit attachment (one-shot, fires on transition out).
 * Source: AgenC `attachments.ts:585-587`.
 */
export interface PlanModeExitAttachment {
  readonly kind: "plan_mode_exit";
  readonly planFilePath: string;
  readonly planExists: boolean;
}

/**
 * Auto-mode reminder pulse (analogous to plan-mode).
 * Source: AgenC `attachments.ts:566-577` (auto-mode family).
 */
export interface AutoModeAttachment {
  readonly kind: "auto_mode";
  readonly variant: "full" | "sparse";
}

/**
 * Auto-mode exit attachment (one-shot).
 * Source: AgenC `attachments.ts:585-587` (auto-mode family).
 */
export interface AutoModeExitAttachment {
  readonly kind: "auto_mode_exit";
}

/**
 * Date-change notification (fires once per local-calendar-day boundary).
 * Source: AgenC `attachments.ts:1416-1445`.
 */
export interface DateChangeAttachment {
  readonly kind: "date_change";
  /** Today's local ISO date (YYYY-MM-DD). */
  readonly newDate: string;
}

/**
 * One-shot critical reminder set by runtime producers (mode transitions,
 * rate-limit warnings, etc.). Cleared after firing.
 * Source: AgenC `attachments.ts:1588-1596`.
 */
export interface CriticalSystemReminderAttachment {
  readonly kind: "critical_system_reminder";
  readonly content: string;
}

/**
 * Output-style attachment (fires every turn when style is non-default).
 * Source: AgenC `attachments.ts:1598-1613`.
 */
export interface OutputStyleAttachment {
  readonly kind: "output_style";
  /** Style identifier; "default" is filtered before producer fires. */
  readonly style: string;
}

/**
 * Deferred-tool catalog delta (new tools loaded mid-session via
 * `system.searchTools`).
 * Source: AgenC `attachments.ts:1456-1476`.
 */
export interface DeferredToolsDeltaAttachment {
  readonly kind: "deferred_tools_delta";
  readonly addedNames: readonly string[];
  /** Optional summary lines per added tool, "name: description" format. */
  readonly addedLines: readonly string[];
  readonly removedNames: readonly string[];
}

/**
 * Subagent listing delta (new agents available, agents removed).
 * Source: AgenC `attachments.ts:1491-1560`.
 */
export interface AgentListingDeltaAttachment {
  readonly kind: "agent_listing_delta";
  readonly addedTypes: readonly string[];
  readonly addedLines: readonly string[];
  readonly removedTypes: readonly string[];
  /** True on the first listing emit of the session. */
  readonly isInitial: boolean;
}

/**
 * MCP server instruction delta (new server connected, instructions changed).
 * Source: AgenC `attachments.ts:1560-1586`.
 */
export interface McpInstructionsDeltaAttachment {
  readonly kind: "mcp_instructions_delta";
  readonly addedNames: readonly string[];
  readonly addedBlocks: readonly string[];
  readonly removedNames: readonly string[];
}

/**
 * Diff snippet for a file modified mid-session via Edit/Write/exec_command.
 * Source: AgenC `attachments.ts:2064-2162` (`getChangedFiles`).
 */
export interface EditedTextFileAttachment {
  readonly kind: "edited_text_file";
  readonly filename: string;
  /** Diff snippet covering only changed regions. */
  readonly snippet: string;
}

/**
 * Re-injected image after mid-session modification.
 * Source: AgenC `attachments.ts:2064-2162` (`getChangedFiles` image branch).
 */
export interface EditedImageFileAttachment {
  readonly kind: "edited_image_file";
  readonly filename: string;
  /** Base64-encoded image bytes. */
  readonly content: string;
  /** Image media type, e.g. "image/png". */
  readonly mediaType: string;
}

/**
 * `@agent-<type>` mention extracted from user input.
 * Source: AgenC `attachments.ts:1967-1994`.
 */
export interface AgentMentionAttachment {
  readonly kind: "agent_mention";
  readonly agentType: string;
}

/**
 * Discriminated union of every attachment kind currently shipped by AgenC.
 *
 * To add a new kind: declare its interface above, append to this union,
 * and register its producer in
 * `runtime/src/prompts/attachments/orchestrator.ts`.
 */
export type Attachment =
  | NestedMemoryAttachment
  | RelevantMemoriesAttachment
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment
  | AutoModeAttachment
  | AutoModeExitAttachment
  | DateChangeAttachment
  | CriticalSystemReminderAttachment
  | OutputStyleAttachment
  | DeferredToolsDeltaAttachment
  | AgentListingDeltaAttachment
  | McpInstructionsDeltaAttachment
  | EditedTextFileAttachment
  | EditedImageFileAttachment
  | AgentMentionAttachment;

/** All possible `Attachment.kind` values. */
export type AttachmentKind = Attachment["kind"];

/** Type guard for narrowing the discriminated union by kind. */
export function isAttachmentOfKind<K extends AttachmentKind>(
  attachment: Attachment,
  kind: K,
): attachment is Extract<Attachment, { kind: K }> {
  return attachment.kind === kind;
}
