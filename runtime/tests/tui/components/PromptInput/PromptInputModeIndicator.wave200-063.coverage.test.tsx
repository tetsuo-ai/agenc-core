import React from 'react'
import { describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  swarmsEnabled: false,
  teammateColor: undefined as string | undefined,
  getTeammateColor: vi.fn((): string | undefined => harness.teammateColor),
  reset() {
    harness.swarmsEnabled = false
    harness.teammateColor = undefined
    harness.getTeammateColor.mockClear()
  },
}))

vi.mock('../../../utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: () => harness.swarmsEnabled,
}))

vi.mock('../../../utils/teammate.js', () => ({
  getTeammateColor: harness.getTeammateColor,
}))

import { renderToString } from '../../../utils/staticRender.js'
import { Box } from '../../ink.js'
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js'

async function renderIndicator(
  props: React.ComponentProps<typeof PromptInputModeIndicator>,
): Promise<string> {
  return renderToString(<PromptInputModeIndicator {...props} />, 20)
}

describe('PromptInputModeIndicator coverage', () => {
  test('renders prompt glyphs across shell, bypass, viewed-agent, and swarm color states', async () => {
    harness.reset()

    expect(
      await renderIndicator({
        mode: 'prompt',
        isLoading: false,
      }),
    ).toContain('❯')

    harness.swarmsEnabled = true
    harness.teammateColor = undefined
    expect(
      await renderIndicator({
        mode: 'prompt',
        permissionMode: 'plan',
        isLoading: false,
      }),
    ).toContain('❯')

    harness.teammateColor = 'not-a-theme-color'
    expect(
      await renderIndicator({
        mode: 'prompt',
        permissionMode: 'default',
        isLoading: false,
      }),
    ).toContain('❯')

    harness.teammateColor = 'red'
    const output = await renderToString(
      <Box flexDirection="column">
        <PromptInputModeIndicator mode="bash" isLoading={true} />
        <PromptInputModeIndicator
          mode="prompt"
          permissionMode="bypassPermissions"
          isLoading={false}
        />
        <PromptInputModeIndicator
          mode="prompt"
          permissionMode="plan"
          isLoading={false}
          viewingAgentName="worker"
          viewingAgentColor="cyan"
        />
        <PromptInputModeIndicator
          mode="orphaned-permission"
          permissionMode="acceptEdits"
          isLoading={false}
        />
      </Box>,
      20,
    )

    expect(output).toContain('!')
    expect(output).toContain('▶')
    expect(output.match(/❯/g)).toHaveLength(2)
    expect(harness.getTeammateColor).toHaveBeenCalled()
  })
})
