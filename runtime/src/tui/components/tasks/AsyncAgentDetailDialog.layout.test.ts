import { describe, expect, test } from 'vitest'

import {
  getAsyncAgentDetailContentColumns,
  getAsyncAgentPromptPreview,
} from './AsyncAgentDetailDialog.layout.js'

describe('AsyncAgentDetailDialog layout helpers', () => {
  test('derives usable content width from terminal columns', () => {
    expect(getAsyncAgentDetailContentColumns(120)).toBe(116)
    expect(getAsyncAgentDetailContentColumns(20)).toBe(16)
    expect(getAsyncAgentDetailContentColumns(4)).toBe(1)
    expect(getAsyncAgentDetailContentColumns(0)).toBe(1)
  })

  test('bounds prompt previews by terminal width', () => {
    const prompt = 'x'.repeat(500)

    expect(getAsyncAgentPromptPreview(prompt, 100)).toHaveLength(300)
    expect(getAsyncAgentPromptPreview(prompt, 20)).toHaveLength(64)
    expect(getAsyncAgentPromptPreview(prompt, 4)).toBe('xxx…')
    expect(getAsyncAgentPromptPreview('short', 6)).toBe('short')
  })
})
