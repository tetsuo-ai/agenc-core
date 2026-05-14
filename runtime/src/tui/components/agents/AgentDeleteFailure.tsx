import type { ReactNode } from 'react'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { toError } from '../../../utils/errors.js'
import { Box, Text } from '../../ink.js'

export function formatAgentDeleteFailureMessage(
  agent: Pick<AgentDefinition, 'agentType'>,
  error: unknown,
): string {
  return `Failed to delete agent ${agent.agentType}: ${toError(error).message}`
}

export function AgentDeleteFailureMessage({
  message,
}: {
  message: string
}): ReactNode {
  return (
    <Box marginTop={1}>
      <Text color="error" wrap="wrap">
        {message}
      </Text>
    </Box>
  )
}
