/**
 * Renders the `! cmd` shorthand: when the user prefixes their composer
 * input with `!`, the runtime tags the line with `<bash-input>` so the
 * transcript shows it as an explicit bash invocation rather than an LLM
 * prompt.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { extractTag } from './_helpers.js'

export interface UserBashInputParam {
  readonly text: string
  readonly type?: 'text'
}

export interface UserBashInputMessageProps {
  readonly addMargin: boolean
  readonly param: UserBashInputParam
}

export function UserBashInputMessage({
  addMargin,
  param: { text },
}: UserBashInputMessageProps): React.ReactNode {
  const input = extractTag(text, 'bash-input')
  if (!input) return null

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} paddingRight={1}>
      <Text color="warning">{'! '}</Text>
      <Text>{input}</Text>
    </Box>
  )
}
