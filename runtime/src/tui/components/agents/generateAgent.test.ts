import { beforeEach, describe, expect, test, vi } from 'vitest'

const queryModelWithoutStreamingMock = vi.hoisted(() => vi.fn())

vi.mock('../../../context.js', () => ({
  getUserContext: async () => ({}),
}))

vi.mock('../../../memory/paths', () => ({
  isAutoMemoryEnabled: () => false,
}))

vi.mock('../../../services/analytics/index', () => ({
  logEvent: vi.fn(),
}))

vi.mock('../../../services/api/anthropic.js', () => ({
  queryModelWithoutStreaming: queryModelWithoutStreamingMock,
}))

vi.mock('../../../utils/api.js', () => ({
  prependUserContext: (messages: unknown[]) => messages,
}))

import {
  AGENT_GENERATION_OUTPUT_FORMAT,
  buildFallbackGeneratedAgent,
  generateAgent,
  parseGeneratedAgentResponse,
} from './generateAgent.js'

function modelResponse(text: string) {
  return {
    message: {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  }
}

beforeEach(() => {
  queryModelWithoutStreamingMock.mockReset()
})

describe('parseGeneratedAgentResponse', () => {
  test('accepts a direct generated-agent JSON object', () => {
    expect(
      parseGeneratedAgentResponse(
        JSON.stringify({
          identifier: 'python-game-reviewer',
          whenToUse: 'Use this agent when reviewing the Python game.',
          systemPrompt: 'You are a focused Python game reviewer.',
        }),
      ),
    ).toEqual({
      identifier: 'python-game-reviewer',
      whenToUse: 'Use this agent when reviewing the Python game.',
      systemPrompt: 'You are a focused Python game reviewer.',
    })
  })

  test('recovers a JSON object wrapped in explanatory model text', () => {
    expect(
      parseGeneratedAgentResponse(`Here is the configuration:
{
  "identifier": "test-runner",
  "whenToUse": "Use this agent when tests should run.",
  "systemPrompt": "You are a precise test runner."
}
Done.`).identifier,
    ).toBe('test-runner')
  })

  test('surfaces non-JSON output as a recoverable wizard error', () => {
    expect(() => parseGeneratedAgentResponse('I can help you with that.')).toThrow(
      'Press Enter to retry',
    )
  })

  test('rejects incomplete generated-agent JSON with the recoverable wizard error', () => {
    expect(() =>
      parseGeneratedAgentResponse('{"identifier":"missing-fields"}'),
    ).toThrow('Press Enter to retry')
  })

  test('declares a strict structured-output schema for generation', () => {
    expect(AGENT_GENERATION_OUTPUT_FORMAT).toMatchObject({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          identifier: expect.objectContaining({
            pattern: '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$',
          }),
        },
        required: ['identifier', 'whenToUse', 'systemPrompt'],
        additionalProperties: false,
      },
    })
  })

  test('uses structured output and repairs an invalid first generation response', async () => {
    queryModelWithoutStreamingMock
      .mockResolvedValueOnce(modelResponse('I can help review that game.'))
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            identifier: 'python-game-reviewer',
            whenToUse: 'Use this agent when reviewing the Python guessing game.',
            systemPrompt: 'You are a focused Python game reviewer.',
          }),
        ),
      )

    await expect(
      generateAgent(
        'A reviewer for the tiny Python number guessing game that suggests small improvements.',
        'grok-4-fast' as never,
        [],
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      identifier: 'python-game-reviewer',
      whenToUse: 'Use this agent when reviewing the Python guessing game.',
      systemPrompt: 'You are a focused Python game reviewer.',
    })

    expect(queryModelWithoutStreamingMock).toHaveBeenCalledTimes(2)
    expect(queryModelWithoutStreamingMock.mock.calls[0]?.[0]?.options).toMatchObject({
      querySource: 'agent_creation',
      outputFormat: AGENT_GENERATION_OUTPUT_FORMAT,
    })
    expect(JSON.stringify(queryModelWithoutStreamingMock.mock.calls[1]?.[0]?.messages)).toContain(
      'Previous response',
    )
  })

  test('falls back to a deterministic valid agent when generation and repair both return prose', async () => {
    queryModelWithoutStreamingMock
      .mockResolvedValueOnce(modelResponse('Reviewer notes for the game.'))
      .mockResolvedValueOnce(modelResponse('Still not JSON.'))

    await expect(
      generateAgent(
        'A reviewer for the tiny Python number guessing game that suggests small improvements.',
        'grok-4-fast' as never,
        [],
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      identifier: 'python-game-number-reviewer',
      whenToUse: expect.stringContaining('Use this agent when'),
      systemPrompt: expect.stringContaining('specialized AgenC agent'),
    })
  })

  test('normalizes and deduplicates a generated identifier before the save step', async () => {
    queryModelWithoutStreamingMock.mockResolvedValueOnce(
      modelResponse(
        JSON.stringify({
          identifier: 'Python Game Reviewer!',
          whenToUse: 'Use this agent when reviewing the Python guessing game.',
          systemPrompt: 'You are a focused Python game reviewer.',
        }),
      ),
    )

    await expect(
      generateAgent(
        'A reviewer for the tiny Python number guessing game that suggests small improvements.',
        'grok-4-fast' as never,
        ['python-game-reviewer'],
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      identifier: 'python-game-reviewer-2',
    })
  })

  test('keeps fallback prompt text aligned with a deduplicated identifier', async () => {
    queryModelWithoutStreamingMock
      .mockResolvedValueOnce(modelResponse('Reviewer notes for the game.'))
      .mockResolvedValueOnce(modelResponse('Still not JSON.'))

    await expect(
      generateAgent(
        'A reviewer for the tiny Python number guessing game that suggests small improvements.',
        'grok-4-fast' as never,
        ['python-game-number-reviewer'],
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      identifier: 'python-game-number-reviewer-2',
      whenToUse: expect.stringContaining('python-game-number-reviewer-2'),
      systemPrompt: expect.stringContaining('python-game-number-reviewer-2'),
    })
  })

  test('derives a usable fallback agent identifier from a normal description', () => {
    expect(
      buildFallbackGeneratedAgent(
        'A reviewer for the tiny Python number guessing game that suggests small improvements.',
      ).identifier,
    ).toBe('python-game-number-reviewer')
  })

  test('formats fallback copy without awkward role phrasing or doubled punctuation', () => {
    const agent = buildFallbackGeneratedAgent(
      'A reviewer for the tiny Python number guessing game that suggests small improvements.',
    )

    expect(agent.whenToUse).toContain(
      'Use this agent when reviewing the tiny Python number guessing game and suggesting small improvements.',
    )
    expect(agent.whenToUse).not.toContain('help with A reviewer')
    expect(agent.whenToUse).not.toContain('..')
    expect(agent.systemPrompt).toContain(
      'specialized AgenC agent for reviewing the tiny Python number guessing game and suggesting small improvements.',
    )
    expect(agent.systemPrompt).not.toContain('..')
  })
})
