import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_MESSAGE_TAG,
  TASK_NOTIFICATION_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
import { renderToString } from '../../utils/staticRender.js'
import { UserTextMessage } from './UserTextMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))
vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

function renderUserText(
  text: string,
  options: {
    addMargin?: boolean
    verbose?: boolean
    planContent?: string
    isTranscriptMode?: boolean
    timestamp?: string
  } = {},
): Promise<string> {
  return renderToString(
    <UserTextMessage
      addMargin={options.addMargin ?? false}
      param={{ type: 'text', text }}
      verbose={options.verbose ?? false}
      planContent={options.planContent}
      isTranscriptMode={options.isTranscriptMode}
      timestamp={options.timestamp}
    />,
    100,
  )
}

describe('UserTextMessage rendering', () => {
  test('renders ordinary prompt text and plan content', async () => {
    await expect(renderUserText('write tests for the TUI')).resolves.toContain(
      'write tests for the TUI',
    )

    await expect(
      renderUserText('ignored prompt text', {
        planContent: '1. inspect\n2. test',
      }),
    ).resolves.toContain('inspect')
  })

  test('hides no-content, tick, and local-command caveat messages', async () => {
    await expect(renderUserText(NO_CONTENT_MESSAGE)).resolves.not.toContain(
      NO_CONTENT_MESSAGE,
    )
    await expect(
      renderUserText(`<${TICK_TAG}>heartbeat</${TICK_TAG}>`),
    ).resolves.not.toContain('heartbeat')
    await expect(
      renderUserText(
        '<local-command-caveat>hidden caveat</local-command-caveat>',
      ),
    ).resolves.not.toContain('hidden caveat')
  })

  test('renders interruption messages', async () => {
    await expect(renderUserText(INTERRUPT_MESSAGE)).resolves.toContain(
      'Interrupted',
    )
    await expect(renderUserText(INTERRUPT_MESSAGE_FOR_TOOL_USE)).resolves.toContain(
      'Interrupted',
    )
  })

  test('routes command, bash, local-command, memory, task, and resource messages', async () => {
    await expect(
      renderUserText('<bash-input>npm test</bash-input>'),
    ).resolves.toContain('npm test')

    await expect(
      renderUserText('<bash-stdout>test output</bash-stdout>', { verbose: true }),
    ).resolves.toContain('test output')

    await expect(
      renderUserText(
        '<local-command-stdout>local output</local-command-stdout>',
      ),
    ).resolves.toContain('local output')

    await expect(
      renderUserText(
        `<${COMMAND_MESSAGE_TAG}>/model opus</${COMMAND_MESSAGE_TAG}>`,
      ),
    ).resolves.toContain('/model opus')

    await expect(
      renderUserText('<user-memory-input>remember coverage</user-memory-input>'),
    ).resolves.toContain('remember coverage')

    await expect(
      renderUserText(
        `<${TASK_NOTIFICATION_TAG}><summary>agent done</summary></${TASK_NOTIFICATION_TAG}>`,
      ),
    ).resolves.toContain('agent done')

    await expect(
      renderUserText('<mcp-resource-update>resource changed</mcp-resource-update>'),
    ).resolves.toBe('\n')
  })
})
