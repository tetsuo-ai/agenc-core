import type React from 'react'
import { pathToFileURL } from 'url'

import {
  CHANNEL_TAG,
  COMMAND_MESSAGE_TAG,
} from '../../../constants/xml.js'
import type {
  AgenCTextBlockParam,
  AgenCThinkingBlockParam,
} from '../../../types/message.js'
import type { Theme } from '../../../utils/theme.js'
import { CHANNEL_ARROW, REFRESH_ARROW } from '../../../constants/figures.js'
import Link from '../../ink/components/Link.js'
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js'
import { getStoredImagePath } from '../../../utils/imageStore.js'
import { truncateToWidth } from '../../../utils/format.js'
import { extractTag } from '../../../utils/messages.js'
import { unescapeXml } from '../../../utils/xml.js'
import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { Box } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import ThemedBox from '../design-system/ThemedBox.js'
import ThemedText from '../design-system/ThemedText.js'
import { Markdown } from '../markdown/Markdown.js'
import { Msg } from './primitives.js'

type ThemeColor = keyof Theme

type PlanMessageProps = {
  readonly addMargin: boolean
  readonly planContent: string
}

export function PlanMessage({
  addMargin,
  planContent,
}: PlanMessageProps): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="planMode"
      backgroundColor="planModeWash"
      marginTop={addMargin ? 1 : 0}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <ThemedText color="planMode" bold>
        PLAN TO IMPLEMENT
      </ThemedText>
      <Markdown>{planContent}</Markdown>
    </ThemedBox>
  )
}

type ShellInputMessageProps = {
  readonly addMargin: boolean
  readonly param: AgenCTextBlockParam
}

export function ShellInputMessage({
  addMargin,
  param,
}: ShellInputMessageProps): React.ReactNode {
  const input = extractTag(param.text, 'bash-input')
  if (!input) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="worker" label="shell">
        <ThemedText color="text" wrap="wrap">
          ! {unescapeXml(input)}
        </ThemedText>
      </Msg>
    </Box>
  )
}

type UserCommandMessageProps = {
  readonly addMargin: boolean
  readonly param: AgenCTextBlockParam
}

export function UserCommandMessage({
  addMargin,
  param,
}: UserCommandMessageProps): React.ReactNode {
  const commandMessage = extractTag(param.text, COMMAND_MESSAGE_TAG)
  const args = extractTag(param.text, 'command-args')
  const isSkillFormat = extractTag(param.text, 'skill-format') === 'true'
  if (!commandMessage) return null

  const decodedCommand = unescapeXml(commandMessage)
  const decodedArgs = args === null ? null : unescapeXml(args)
  const content = isSkillFormat
    ? `$${decodedCommand}`
    : `/${[decodedCommand, decodedArgs].filter(Boolean).join(' ')}`
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="user" label={isSkillFormat ? 'skill' : 'command'}>
        <ThemedText color="text" wrap="wrap">
          {content}
        </ThemedText>
      </Msg>
    </Box>
  )
}

type UserAgentNotificationMessageProps = {
  readonly addMargin: boolean
  readonly param: AgenCTextBlockParam
}

function statusColor(status: string | null): ThemeColor {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
    case 'killed':
      return 'error'
    default:
      return 'text2'
  }
}

export function UserAgentNotificationMessage({
  addMargin,
  param,
}: UserAgentNotificationMessageProps): React.ReactNode {
  const summary = unescapeXml(extractTag(param.text, 'summary') ?? '')
  if (!summary) return null

  const color = statusColor(extractTag(param.text, 'status'))
  const statusDot = selectAgenCTuiGlyphs().statusDot
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="worker" label="agent">
        <ThemedText color={color}>
          {statusDot} {summary}
        </ThemedText>
      </Msg>
    </Box>
  )
}

type ParsedResourceUpdate = {
  readonly kind: 'resource' | 'polling'
  readonly server: string
  readonly target: string
  readonly reason?: string
}

function parseResourceUpdates(text: string): ParsedResourceUpdate[] {
  const updates: ParsedResourceUpdate[] = []
  const attr = (attributes: string, name: string): string | undefined =>
    new RegExp(`${name}="([^"]*)"`, 'u').exec(attributes)?.[1]
  const reasonFromBody = (body: string): string | undefined =>
    /<reason>([^<]+)<\/reason>/u.exec(body)?.[1]

  const resourceRegex =
    /<mcp-resource-update\b([^>]*)>([\s\S]*?)<\/mcp-resource-update>/g
  let match: RegExpExecArray | null
  while ((match = resourceRegex.exec(text)) !== null) {
    const server = attr(match[1] ?? '', 'server')
    const target = attr(match[1] ?? '', 'uri')
    if (!server || !target) continue
    updates.push({
      kind: 'resource',
      server,
      target,
      reason: reasonFromBody(match[2] ?? ''),
    })
  }

  const pollingRegex =
    /<mcp-polling-update\b([^>]*)>([\s\S]*?)<\/mcp-polling-update>/g
  while ((match = pollingRegex.exec(text)) !== null) {
    const server = attr(match[1] ?? '', 'server')
    const target = attr(match[1] ?? '', 'tool')
    if (!server || !target) continue
    updates.push({
      kind: 'polling',
      server,
      target,
      reason: reasonFromBody(match[2] ?? ''),
    })
  }
  return updates
}

function formatResourceTarget(target: string): string {
  if (target.startsWith('file://')) {
    const path = target.slice(7)
    return path.split('/').at(-1) || path
  }
  return target.length > 40 ? `${target.slice(0, 39)}…` : target
}

type UserResourceUpdateMessageProps = {
  readonly addMargin: boolean
  readonly param: AgenCTextBlockParam
}

export function UserResourceUpdateMessage({
  addMargin,
  param,
}: UserResourceUpdateMessageProps): React.ReactNode {
  const updates = parseResourceUpdates(param.text)
  if (updates.length === 0) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} gap={1}>
      {updates.map((update, index) => (
        <Msg key={index} role="system" label="mcp">
          <Box flexDirection="row">
            <ThemedText color="success">{REFRESH_ARROW}</ThemedText>
            <ThemedText color="subtle"> {update.server}: </ThemedText>
            <ThemedText color="agenc">
              {update.kind === 'resource'
                ? formatResourceTarget(update.target)
                : update.target}
            </ThemedText>
            {update.reason ? (
              <ThemedText color="subtle"> · {update.reason}</ThemedText>
            ) : null}
          </Box>
        </Msg>
      ))}
    </Box>
  )
}

type UserImageMessageProps = {
  readonly imageId?: number
  readonly addMargin?: boolean
}

export function UserImageMessage({
  imageId,
  addMargin = false,
}: UserImageMessageProps): React.ReactNode {
  const label = imageId ? `[ image · #${imageId} ]` : '[ image ]'
  const imagePath = imageId ? getStoredImagePath(imageId) : null
  const content =
    imagePath && supportsHyperlinks() ? (
      <Link url={pathToFileURL(imagePath).href}>
        <ThemedText color="text2">{label}</ThemedText>
      </Link>
    ) : (
      <ThemedText color="text2">{label}</ThemedText>
    )

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="user" label="image">
        {content}
      </Msg>
    </Box>
  )
}

type UserMemoryInputMessageProps = {
  readonly addMargin: boolean
  readonly text: string
}

export function UserMemoryInputMessage({
  addMargin,
  text,
}: UserMemoryInputMessageProps): React.ReactNode {
  const input = extractTag(text, 'user-memory-input')
  if (!input) return null

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="system" label="memory">
        <ThemedText color="text" backgroundColor="memoryBackgroundColor">
          # {input}
        </ThemedText>
      </Msg>
      <Box paddingLeft={2}>
        <ThemedText color="subtle">Noted.</ThemedText>
      </Box>
    </Box>
  )
}

type UserChannelMessageProps = {
  readonly addMargin: boolean
  readonly param: AgenCTextBlockParam
}

const CHANNEL_RE = new RegExp(
  `<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`,
)
const USER_ATTR_RE = /\buser="([^"]+)"/
const CHANNEL_TRUNCATE_AT = 60

function displayChannelServerName(name: string): string {
  const index = name.lastIndexOf(':')
  return index === -1 ? name : name.slice(index + 1)
}

export function UserChannelMessage({
  addMargin,
  param,
}: UserChannelMessageProps): React.ReactNode {
  const match = CHANNEL_RE.exec(param.text)
  if (!match) return null

  const [, source = '', attrs = '', content = ''] = match
  const user = USER_ATTR_RE.exec(attrs)?.[1]
  const body = content.trim().replace(/\s+/g, ' ')
  const server = displayChannelServerName(source)
  const label = user ? `${server} · ${user}` : server

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Msg role="worker" label="channel">
        <Box flexDirection="row">
          <ThemedText color="agenc">{CHANNEL_ARROW}</ThemedText>
          <ThemedText color="subtle"> {label}: </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {truncateToWidth(body, CHANNEL_TRUNCATE_AT)}
          </ThemedText>
        </Box>
      </Msg>
    </Box>
  )
}

type ThinkingMessageProps = {
  readonly param: AgenCThinkingBlockParam
  readonly addMargin: boolean
  readonly isTranscriptMode: boolean
  readonly verbose: boolean
  readonly hideInTranscript?: boolean
}

function thinkingLabel(prefix: string): string {
  return prefix.length > 0 ? `${prefix} Thinking` : 'Thinking'
}

export function ThinkingMessage({
  param,
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
}: ThinkingMessageProps): React.ReactNode {
  const { thinking } = param
  if (!thinking || hideInTranscript) return null

  const glyphs = selectAgenCTuiGlyphs()
  const shouldShowFullThinking = isTranscriptMode || verbose
  if (!shouldShowFullThinking) {
    // Collapsed streaming hint: the activity spinner below already says
    // "thinking", so the row is just the expand affordance — no "Thinking"
    // word, no glyph (UX request).
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <ThemedText color="subtle" italic>
          <CtrlOToExpand />
        </ThemedText>
      </Box>
    )
  }

  const label = thinkingLabel(glyphs.thinkingPrefix)

  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      <ThemedText color="subtle" italic>
        {label}
        {glyphs.thinkingEllipsis}
      </ThemedText>
      <Box paddingLeft={2}>
        <Markdown dimColor>{thinking}</Markdown>
      </Box>
    </Box>
  )
}

type RedactedThinkingMessageProps = {
  readonly addMargin: boolean
}

export function RedactedThinkingMessage({
  addMargin = false,
}: RedactedThinkingMessageProps): React.ReactNode {
  const glyphs = selectAgenCTuiGlyphs()
  const prefix =
    glyphs.redactedThinkingPrefix.length > 0
      ? `${glyphs.redactedThinkingPrefix} `
      : ''
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <ThemedText color="subtle" italic>
        {prefix}Thinking{glyphs.thinkingEllipsis}
      </ThemedText>
    </Box>
  )
}

export function RejectedToolUseMessage(): React.ReactNode {
  return (
    <Msg role="system" label="permission">
      <ThemedText color="subtle">Tool use rejected</ThemedText>
    </Msg>
  )
}

export function UserToolCanceledMessage(): React.ReactNode {
  return (
    <Msg role="system" label="interrupt">
      <ThemedText color="subtle">Interrupted by user</ThemedText>
    </Msg>
  )
}

export function RejectedPlanMessage({
  plan,
}: {
  readonly plan: string
}): React.ReactNode {
  return (
    <Msg role="system" label="plan rejected">
      <Box flexDirection="column" gap={1}>
        <ThemedText color="subtle">User rejected AgenC&apos;s plan:</ThemedText>
        <PlanMessage addMargin={false} planContent={plan} />
      </Box>
    </Msg>
  )
}
