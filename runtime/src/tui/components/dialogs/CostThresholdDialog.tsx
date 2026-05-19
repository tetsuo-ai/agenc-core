import React from 'react'
import { Box, Link, Text } from '../../ink.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'
import { getAPIProvider } from '../../../utils/model/providers.js'

type Props = {
  onDone: () => void
}

function getProviderLabel(): string {
  const provider = getAPIProvider()
  switch (provider) {
    case 'firstParty':
      // branding-scan: allow real provider display label
      return 'provider API'
    case 'openai':
      // branding-scan: allow real provider display label
      return 'provider-compatible API'
    case 'gemini':
      return 'Gemini API'
    case 'github':
      return 'GitHub Copilot API'
    case 'mistral':
      return 'Mistral API'
    case 'nvidia-nim':
      return 'NVIDIA NIM API'
    case 'minimax':
      return 'MiniMax API'
    case 'agenc':
      return 'AgenC API'
    case 'xai':
      return 'xAI API'
    default:
      return 'API'
  }
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  const providerLabel = getProviderLabel()
  return (
    <Dialog
      title={`You've spent $5 on the ${providerLabel} this session.`}
      onCancel={onDone}
    >
      <Box flexDirection="column">
        <Text>Learn more about how to monitor your spending:</Text>
        <Link url="https://agenc.tech/docs/costs" />
      </Box>
      <Select
        options={[
          {
            value: 'ok',
            label: 'Got it, thanks!',
          },
        ]}
        onChange={onDone}
      />
    </Dialog>
  )
}
