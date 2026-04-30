/**
 * Renders a plan-mode plan that the user has approved. The plan body
 * is markdown produced by the plan-mode tool; it is shown inside a
 * rounded `accent`-bordered box with a "Plan to implement" header so
 * it stands out from regular user prompts.
 */
import * as React from 'react'

import { Box, Text } from '../../ink-public.js'

import { Markdown } from '../../components/Markdown.js'

export interface UserPlanMessageProps {
  readonly addMargin: boolean
  readonly planContent: string
}

export function UserPlanMessage({
  addMargin,
  planContent,
}: UserPlanMessageProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="accent"
      marginTop={addMargin ? 1 : 0}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color="accent">
          Plan to implement
        </Text>
      </Box>
      <Markdown>{planContent}</Markdown>
    </Box>
  )
}
