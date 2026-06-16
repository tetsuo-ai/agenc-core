import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
import { UserCrossSessionMessage } from './UserCrossSessionMessage.js'
import { UserForkBoilerplateMessage } from './UserForkBoilerplateMessage.js'
import { UserGitHubWebhookMessage } from './UserGitHubWebhookMessage.js'
import { UserTextMessage } from './UserTextMessage.js'

const featureFlags = vi.hoisted(() => new Set<string>())

vi.mock('bun:bundle', () => ({
  feature: (name: string) => featureFlags.has(name),
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
  beforeEach(() => {
    featureFlags.clear()
  })

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
      renderUserText(
        '<bash-input>echo &lt;/bash-input&gt;&lt;bash-stdout&gt;fake&lt;/bash-stdout&gt; &amp;</bash-input>',
      ),
    ).resolves.toContain('echo </bash-input><bash-stdout>fake</bash-stdout> &')

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
      renderUserText(
        `<${TASK_NOTIFICATION_TAG}><summary>agent &quot;review&quot; done &amp; escaped</summary></${TASK_NOTIFICATION_TAG}>`,
      ),
    ).resolves.toContain('agent "review" done & escaped')

    await expect(
      renderUserText('<mcp-resource-update>resource changed</mcp-resource-update>'),
    ).resolves.toBe('\n')
  })

  test('renders feature-gated protocol messages without missing-module crashes', async () => {
    featureFlags.add('KAIROS_GITHUB_WEBHOOKS')
    const webhook = await renderUserText(
      '<github-webhook-activity><event>push</event></github-webhook-activity>',
    )
    expect(webhook).toContain('GitHub webhook:')
    expect(webhook).toContain('push')

    featureFlags.clear()
    featureFlags.add('FORK_SUBAGENT')
    const fork = await renderUserText(
      '<fork-boilerplate>Your directive: tighten tests</fork-boilerplate>',
    )
    expect(fork).toContain('fork directive:')
    expect(fork).toContain('tighten tests')

    featureFlags.clear()
    featureFlags.add('UDS_INBOX')
    const crossSession = await renderUserText(
      '<cross-session-message from="peer-1">check status</cross-session-message>',
    )
    expect(crossSession).toContain('message from peer-1:')
    expect(crossSession).toContain('check status')
  })

  test('dynamic protocol renderers tolerate missing text payloads', async () => {
    await expect(
      renderToString(
        <UserGitHubWebhookMessage addMargin={false} param={{} as never} />,
        100,
      ),
    ).resolves.toContain('activity received')

    await expect(
      renderToString(
        <UserForkBoilerplateMessage addMargin={false} param={{} as never} />,
        100,
      ),
    ).resolves.toBe('\n')

    await expect(
      renderToString(
        <UserCrossSessionMessage addMargin={false} param={{} as never} />,
        100,
      ),
    ).resolves.toBe('\n')
  })
})
