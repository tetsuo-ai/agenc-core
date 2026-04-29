/**
 * Renders a slash-command invocation in the transcript (e.g.
 * `/doctor` or `/help foo`). The runtime wraps the command name in
 * `<command-message>` and any args in `<command-args>`. A
 * `<skill-format>true</skill-format>` marker switches the display
 * to `Skill(name)` for skill-shaped commands.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'
import { glyphs } from '../../design-system/glyphs.js'

import { COMMAND_MESSAGE_TAG, extractTag } from './_helpers.js'

export interface UserCommandParam {
  readonly text: string
  readonly type?: 'text'
}

export interface UserCommandMessageProps {
  readonly addMargin: boolean
  readonly param: UserCommandParam
}

export function UserCommandMessage({
  addMargin,
  param: { text },
}: UserCommandMessageProps): React.ReactNode {
  const commandMessage = extractTag(text, COMMAND_MESSAGE_TAG)
  const args = extractTag(text, 'command-args')
  const isSkillFormat = extractTag(text, 'skill-format') === 'true'

  if (!commandMessage) return null

  if (isSkillFormat) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0} paddingRight={1}>
        <Text>
          <Text dimColor>{glyphs.pointer} </Text>
          <Text>{`Skill(${commandMessage})`}</Text>
        </Text>
      </Box>
    )
  }

  const parts = [commandMessage, args].filter(
    (value): value is string => Boolean(value),
  )
  const content = `/${parts.join(' ')}`

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} paddingRight={1}>
      <Text>
        <Text dimColor>{glyphs.pointer} </Text>
        <Text>{content}</Text>
      </Text>
    </Box>
  )
}
