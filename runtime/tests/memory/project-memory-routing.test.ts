import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({ feature: () => false }))
vi.mock('../tools.js', () => ({}))
vi.mock('src/tools.js', () => ({}))

import {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
} from '../utils/attachments.js'

describe('project-memory mention routing', () => {
  it('keeps reserved memory mentions out of file and MCP extractors', () => {
    expect(extractAtMentionedFiles('review @memory and @memories:global')).toEqual(
      [],
    )
    expect(extractMcpResourceMentions('review @memory:global')).toEqual([])
  })

  it('continues routing regular file and MCP mentions', () => {
    expect(extractAtMentionedFiles('review @src/context.ts')).toEqual([
      'src/context.ts',
    ])
    expect(extractMcpResourceMentions('review @server:resource/path')).toEqual(
      ['server:resource/path'],
    )
  })
})
