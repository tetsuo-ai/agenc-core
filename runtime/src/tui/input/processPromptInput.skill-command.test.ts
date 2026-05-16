import { describe, expect, test } from 'vitest'

import { parseDollarSkillCommand } from './processPromptInput.js'

describe('parseDollarSkillCommand', () => {
  test('parses dollar-prefixed skill input with args', () => {
    expect(parseDollarSkillCommand('$python-game make game.py')).toEqual({
      commandName: 'python-game',
      args: 'make game.py',
    })
  })

  test('supports namespaced skill names', () => {
    expect(parseDollarSkillCommand('$frontend:react:form')).toEqual({
      commandName: 'frontend:react:form',
      args: '',
    })
  })

  test('supports MCP-style names with uppercase server segments', () => {
    expect(parseDollarSkillCommand('$mcp__Docs_Server__reviewer review')).toEqual({
      commandName: 'mcp__Docs_Server__reviewer',
      args: 'review',
    })
  })

  test('does not treat slash commands or mentions as skills', () => {
    expect(parseDollarSkillCommand('/help')).toBeNull()
    expect(parseDollarSkillCommand('@game.py')).toBeNull()
  })
})
