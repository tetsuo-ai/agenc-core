import { APIError } from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import { getAssistantMessageFromError } from '../../../src/services/api/errors.ts'

function getFirstText(message: ReturnType<typeof getAssistantMessageFromError>): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

test('maps endpoint_not_found category markers to actionable setup guidance', () => {
  const error = APIError.generate(
    404,
    undefined,
    'OpenAi API error 404: Not Found [openai_category=endpoint_not_found] Hint: Confirm OPENAI_BASE_URL includes /v1.',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'qwen2.5-coder:7b')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(text).toContain('Provider endpoint was not found')
  expect(text).toContain('OPENAI_BASE_URL')
  expect(text).toContain('/v1')
})

test('maps tool_call_incompatible category markers to model/tool guidance', () => {
  const error = APIError.generate(
    400,
    undefined,
    'OpenAi API error 400: tool_calls are not supported [openai_category=tool_call_incompatible]',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'qwen2.5-coder:7b')
  const text = getFirstText(message)

  expect(text).toContain('rejected tool-calling payloads')
  expect(text).toContain('/model')
})

test('internal invalid-model guidance uses the AgenC CLI name', () => {
  const previousUserType = process.env.USER_TYPE
  const previousAnthropicModel = process.env.ANTHROPIC_MODEL

  try {
    process.env.USER_TYPE = 'ant'
    delete process.env.ANTHROPIC_MODEL

    const message = getAssistantMessageFromError(
      new Error('invalid model name'),
      'internal-opus',
    )
    const text = getFirstText(message)

    expect(text).toContain('Either run `agenc` with `ANTHROPIC_MODEL=')
    expect(text).not.toContain('Either run `claude`')
  } finally {
    if (previousUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = previousUserType
    }
    if (previousAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL
    } else {
      process.env.ANTHROPIC_MODEL = previousAnthropicModel
    }
  }
})
