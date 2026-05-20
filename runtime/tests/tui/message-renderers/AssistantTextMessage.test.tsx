import React from 'react'
import { describe, expect, it } from 'vitest'

import { ERROR_MESSAGE_USER_ABORT } from 'src/services/compact/compact.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from '../../services/api/errors.js'
import { NO_RESPONSE_REQUESTED } from '../../utils/messages.js'
import { renderToString } from '../../utils/staticRender.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'

function renderAssistantText(text: string, verbose = false): Promise<string> {
  return renderToString(
    <AssistantTextMessage
      param={{
        type: 'text',
        text,
      }}
      addMargin={false}
      shouldShowDot={false}
      verbose={verbose}
    />,
    100,
  )
}

function normalizeOutput(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

describe('AssistantTextMessage', () => {
  it('renders classified rate-limit messages instead of dropping them', async () => {
    const output = await renderAssistantText("You've hit your session limit")

    expect(output).toContain("You've hit your session limit")
  })

  it('drops empty and no-response placeholders', async () => {
    expect((await renderAssistantText('')).trim()).toBe('')
    expect((await renderAssistantText(NO_RESPONSE_REQUESTED)).trim()).toBe('')
  })

  it('renders built-in assistant error messages with actionable text', async () => {
    await expect(renderAssistantText(PROMPT_TOO_LONG_ERROR_MESSAGE)).resolves.toContain(
      'Context limit reached',
    )
    await expect(renderAssistantText(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)).resolves.toContain(
      'Credit balance too low',
    )
    await expect(renderAssistantText(INVALID_API_KEY_ERROR_MESSAGE)).resolves.toContain(
      INVALID_API_KEY_ERROR_MESSAGE,
    )
    await expect(
      renderAssistantText(INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL),
    ).resolves.toContain(INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL)
    expect(normalizeOutput(await renderAssistantText(ORG_DISABLED_ERROR_MESSAGE_ENV_KEY))).toContain(
      normalizeOutput(ORG_DISABLED_ERROR_MESSAGE_ENV_KEY),
    )
    await expect(renderAssistantText(TOKEN_REVOKED_ERROR_MESSAGE)).resolves.toContain(
      TOKEN_REVOKED_ERROR_MESSAGE,
    )
    await expect(renderAssistantText(API_TIMEOUT_ERROR_MESSAGE)).resolves.toContain(
      API_TIMEOUT_ERROR_MESSAGE,
    )
    await expect(renderAssistantText(CUSTOM_OFF_SWITCH_MESSAGE)).resolves.toContain(
      'high demand',
    )
    await expect(renderAssistantText(ERROR_MESSAGE_USER_ABORT)).resolves.toContain(
      'Interrupted',
    )
  })

  it('truncates long API-prefixed errors unless verbose output is enabled', async () => {
    const longError = `${API_ERROR_MESSAGE_PREFIX}: ${'x'.repeat(1200)}`

    const compact = await renderAssistantText(longError)
    expect(compact.length).toBeLessThan(longError.length)
    expect(compact).toContain('ctrl+o')

    const verbose = await renderAssistantText(longError, true)
    expect((verbose.match(/x/g) ?? []).length).toBeGreaterThan(1100)

    await expect(renderAssistantText(API_ERROR_MESSAGE_PREFIX)).resolves.toContain(
      'Please wait a moment and try again.',
    )
  })
})
