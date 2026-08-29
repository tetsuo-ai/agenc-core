import { describe, expect, test } from 'vitest'
import type { NonNullableUsage } from '../../src/entrypoints/sdk/sdkUtilityTypes.js'
import { accumulateUsage } from '../../src/utils/usage.js'

function usage(overrides: Partial<NonNullableUsage> = {}): NonNullableUsage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: 0,
    speed: null,
    ...overrides,
  }
}

describe('accumulateUsage', () => {
  test('sums counters and keeps the newest scalar values', () => {
    const total = usage({
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 1 },
      server_tool_use: { web_search_requests: 5, web_fetch_requests: 6 },
      cache_creation: {
        ephemeral_1h_input_tokens: 7,
        ephemeral_5m_input_tokens: 8,
      },
      service_tier: 'standard',
      inference_geo: 'us',
      iterations: 1,
      speed: 'standard',
    })
    const next = usage({
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
      output_tokens_details: { thinking_tokens: 9 },
      server_tool_use: { web_search_requests: 50, web_fetch_requests: 60 },
      cache_creation: {
        ephemeral_1h_input_tokens: 70,
        ephemeral_5m_input_tokens: 80,
      },
      service_tier: 'priority',
      inference_geo: 'eu',
      iterations: 3,
      speed: 'fast',
    })

    expect(accumulateUsage(total, next)).toEqual({
      input_tokens: 11,
      cache_creation_input_tokens: 22,
      cache_read_input_tokens: 33,
      cache_deleted_input_tokens: 0,
      output_tokens: 44,
      output_tokens_details: { thinking_tokens: 10 },
      server_tool_use: { web_search_requests: 55, web_fetch_requests: 66 },
      cache_creation: {
        ephemeral_1h_input_tokens: 77,
        ephemeral_5m_input_tokens: 88,
      },
      service_tier: 'priority',
      inference_geo: 'eu',
      iterations: 3,
      speed: 'fast',
    })
  })
})
