import { describe, expect, test } from 'bun:test'

import { determineStopReason } from '../../../src/services/api/openAiCodeTransform.ts'

// M-LLM-6 (core-todo.md): determineStopReason returned 'tool_use' before checking
// incomplete_details.reason === 'max_output_tokens', so a response truncated mid-
// function-call reported 'tool_use' and the runtime executed a tool call built from
// truncated / JSON-repaired arguments. Truncation must win over the tool signal.

const funcCallOutput = [{ type: 'function_call', name: 'Bash', arguments: '{"cmd":"rm -r' }]

describe('determineStopReason — M-LLM-6 truncation beats tool_use', () => {
  test("a function_call truncated by max_output_tokens reports 'max_tokens'", () => {
    const response = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: funcCallOutput,
    }
    expect(determineStopReason(response, false)).toBe('max_tokens')
    // Even when the stream already saw a tool-use signal.
    expect(determineStopReason(response, true)).toBe('max_tokens')
  })

  test("a completed function_call still reports 'tool_use'", () => {
    const response = { status: 'completed', output: funcCallOutput }
    expect(determineStopReason(response, false)).toBe('tool_use')
    expect(determineStopReason(response, true)).toBe('tool_use')
  })

  test("a completed response with no tool reports 'end_turn'", () => {
    expect(determineStopReason({ status: 'completed', output: [] }, false)).toBe('end_turn')
  })

  test("a non-token incomplete (content_filter) with a tool still reports 'tool_use'", () => {
    const response = {
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: funcCallOutput,
    }
    expect(determineStopReason(response, false)).toBe('tool_use')
  })
})
