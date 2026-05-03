/**
 * Per-turn attachment data type.
 *
 * Hand-port of the `Attachment` discriminated union from AgenC's
 * `src/utils/attachments.ts:441-718`, restricted to the subset of variants
 * that have an AgenC analog. Variants tied to features AgenC doesn't ship
 * (`ultrathink_effort`, `bagel_console_errors`, `buddy_intro`,
 * `lsp_diagnostics`, `ide_selection`,
 * `structured_output`) are intentionally absent — when AgenC
 * adds the underlying feature, the variant lands here alongside its
 * producer. Provider-neutral usage/budget notices are upstream runtime
 * surfaces and intentionally do not mirror any provider account upsell.
 *
 * Attachment names use AgenC branding. Otherwise the prose, schema, and
 * gating logic match AgenC exactly.
 *
 * @module
 */

/**
 * Memory file injection from the per-file 4-phase nested traversal.
 * Source: upstream attachment donor `attachments.ts:494-512`.
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
 * Source: upstream attachment donor `attachments.ts:514-524`.
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
 * Source: upstream attachment donor `attachments.ts:566-577`.
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
 * Source: upstream attachment donor `attachments.ts:579-583`.
 */
export interface PlanModeReentryAttachment {
  readonly kind: "plan_mode_reentry";
  readonly planFilePath: string;
  readonly planExists: boolean;
}

/**
 * Plan-mode exit attachment (one-shot, fires on transition out).
 * Source: upstream attachment donor `attachments.ts:585-587`.
 */
export interface PlanModeExitAttachment {
  readonly kind: "plan_mode_exit";
  readonly planFilePath: string;
  readonly planExists: boolean;
}

/**
 * Post-plan implementation reminder.
 * Source: upstream attachment donor `attachments.ts:655`.
 */
export interface VerifyPlanReminderAttachment {
  readonly kind: "verify_plan_reminder";
}

/**
 * Auto-mode reminder pulse (analogous to plan-mode).
 * Source: upstream attachment donor `attachments.ts:566-577` (auto-mode family).
 */
export interface AutoModeAttachment {
  readonly kind: "auto_mode";
  readonly variant: "full" | "sparse";
}

/**
 * Auto-mode exit attachment (one-shot).
 * Source: upstream attachment donor `attachments.ts:585-587` (auto-mode family).
 */
export interface AutoModeExitAttachment {
  readonly kind: "auto_mode_exit";
}

/**
 * Date-change notification (fires once per local-calendar-day boundary).
 * Source: upstream attachment donor `attachments.ts:1416-1445`.
 */
export interface DateChangeAttachment {
  readonly kind: "date_change";
  /** Today's local ISO date (YYYY-MM-DD). */
  readonly newDate: string;
}

/**
 * One-shot critical reminder set by runtime producers (mode transitions,
 * rate-limit warnings, etc.). Cleared after firing.
 * Source: upstream attachment donor `attachments.ts:1588-1596`.
 */
export interface CriticalSystemReminderAttachment {
  readonly kind: "critical_system_reminder";
  readonly content: string;
}

/**
 * Output-style attachment (fires every turn when style is non-default).
 * Source: upstream attachment donor `attachments.ts:1598-1613`.
 */
export interface OutputStyleAttachment {
  readonly kind: "output_style";
  /** Style identifier; "default" is filtered before producer fires. */
  readonly style: string;
}

/** Provider-neutral context-window usage notice. */
export interface TokenUsageAttachment {
  readonly kind: "token_usage";
  readonly used: number;
  readonly total: number;
  readonly remaining: number;
  readonly percentUsed: number;
}

/** Provider-neutral session USD budget notice. */
export interface BudgetUsdAttachment {
  readonly kind: "budget_usd";
  readonly used: number;
  readonly total: number;
  readonly remaining: number;
  readonly percentUsed: number;
}

/** Output-token usage notice for the current turn and session. */
export interface OutputTokenUsageAttachment {
  readonly kind: "output_token_usage";
  readonly turn: number;
  readonly session: number;
  readonly budget: number | null;
}

/** Auto-compaction threshold reminder. */
export interface CompactionReminderAttachment {
  readonly kind: "compaction_reminder";
  readonly used: number;
  readonly threshold: number;
  readonly remaining: number;
  readonly percentUsed: number;
}

/**
 * Deferred-tool catalog delta (new tools loaded mid-session via
 * `system.searchTools`).
 * Source: upstream attachment donor `attachments.ts:1456-1476`.
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
 * Source: upstream attachment donor `attachments.ts:1491-1560`.
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
 * Source: upstream attachment donor `attachments.ts:1560-1586`.
 */
export interface McpInstructionsDeltaAttachment {
  readonly kind: "mcp_instructions_delta";
  readonly addedNames: readonly string[];
  readonly addedBlocks: readonly string[];
  readonly removedNames: readonly string[];
}

/**
 * Diff snippet for a file modified mid-session via Edit/Write/exec_command.
 * Source: upstream attachment donor `attachments.ts:2064-2162` (`getChangedFiles`).
 */
export interface EditedTextFileAttachment {
  readonly kind: "edited_text_file";
  readonly filename: string;
  /** Diff snippet covering only changed regions. */
  readonly snippet: string;
}

/**
 * Re-injected image after mid-session modification.
 * Source: upstream attachment donor `attachments.ts:2064-2162` (`getChangedFiles` image branch).
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
 * Source: upstream attachment donor `attachments.ts:1967-1994`.
 */
export interface AgentMentionAttachment {
  readonly kind: "agent_mention";
  readonly agentType: string;
}

/**
 * File content resolved from a user-authored `@path` mention.
 * Source: upstream attachment donor `attachments.ts:2994-3230`.
 */
export interface FileMentionContextAttachment {
  readonly kind: "file_mention";
  readonly files: ReadonlyArray<{
    readonly raw: string;
    readonly path: string;
    readonly resolved: string;
    readonly bytes: number;
    readonly lineCount: number;
    readonly truncated: boolean;
    readonly content: string;
  }>;
}

/** Image content resolved from a user-authored `@path` mention. */
export interface ImageMentionContextAttachment {
  readonly kind: "image_mention";
  readonly images: ReadonlyArray<{
    readonly raw: string;
    readonly path: string;
    readonly resolved: string;
    readonly mediaType: string;
    readonly url: string;
  }>;
}

/** PDF content resolved from a user-authored `@path` mention. */
export interface PdfMentionContextAttachment {
  readonly kind: "pdf_mention";
  readonly pdfs: ReadonlyArray<{
    readonly raw: string;
    readonly path: string;
    readonly resolved: string;
    readonly mediaType: "application/pdf";
    readonly data: string;
    readonly bytes: number;
    readonly filename: string;
    readonly fallbackText?: string;
    readonly fallbackTextTruncated?: boolean;
    readonly fallbackTextError?: string;
  }>;
}

/**
 * Available skills listing for the model-facing Skill tool.
 * Source: upstream skill-tool donor `tools/SkillTool/prompt.ts` listing behavior.
 */
export interface SkillListingAttachment {
  readonly kind: "skill_listing";
  readonly content: string;
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
  | VerifyPlanReminderAttachment
  | AutoModeAttachment
  | AutoModeExitAttachment
  | DateChangeAttachment
  | CriticalSystemReminderAttachment
  | OutputStyleAttachment
  | TokenUsageAttachment
  | BudgetUsdAttachment
  | OutputTokenUsageAttachment
  | CompactionReminderAttachment
  | DeferredToolsDeltaAttachment
  | AgentListingDeltaAttachment
  | McpInstructionsDeltaAttachment
  | EditedTextFileAttachment
  | EditedImageFileAttachment
  | AgentMentionAttachment
  | FileMentionContextAttachment
  | ImageMentionContextAttachment
  | PdfMentionContextAttachment
  | SkillListingAttachment;

/** All possible `Attachment.kind` values. */
export type AttachmentKind = Attachment["kind"];

/** Type guard for narrowing the discriminated union by kind. */
export function isAttachmentOfKind<K extends AttachmentKind>(
  attachment: Attachment,
  kind: K,
): attachment is Extract<Attachment, { kind: K }> {
  return attachment.kind === kind;
}
