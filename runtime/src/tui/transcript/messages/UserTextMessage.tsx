/**
 * Top-level dispatcher for user text messages. Picks the right
 * sub-renderer based on which XML marker (if any) the runtime tagged
 * the user input with: bash input/output, slash command, memory
 * input, plan body, MCP resource update, or — falling through — a
 * plain prompt.
 *
 * AgenC scope notes:
 *   - Slack channel inputs (`<channel source="...">`) are out of
 *     scope and stripped from the dispatch table.
 *   - Teammate / agent-swarm renderers (`UserTeammateMessage`,
 *     `UserAgentNotificationMessage`) are tranche-5+ work; for now
 *     the dispatcher does not special-case them and falls through to
 *     `UserPromptMessage`.
 *   - GitHub-webhook, fork-boilerplate, and cross-session message
 *     branches were upstream-internal feature flags and are dropped
 *     here.
 */
import * as React from 'react'

import { UserBashInputMessage } from './UserBashInputMessage.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'
import { UserCommandMessage } from './UserCommandMessage.js'
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js'
import { UserMemoryInputMessage } from './UserMemoryInputMessage.js'
import { UserPlanMessage } from './UserPlanMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js'
import {
  COMMAND_MESSAGE_TAG,
  extractTag,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  InterruptedByUser,
  LOCAL_COMMAND_CAVEAT_TAG,
  MessageResponse,
  NO_CONTENT_MESSAGE,
  TICK_TAG,
} from './_helpers.js'

export interface UserTextParam {
  readonly text: string
  readonly type?: 'text'
}

export interface UserTextMessageProps {
  readonly addMargin: boolean
  readonly param: UserTextParam
  readonly verbose: boolean
  readonly planContent?: string
  readonly isTranscriptMode?: boolean
  readonly timestamp?: string
}

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  planContent,
  isTranscriptMode,
  timestamp,
}: UserTextMessageProps): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  if (planContent) {
    return <UserPlanMessage addMargin={addMargin} planContent={planContent} />
  }

  // Suppress synthetic "tick" sentinel injections used to keep the
  // model loop alive — they are not user-visible content.
  if (extractTag(param.text, TICK_TAG)) {
    return null
  }

  // Local-command caveat blocks are runtime telemetry that gets
  // appended after a `!cmd` invocation; they're invisible in the UI.
  if (param.text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) {
    return null
  }

  if (
    param.text.startsWith('<bash-stdout') ||
    param.text.startsWith('<bash-stderr')
  ) {
    return <UserBashOutputMessage content={param.text} verbose={verbose} />
  }

  if (
    param.text.startsWith('<local-command-stdout') ||
    param.text.startsWith('<local-command-stderr')
  ) {
    return <UserLocalCommandOutputMessage content={param.text} />
  }

  if (
    param.text === INTERRUPT_MESSAGE ||
    param.text === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }

  if (param.text.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes('<user-memory-input>')) {
    return (
      <UserMemoryInputMessage addMargin={addMargin} text={param.text} />
    )
  }

  if (
    param.text.includes('<mcp-resource-update') ||
    param.text.includes('<mcp-polling-update')
  ) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />
  }

  // TODO(tranche-5): teammate / agent-notification routing once those
  // renderers and the agent-swarm bridge land in AgenC. For now the
  // generic prompt renderer is used as a reasonable fallback.
  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={param}
      isTranscriptMode={isTranscriptMode}
      timestamp={timestamp}
    />
  )
}
