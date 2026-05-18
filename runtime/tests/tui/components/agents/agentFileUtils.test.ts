import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { runWithCwdOverride } from '../../../utils/cwd.js'
import { saveAgentToFile } from './agentFileUtils.js'

describe('agent file creation', () => {
  test('writes generated project agents to .agenc/agents', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agenc-generated-agent-'))
    try {
      await runWithCwdOverride(cwd, async () => {
        await saveAgentToFile(
          'projectSettings',
          'python-game-reviewer',
          'Use this agent when reviewing the Python guessing game.',
          undefined,
          'You are a focused Python game reviewer.',
        )
      })

      const filePath = join(cwd, '.agenc', 'agents', 'python-game-reviewer.md')
      expect(readFileSync(filePath, 'utf8')).toContain(
        'name: python-game-reviewer',
      )
      expect(readFileSync(filePath, 'utf8')).toContain(
        'You are a focused Python game reviewer.',
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
