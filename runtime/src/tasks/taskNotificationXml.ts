import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
} from '../constants/xml.js'
import { escapeXml } from '../utils/xml.js'

type TaskNotificationUsage = {
  totalTokens: number
  toolUses: number
  durationMs: number
}

type TaskNotificationWorktree = {
  path: string
  branch?: string
}

export type TaskNotificationXmlInput = {
  taskId: string
  toolUseId?: string
  taskType?: string
  outputPath: string
  status?: string
  summary: string
  result?: string
  usage?: TaskNotificationUsage
  worktree?: TaskNotificationWorktree
}

function textTag(tag: string, value: string | number): string {
  return `<${tag}>${escapeXml(String(value))}</${tag}>`
}

export function buildTaskNotificationXml({
  taskId,
  toolUseId,
  taskType,
  outputPath,
  status,
  summary,
  result,
  usage,
  worktree,
}: TaskNotificationXmlInput): string {
  const lines = [`<${TASK_NOTIFICATION_TAG}>`, textTag(TASK_ID_TAG, taskId)]

  if (toolUseId) {
    lines.push(textTag(TOOL_USE_ID_TAG, toolUseId))
  }
  if (taskType) {
    lines.push(textTag(TASK_TYPE_TAG, taskType))
  }

  lines.push(textTag(OUTPUT_FILE_TAG, outputPath))

  if (status) {
    lines.push(textTag(STATUS_TAG, status))
  }

  lines.push(textTag(SUMMARY_TAG, summary))

  if (result) {
    lines.push(textTag('result', result))
  }

  if (usage) {
    lines.push(
      `<usage>${textTag('total_tokens', usage.totalTokens)}${textTag('tool_uses', usage.toolUses)}${textTag('duration_ms', usage.durationMs)}</usage>`,
    )
  }

  if (worktree) {
    lines.push(
      `<${WORKTREE_TAG}>${textTag(WORKTREE_PATH_TAG, worktree.path)}${worktree.branch ? textTag(WORKTREE_BRANCH_TAG, worktree.branch) : ''}</${WORKTREE_TAG}>`,
    )
  }

  lines.push(`</${TASK_NOTIFICATION_TAG}>`)
  return lines.join('\n')
}
