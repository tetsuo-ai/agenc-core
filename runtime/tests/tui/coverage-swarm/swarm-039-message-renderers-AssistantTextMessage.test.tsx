import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

vi.mock('../../utils/model/contextWindowUpgradeCheck.js', () => ({
  getUpgradeMessage: () => 'switch to a larger context model',
}))

vi.mock('../../utils/secureStorage/macOsKeychainStorage.js', () => ({
  isMacOsKeychainLocked: () => true,
}))

import { ERROR_MESSAGE_USER_ABORT } from '../../services/compact/compact.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from '../../services/api/errors.js'
import { createRoot } from '../ink/root.js'
import { AssistantTextMessage } from '../message-renderers/AssistantTextMessage.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type RenderOptions = {
  readonly addMargin?: boolean
  readonly onOpenRateLimitOptions?: () => void
  readonly verbose?: boolean
}

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number; rows: number }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number }).rows = 30

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeOutput(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function renderAssistantText(text: string, options: RenderOptions = {}): React.ReactNode {
  return (
    <AssistantTextMessage
      addMargin={options.addMargin ?? false}
      onOpenRateLimitOptions={options.onOpenRateLimitOptions}
      param={{ type: 'text', text }}
      shouldShowDot={false}
      verbose={options.verbose ?? false}
    />
  )
}

async function renderSequence(
  steps: ReadonlyArray<{
    readonly text: string
    readonly options?: RenderOptions
  }>,
): Promise<string> {
  const { stdin, stdout } = createStreams()
  let output = ''

  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    for (const step of steps) {
      root.render(renderAssistantText(step.text, step.options))
      await sleep()
    }
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }

  return stripAnsi(output)
}

describe('AssistantTextMessage swarm 039 coverage', () => {
  test('rerenders memoized built-in messages with their action text intact', async () => {
    const output = await renderSequence([
      { text: PROMPT_TOO_LONG_ERROR_MESSAGE },
      { text: PROMPT_TOO_LONG_ERROR_MESSAGE },
      { text: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE },
      { text: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE },
      { text: INVALID_API_KEY_ERROR_MESSAGE },
      { text: INVALID_API_KEY_ERROR_MESSAGE },
      { text: INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL },
      { text: INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL },
      { text: ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH },
      { text: ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH },
      { text: TOKEN_REVOKED_ERROR_MESSAGE },
      { text: TOKEN_REVOKED_ERROR_MESSAGE },
      { text: CUSTOM_OFF_SWITCH_MESSAGE },
      { text: CUSTOM_OFF_SWITCH_MESSAGE },
      { text: ERROR_MESSAGE_USER_ABORT },
      { text: ERROR_MESSAGE_USER_ABORT },
    ])

    expect(output).toContain('switch to a larger context model')
    expect(output).toContain('Credit balance too low')
    expect(output).toContain('security unlock-keychain')
    expect(output).toContain(INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL)
    expect(normalizeOutput(output)).toContain(
      normalizeOutput(ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH),
    )
    expect(output).toContain(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(output).toContain('use /model')
    expect(output).toContain('Interrupted')
  })

  test('rerenders rate-limit and API-prefixed messages through cached branches', async () => {
    const onOpenRateLimitOptions = vi.fn()
    const longApiError = `${API_ERROR_MESSAGE_PREFIX}: ${'x'.repeat(1200)}`
    const output = await renderSequence([
      {
        text: "You've hit your session limit",
        options: { onOpenRateLimitOptions },
      },
      {
        text: "You've hit your session limit",
        options: { onOpenRateLimitOptions },
      },
      {
        text: "You've used 90% of your weekly limit",
        options: { onOpenRateLimitOptions },
      },
      {
        text: "You've used 90% of your weekly limit",
        options: { onOpenRateLimitOptions },
      },
      { text: API_ERROR_MESSAGE_PREFIX },
      { text: API_ERROR_MESSAGE_PREFIX },
      { text: `${API_ERROR_MESSAGE_PREFIX}: short failure` },
      { text: `${API_ERROR_MESSAGE_PREFIX}: short failure` },
      { text: longApiError },
      { text: longApiError },
    ])

    expect(output).toContain("You've hit your session limit")
    expect(output).toContain("You've used 90% of your weekly limit")
    expect(output).toContain('Please wait a moment and try again.')
    expect(output).toContain('short failure')
    expect(output).toContain('ctrl+o')
  })

  test('rerenders ordinary assistant text without margin or selected background', async () => {
    const output = await renderSequence([
      { text: '**Ready** to proceed' },
      { text: '**Ready** to proceed' },
    ])

    expect(output).toContain('AGENC')
    expect(output).toContain('Ready to proceed')
  })
})
