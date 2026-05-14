import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const ACTIVE_AGENT_CREATION_FILES = [
  'src/tui/components/agents/new-agent-creation/wizard-steps/GenerateStep.tsx',
  'src/tui/components/agents/generateAgent.ts',
  'src/tui/components/agents/new-agent-creation/wizard-steps/ConfirmStepWrapper.tsx',
]

describe('agent creation branding cleanup', () => {
  test('active agent creation paths do not use donor abort or analytics tokens', async () => {
    const contents = await Promise.all(
      ACTIVE_AGENT_CREATION_FILES.map(path => readFile(path, 'utf8')),
    )

    for (const content of contents) {
      expect(content).not.toContain('APIUserAbortError')
      expect(content).not.toContain('tengu_agent_')
    }
  })
})
