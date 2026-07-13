import { describe, expect, test } from 'bun:test'

import { convertproviderMessagesToResponsesInput } from '../../../src/services/api/openAiCodeTransform.ts'

// C4 (core-todo.md): the Responses-API converter emitted function_call_output for
// EVERY tool_result and function_call for EVERY tool_use with no pairing check —
// unlike the chat-completions path, which drops orphans because an ESC-interrupt
// produces a synthetic tool_result with no recorded tool_use. On the Responses
// transport (store:false, full replay) an orphan persists in history and 400s the
// session on every subsequent request. These tests pin the pairing filter.

type Block = Record<string, unknown>
function user(content: Block[]) {
  return { role: 'user', content }
}
function assistant(content: Block[]) {
  return { role: 'assistant', content }
}
function toolUse(id: string, name = 'Read') {
  return { type: 'tool_use', id, name, input: { path: 'x' } }
}
function toolResult(id: string, text = 'ok') {
  return { type: 'tool_result', tool_use_id: id, content: text }
}

function callIds(items: Array<{ type: string; call_id?: string }>, type: string): string[] {
  return items.filter((i) => i.type === type).map((i) => i.call_id ?? '')
}

describe('convertproviderMessagesToResponsesInput — C4 orphan pairing', () => {
  test('drops an orphan tool_result with no matching tool_use (ESC-interrupt shape)', () => {
    const items = convertproviderMessagesToResponsesInput([
      user([{ type: 'text', text: 'hi' }]),
      assistant([toolUse('call_A')]),
      user([toolResult('call_A')]),
      // Synthetic tool_result from an interrupted turn — no assistant tool_use.
      user([toolResult('call_ORPHAN', 'synthetic ESC result')]),
    ]) as Array<{ type: string; call_id?: string }>

    // The paired call survives...
    expect(callIds(items, 'function_call')).toEqual(['call_A'])
    expect(callIds(items, 'function_call_output')).toEqual(['call_A'])
    // ...and the orphan output is not emitted (would 400 the Responses request).
    expect(callIds(items, 'function_call_output')).not.toContain('call_ORPHAN')
  })

  test('drops a non-trailing orphan tool_use that has no result', () => {
    const items = convertproviderMessagesToResponsesInput([
      assistant([toolUse('call_A')]),
      user([toolResult('call_A')]),
      // Assistant called call_B but the turn was interrupted before a result; a
      // later user message means this is NOT the trailing prefill case.
      assistant([toolUse('call_B')]),
      user([{ type: 'text', text: 'next' }]),
    ]) as Array<{ type: string; call_id?: string }>

    expect(callIds(items, 'function_call')).toEqual(['call_A'])
    expect(callIds(items, 'function_call')).not.toContain('call_B')
  })

  test('keeps a trailing tool_use with no result yet (pending prefill)', () => {
    const items = convertproviderMessagesToResponsesInput([
      user([{ type: 'text', text: 'do it' }]),
      assistant([toolUse('call_C')]),
    ]) as Array<{ type: string; call_id?: string }>

    expect(callIds(items, 'function_call')).toEqual(['call_C'])
  })

  test('a fully paired multi-tool history is unchanged', () => {
    const items = convertproviderMessagesToResponsesInput([
      assistant([toolUse('call_A'), toolUse('call_B')]),
      user([toolResult('call_A'), toolResult('call_B')]),
    ]) as Array<{ type: string; call_id?: string }>

    expect(callIds(items, 'function_call').sort()).toEqual(['call_A', 'call_B'])
    expect(callIds(items, 'function_call_output').sort()).toEqual(['call_A', 'call_B'])
  })
})
