import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { ValidationResult } from '../Tool.js'
import { buildTool, type ToolDef } from '../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
  normalizeDelivery,
} from '../../utils/cronTasks.js'
import { getCronScheduler } from '../../utils/cronScheduler.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

const MAX_JOBS = 50

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z
      .string()
      .describe(
        'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
      ),
    prompt: z.string().describe('The prompt to enqueue at each fire time.'),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true (default) = fire on every cron match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
    ),
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = persist to .agenc/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this AgenC session ends. Use true only when the user asks the task to survive across sessions.',
    ),
    announceChannel: z
      .string()
      .optional()
      .describe(
        'Gateway channel id to deliver the result to (e.g. "telegram", "stdio"). Requires announceTo. The job then runs in an isolated gateway session (needs a running `agenc gateway run`), not this one.',
      ),
    announceTo: z
      .string()
      .optional()
      .describe(
        'Conversation id on announceChannel to deliver to (e.g. a Telegram chat id).',
      ),
    webhook: z
      .string()
      .optional()
      .describe(
        'http(s) URL to POST the result to as JSON. Combinable with announceChannel.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a recurring or one-shot prompt',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.cron}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
        errorCode: 1,
      }
    }
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
        errorCode: 2,
      }
    }
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        errorCode: 3,
      }
    }
    // Teammates don't persist across sessions, so a durable teammate cron
    // would orphan on restart (agentId would point to a nonexistent teammate).
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          'durable crons are not supported for teammates (teammates do not persist across sessions)',
        errorCode: 4,
      }
    }
    if (input.announceChannel !== undefined && input.announceTo === undefined) {
      return {
        result: false,
        message: 'announceChannel requires announceTo (the conversation id).',
        errorCode: 5,
      }
    }
    if (input.webhook !== undefined && !/^https?:\/\//i.test(input.webhook)) {
      return {
        result: false,
        message: 'webhook must be an http(s) URL.',
        errorCode: 6,
      }
    }
    return { result: true }
  },
  async call({
    cron,
    prompt,
    recurring = true,
    durable = false,
    announceChannel,
    announceTo,
    webhook,
  }) {
    const deliver = normalizeDelivery({
      channel: announceChannel,
      to: announceTo,
      webhook,
    })
    // Kill switch forces session-only; schema stays stable so the model sees
    // no validation errors when the gate flips mid-session.
    // Delivery-routed jobs are executed by the GATEWAY from the persisted
    // task file, so they are always durable.
    const effectiveDurable =
      deliver !== undefined ? true : durable && isDurableCronEnabled()
    const id = await addCronTask(
      cron,
      prompt,
      recurring,
      effectiveDurable,
      getTeammateContext()?.agentId,
      deliver,
    )
    // Enable the scheduler so the task fires in this session, then start the
    // timer-driven driver and reschedule it to the new task's next-due moment.
    // start() is gated behind the enable flag (just set) and is idempotent;
    // reschedule() re-arms the single sleep-until-next-due timer so this brand
    // new task — which may be due sooner than anything already scheduled —
    // preempts the current sleep instead of being missed. The driver never
    // polls the model; it wakes only when a task is genuinely due.
    setScheduledTasksEnabled(true)
    const scheduler = getCronScheduler()
    scheduler.start()
    void scheduler.reschedule()
    return {
      data: {
        id,
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where = output.durable
      ? 'Persisted to .agenc/scheduled_tasks.json'
      : 'Session-only (not written to disk, dies when AgenC exits)'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.recurring
        ? `Scheduled recurring job ${output.id} (${output.humanSchedule}). ${where}. Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${output.id} (${output.humanSchedule}). ${where}. It will fire once then auto-delete.`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
