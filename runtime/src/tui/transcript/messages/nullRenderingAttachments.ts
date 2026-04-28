/**
 * nullRenderingAttachments — filters out attachment messages that render
 * to nothing, so the transcript's render-budget cap doesn't get spent
 * on invisible entries.
 *
 * Adapted from the upstream null-rendering-attachment helper.
 *
 * AgenC scope notes:
 *   - Upstream's full attachment subtype enum ties into many upstream
 *     hook/system surfaces that AgenC has not ported (output styles,
 *     ultrathink effort, mod-managed companion intro, etc.). We preserve
 *     the canonical list verbatim because it's the source of truth for
 *     "which attachment subtypes do not paint" — even if a given
 *     subtype is never produced by the AgenC reducer today, naming it
 *     here keeps future ports trivially compatible.
 *   - The TypeScript invariant from upstream (`satisfies readonly
 *     Attachment['type'][]`) is dropped because AgenC has no
 *     `Attachment` type to satisfy; the literal list stands on its own.
 *   - The runtime check accepts any object with a `type` discriminator
 *     and an optional `attachment.type` shape so callers can pass
 *     either an AgenC `TranscriptMessage` or a future attachment-row
 *     payload without reaching back into upstream message types.
 *
 * @module
 */

const NULL_RENDERING_TYPES = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'output_style',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'todo_reminder',
  'context_efficiency',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'companion_intro',
  'token_usage',
  'ultrathink_effort',
  'max_turns_reached',
  'task_reminder',
  'auto_mode',
  'auto_mode_exit',
  'output_token_usage',
  'pen_mode_enter',
  'pen_mode_exit',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
] as const

export type NullRenderingAttachmentType = (typeof NULL_RENDERING_TYPES)[number]

const NULL_RENDERING_ATTACHMENT_TYPES: ReadonlySet<string> = new Set(
  NULL_RENDERING_TYPES,
)

/**
 * Minimal shape this helper accepts: an outer message tagged
 * `type === 'attachment'` whose `attachment` payload carries its own
 * `type` discriminator. Anything narrower (concrete `TranscriptMessage`
 * variants etc.) satisfies this structurally.
 */
export interface NullRenderingAttachmentCandidate {
  readonly type?: string
  readonly attachment?: { readonly type?: string }
}

/**
 * True when this message is an attachment whose subtype is rendered as
 * `null` with no visible output. Filter these out before counting and
 * before applying the transcript render cap so invisible hook
 * attachments (`hook_success`, `hook_additional_context`,
 * `hook_cancelled`) don't inflate the "N messages" count or eat into
 * the render budget.
 */
export function isNullRenderingAttachment(
  msg: NullRenderingAttachmentCandidate,
): boolean {
  return (
    msg.type === 'attachment' &&
    typeof msg.attachment?.type === 'string' &&
    NULL_RENDERING_ATTACHMENT_TYPES.has(msg.attachment.type)
  )
}
